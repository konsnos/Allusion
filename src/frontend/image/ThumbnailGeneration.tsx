import fse from 'fs-extra';
import path from 'path';

import { clamp } from 'common/core';
import { thumbnailFormat } from 'common/config';
import { ClientFile } from '../entities/File';
import { encodeFilePath, isFileExtensionVideo } from 'common/fs';
import { TaskQueue } from './TaskQueue';

export interface IThumbnailMessage {
  jobId: number;
  filePath: string;
  thumbnailFilePath: string;
  thumbnailFormat: string;
  imageBitmap?: ImageBitmap;
}

export interface IThumbnailMessageResponse {
  jobId: number;
  success: boolean;
  error?: string;
}

// TODO: Look into NativeImage operators: https://www.electronjs.org/docs/api/native-image#imageresizeoptions

/**
 * Each worker generates one thumbnail at a time: decoding happens on the worker's own thread,
 * so several jobs per worker do not run in parallel. Measured on a 16-thread machine, 8
 * single-job workers generated thumbnails ~40% faster than the previous 4 workers x 4 jobs.
 * Capped at 8 because every job holds a fully decoded image (~100 MB for 25 megapixels).
 */
const NUM_THUMBNAIL_WORKERS = clamp(Math.floor((navigator.hardwareConcurrency || 4) / 2), 2, 8);

/** A worker that has not answered after this long is considered hung and gets replaced */
const JOB_TIMEOUT = 60_000;
/** Getting a frame out of a video happens on the main thread, which can stall on broken files */
const VIDEO_FRAME_TIMEOUT = 15_000;

class ThumbnailWorker {
  private worker: Worker;
  private job?: {
    id: number;
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };

  constructor() {
    this.worker = this.spawn();
  }

  run(msg: IThumbnailMessage, transfer: Transferable[] = []): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.worker.terminate();
        this.worker = this.spawn();
        this.settle(new Error(`Thumbnail generation timed out for ${msg.filePath}`));
      }, JOB_TIMEOUT);
      this.job = { id: msg.jobId, resolve, reject, timer };
      this.worker.postMessage(msg, transfer);
    });
  }

  private spawn(): Worker {
    const worker = new Worker(
      new URL('src/frontend/workers/thumbnailGenerator.worker', import.meta.url),
    );
    worker.onmessage = ({ data }: MessageEvent<IThumbnailMessageResponse>) => {
      if (data.jobId === this.job?.id) {
        this.settle(data.success ? undefined : new Error(data.error));
      }
    };
    worker.onerror = (e) => {
      console.error('Thumbnail worker error', e);
      this.settle(new Error(e.message || 'Thumbnail worker error'));
    };
    return worker;
  }

  private settle(err?: Error) {
    const job = this.job;
    if (job === undefined) {
      return;
    }
    this.job = undefined;
    clearTimeout(job.timer);
    err === undefined ? job.resolve() : job.reject(err);
  }
}

// Workers are created when first needed. The queue never runs more jobs than there are workers,
// so a running job always finds an idle one.
const idleWorkers: ThumbnailWorker[] = [];
const queue = new TaskQueue<void>(NUM_THUMBNAIL_WORKERS);
let nextJobId = 0;

/**
 * Generates a thumbnail in a Worker: {@link ../workers/thumbnailGenerator.worker}
 *
 * Requests run in the order they arrive, and a request for a thumbnail that is already queued or
 * being generated joins that one. Aborting `signal` (e.g. when the image scrolls out of view)
 * takes the request out of the queue if it has not started yet.
 *
 * @throws When the thumbnail could not be generated, or with an AbortError when aborted
 **/
