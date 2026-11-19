import fse from 'fs-extra';
import os from 'os';
import path from 'path';

import { canReadDimensionsFromHeader, readImageHeaderDimensions } from '../common/imageHeader';

let dir: string;

beforeAll(async () => {
  dir = await fse.mkdtemp(path.join(os.tmpdir(), 'allusion-image-header-'));
});

afterAll(async () => {
  await fse.remove(dir);
});

async function writeFile(name: string, ...parts: Buffer[]): Promise<string> {
  const filePath = path.join(dir, name);
  await fse.writeFile(filePath, Buffer.concat(parts));
  return filePath;
}

const u16be = (n: number) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const u32be = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const u16le = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const i32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n);
  return b;
};
const ascii = (s: string) => Buffer.from(s, 'latin1');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  return Buffer.concat([u32be(data.length), ascii(type), data, u32be(0)]);
}

function png(width: number, height: number): Buffer {
  const ihdr = Buffer.concat([u32be(width), u32be(height), Buffer.from([8, 6, 0, 0, 0])]);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', Buffer.alloc(1000)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function jpegSegment(marker: number, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0xff, marker]), u16be(data.length + 2), data]);
}

function jpeg(width: number, height: number, ...segmentsBeforeFrame: Buffer[]): Buffer {
  const sof = Buffer.concat([Buffer.from([8]), u16be(height), u16be(width), Buffer.from([3])]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...segmentsBeforeFrame,
    jpegSegment(0xc0, sof),
    jpegSegment(0xda, Buffer.alloc(10)),
    Buffer.alloc(500),
    Buffer.from([0xff, 0xd9]),
  ]);
}

