import fse from 'fs-extra';

import { thumbnailFormat, thumbnailMaxSize } from 'common/config';
import { IThumbnailMessage, IThumbnailMessageResponse } from '../image/ThumbnailGeneration';

// TODO: Merge this with the generateThumbnail func from frontend/image/utils.ts, it's duplicate code
const generateThumbnailData = async (
  filePath: string,
  imageBitmap?: ImageBitmap,
): Promise<ArrayBuffer> => {
  let img: ImageBitmap | undefined;
  try {
    if (imageBitmap !== undefined) {
      img = imageBitmap;
    } else {
      const inputBuffer = await fse.readFile(filePath);
      img = await createImageBitmap(new Blob([inputBuffer]));
    }

    // Scale the image so that either width or height becomes `thumbnailMaxSize`
    let width = img.width;
    let height = img.height;
    const isLowRes = !(width > thumbnailMaxSize || height > thumbnailMaxSize);
    if (!isLowRes) {
      if (img.width >= img.height) {
        width = thumbnailMaxSize;
        height = (thumbnailMaxSize * img.height) / img.width;
      } else {
        height = thumbnailMaxSize;
        width = (thumbnailMaxSize * img.width) / img.height;
      }
    }

    const canvas = new OffscreenCanvas(width, height);
    const ctx2D = canvas.getContext('2d');
    if (!ctx2D) {
      throw new Error('No canvas context 2D (should never happen)');
    }

    // Todo: Take into account rotation. Can be found with https://www.npmjs.com/package/node-exiftool

    ctx2D.imageSmoothingEnabled = !isLowRes;
    ctx2D.imageSmoothingQuality = !isLowRes ? 'high' : 'low';
    ctx2D.drawImage(img, 0, 0, width, height);

    const thumbBlob = await canvas.convertToBlob({
      type: `image/${thumbnailFormat}`,
      quality: isLowRes ? 1 : 0.75,
    });
    return await thumbBlob.arrayBuffer();
  } finally {
    // Free the decoded pixels right away instead of waiting for garbage collection
    img?.close();
  }
};

// The worker context
const ctx: Worker = self as any;

// The pool in ThumbnailGeneration.tsx sends a worker one job at a time, so no queue is needed here.
// Any existing thumbnail is overwritten: the main thread only asks for one when it is missing or outdated.
ctx.addEventListener('message', async (event: MessageEvent<IThumbnailMessage>) => {
  const { jobId, filePath, thumbnailFilePath, imageBitmap } = event.data;
  let response: IThumbnailMessageResponse;
  try {
    const thumbnailData = await generateThumbnailData(filePath, imageBitmap);
    await fse.outputFile(thumbnailFilePath, Buffer.from(thumbnailData));
    response = { jobId, success: true };
  } catch (err) {
    console.error('Could not generate image thumbnail', filePath, err);
    response = { jobId, success: false, error: String(err) };
  }
  ctx.postMessage(response);
});