export function generateThumbnailUsingWorker(
  file: ClientFile,
  thumbnailFilePath: string,
  signal?: AbortSignal,
): Promise<void> {
  const { absolutePath, extension } = file;
  return queue.run(
    thumbnailFilePath,
    async () => {
      const worker = idleWorkers.pop() ?? new ThumbnailWorker();
      try {
        const msg: IThumbnailMessage = {
          jobId: nextJobId++,
          filePath: absolutePath,
          thumbnailFilePath,
          thumbnailFormat,
        };
        if (isFileExtensionVideo(extension)) {
          // get a frame bitmap using a <video> element and let it handle the video and the decoding.
          // we do this in the main thread and send the ImageBitmap to the worker since workers cannot create DOM elements
          // Todo: it would be more perfomant to do the whole decoding in the worker but that will need a more complex implementation.
          const bitmap = await withTimeout(
            generateVideoThumbnailBitmap(absolutePath),
            VIDEO_FRAME_TIMEOUT,
            `Timed out reading a frame of ${absolutePath}`,
          );
          msg.imageBitmap = bitmap;
          await worker.run(msg, [bitmap]);
        } else {
          await worker.run(msg);
        }
      } finally {
        idleWorkers.push(worker);
      }
    },
    signal,
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Moves all thumbnail files from one directory to another
export const moveThumbnailDir = async (sourceDir: string, targetDir: string) => {
  if (!(await fse.pathExists(sourceDir)) || !(await fse.pathExists(targetDir))) {
    console.log('Source or target directory does not exist for moving thumbnails');
    return;
  }

  console.log('Moving thumbnails from ', sourceDir, ' to ', targetDir);

  const files = await fse.readdir(sourceDir);
  for (const file of files) {
    if (file.endsWith(thumbnailFormat)) {
      const oldPath = path.join(sourceDir, file);
      const newPath = path.join(targetDir, file);
      await fse.move(oldPath, newPath);
    }
  }
};

const generateVideoThumbnailBitmap = async (videoPath: string): Promise<ImageBitmap> => {
  const video = document.createElement('video');
  try {
    video.src = encodeFilePath(videoPath);
    video.muted = true;
    video.playsInline = true;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => {
        video.currentTime = 0;
      };
      video.onseeked = () => {
        video.oncanplay = () => resolve();
      };
      video.onerror = () => reject(new Error('Error loading video for thumbnail'));
    });
    let bitmap = await createImageBitmap(video);
    // Avoid bad thumbnails.
    // If the frame is mostly in a single color (e.g., solid color, blank frame, fade-in transition)
    // generate the bitmap from the middle of the video
    if (isFrameMonotone(bitmap)) {
      video.currentTime = video.duration / 2;
      await new Promise<void>((resolve) => {
        video.onseeked = async () => resolve();
      });
      bitmap.close();
      bitmap = await createImageBitmap(video);
    }
    return bitmap;
  } catch (error) {
    throw error;
  } finally {
    // Cleanup video element with delay to prevent the ImageBitmap to lose the thumbnail information.
    setTimeout(() => {
      video.src = '';
      video.removeAttribute('src');
    }, 10000);
  }
};

/**
 * Check if an ImageBitmap frame is approximately monotone.
 *
 * @param bitmap - The input ImageBitmap to analyze.
 * @param bucketBits - Number of bits kept per channel (default: 4). Lower values mean fewer distinct buckets (more aggressive grouping).
 * @param sampleStep - How many pixels to skip between samples (default: 10). Higher values mean faster processing but less accuracy.
 * @param dominanceThreshold - The fraction of the frame a single bucket must occupy to consider it monotone (default: 0.95).
 * @returns `true` if the frame is considered monotone, `false` otherwise.
 */
const isFrameMonotone = (
  bitmap: ImageBitmap,
  bucketBits = 4,
  sampleStep = 10,
  dominanceThreshold = 0.95,
): boolean => {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('No canvas context 2D (should never happen)');
  }
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

  const histogram = new Map<number, number>();
  const shift = 8 - bucketBits;
  const step = 4 * sampleStep;
  let total = 0;
  for (let i = 0; i < data.length; i += step) {
    const r = data[i] >> shift;
    const g = data[i + 1] >> shift;
    const b = data[i + 2] >> shift;
    const key = (r << (2 * bucketBits)) | (g << bucketBits) | b;
    histogram.set(key, (histogram.get(key) || 0) + 1);
    total++;
  }

  // find the most frequent bucket
  let maxCount = 0;
  for (const count of histogram.values()) {
    if (count > maxCount) {
      maxCount = count;
    }
  }
  // if a single bucket exceeds the threshold consider the frame as monotone
  return maxCount / total >= dominanceThreshold;
};