describe('readImageHeaderDimensions', () => {
  it('reads PNG dimensions', async () => {
    const file = await writeFile('a.png', png(1920, 1080));
    expect(await readImageHeaderDimensions(file)).toEqual({ width: 1920, height: 1080 });
  });

  it('reads Apple CgBI PNG dimensions', async () => {
    const ihdr = Buffer.concat([u32be(64), u32be(32), Buffer.from([8, 6, 0, 0, 0])]);
    const file = await writeFile(
      'cgbi.png',
      PNG_SIGNATURE,
      pngChunk('CgBI', Buffer.from([0x50, 0x00, 0x20, 0x06])),
      pngChunk('IHDR', ihdr),
    );
    expect(await readImageHeaderDimensions(file)).toEqual({ width: 64, height: 32 });
  });

  it('reads a baseline JPEG', async () => {
    const file = await writeFile('a.jpg', jpeg(800, 600, jpegSegment(0xe0, ascii('JFIF\0'))));
    expect(await readImageHeaderDimensions(file)).toEqual({ width: 800, height: 600 });
  });

  it('skips large EXIF segments and fill bytes before the JPEG frame header', async () => {
    const exif = jpegSegment(0xe1, Buffer.concat([ascii('Exif\0\0'), Buffer.alloc(60000)]));
    const icc = jpegSegment(0xe2, Buffer.alloc(30000));
    const file = await writeFile(
      'exif.jpg',
      jpeg(4032, 3024, exif, Buffer.from([0xff, 0xff, 0xff]), icc),
    );
    expect(await readImageHeaderDimensions(file)).toEqual({ width: 4032, height: 3024 });
  });

  it('reads a progressive JPEG', async () => {
    const sof2 = Buffer.concat([Buffer.from([8]), u16be(100), u16be(200), Buffer.from([3])]);
    const file = await writeFile(
      'progressive.jpg',
      Buffer.from([0xff, 0xd8]),
      jpegSegment(0xc4, Buffer.alloc(20)), // DHT is not a frame header
      jpegSegment(0xc2, sof2),
    );
    expect(await readImageHeaderDimensions(file)).toEqual({ width: 200, height: 100 });
  });

  it('reads GIF dimensions', async () => {
    const file = await writeFile(
      'a.gif',
      ascii('GIF89a'),
      u16le(320),
      u16le(240),
      Buffer.alloc(20),
    );
    expect(await readImageHeaderDimensions(file)).toEqual({ width: 320, height: 240 });
  });

  it('reads BMP dimensions, including top-down and OS/2 bitmaps', async () => {
    const bmpHeader = Buffer.concat([ascii('BM'), Buffer.alloc(12)]);
    // BITMAPINFOHEADER with a negative height
    const top = await writeFile(
      'top.bmp',
      bmpHeader,
      Buffer.from([40, 0, 0, 0]),
      i32le(640),
      i32le(-480),
      Buffer.alloc(30),
    );
    expect(await readImageHeaderDimensions(top)).toEqual({ width: 640, height: 480 });

    const os2 = await writeFile(
      'os2.bmp',
      bmpHeader,
      Buffer.from([12, 0, 0, 0]),
      u16le(16),
      u16le(8),
      Buffer.alloc(30),
    );
    expect(await readImageHeaderDimensions(os2)).toEqual({ width: 16, height: 8 });
  });

  it('reads PSD dimensions', async () => {
    const file = await writeFile(
      'a.psd',
      ascii('8BPS'),
      u16be(1),
      Buffer.alloc(6),
      u16be(3),
      u32be(1200), // height
      u32be(2400), // width
      Buffer.alloc(30),
    );
    expect(await readImageHeaderDimensions(file)).toEqual({ width: 2400, height: 1200 });
  });

  it('reads WebP dimensions for all three chunk types', async () => {
    const riff = (chunk: Buffer) => Buffer.concat([ascii('RIFF'), u32be(0), ascii('WEBP'), chunk]);

    const vp8x = Buffer.concat([ascii('VP8X'), u32be(10), Buffer.alloc(4)]);
    const canvas = Buffer.alloc(6);
    canvas.writeUIntLE(1000 - 1, 0, 3);
    canvas.writeUIntLE(500 - 1, 3, 3);
    const extended = await writeFile(
      'x.webp',
      riff(Buffer.concat([vp8x, canvas, Buffer.alloc(10)])),
    );
    expect(await readImageHeaderDimensions(extended)).toEqual({ width: 1000, height: 500 });

    const bits = Buffer.alloc(4);
    bits.writeUInt32LE((300 - 1) | ((200 - 1) << 14));
    const lossless = await writeFile(
      'l.webp',
      riff(Buffer.concat([ascii('VP8L'), u32be(0), Buffer.from([0x2f]), bits, Buffer.alloc(10)])),
    );
    expect(await readImageHeaderDimensions(lossless)).toEqual({ width: 300, height: 200 });

    const lossy = await writeFile(
      'v.webp',
      riff(
        Buffer.concat([
          ascii('VP8 '),
          u32be(0),
          Buffer.alloc(3),
          Buffer.from([0x9d, 0x01, 0x2a]),
          u16le(640),
          u16le(360),
          Buffer.alloc(10),
        ]),
      ),
    );
    expect(await readImageHeaderDimensions(lossy)).toEqual({ width: 640, height: 360 });
  });

  it('detects the format from the contents, not the extension', async () => {
    const file = await writeFile('actually-a-png.jpg', png(10, 20));
    expect(await readImageHeaderDimensions(file)).toEqual({ width: 10, height: 20 });
  });

  it('returns undefined for unknown, truncated or missing files', async () => {
    expect(
      await readImageHeaderDimensions(await writeFile('text.png', ascii('hello'))),
    ).toBeUndefined();
    expect(
      await readImageHeaderDimensions(
        await writeFile('cut.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])),
      ),
    ).toBeUndefined();
    expect(await readImageHeaderDimensions(await writeFile('empty.png'))).toBeUndefined();
    expect(await readImageHeaderDimensions(path.join(dir, 'does-not-exist.png'))).toBeUndefined();
  });

  it('only claims the formats it can parse', () => {
    expect(canReadDimensionsFromHeader('C:\\a\\b.PNG')).toBe(true);
    expect(canReadDimensionsFromHeader('/a/b.jpeg')).toBe(true);
    expect(canReadDimensionsFromHeader('/a/b.exr')).toBe(false);
    expect(canReadDimensionsFromHeader('/a/b.mp4')).toBe(false);
    expect(canReadDimensionsFromHeader('/a/LICENSE')).toBe(false);
  });
});
