// Reads the pixel dimensions of common image formats straight from the file header.
// This only touches the first few bytes of a file (or, for JPEG, the segment headers before the
// image data), so it is much cheaper than asking ExifTool, which reads whole files and handles
// one file at a time. ExifTool remains the fallback for any format or file this cannot parse.
import { open } from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import Path from 'path';

export interface Dimensions {
  width: number;
  height: number;
}

/** Extensions whose dimensions {@link readImageHeaderDimensions} can read */
const HEADER_FORMATS = new Set(['png', 'apng', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'bmp', 'psd']);

export function canReadDimensionsFromHeader(path: string): boolean {
  return HEADER_FORMATS.has(Path.extname(path).slice(1).toLowerCase());
}

/** Enough for the PNG, GIF, BMP, PSD and WebP headers, and for the first JPEG segments */
const HEADER_SIZE = 64;

/**
 * Returns the dimensions stored in an image's header, or undefined when the format is not
 * supported, the file is not what its contents claim, or the header is malformed.
 */
export async function readImageHeaderDimensions(path: string): Promise<Dimensions | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    const header = await readAt(handle, 0, HEADER_SIZE);
    // Detect by content rather than by extension: files are sometimes saved with the wrong one.
    const dimensions = isJpeg(header)
      ? await readJpegDimensions(handle, header)
      : readDimensionsFromBuffer(header);
    return dimensions !== undefined && dimensions.width > 0 && dimensions.height > 0
      ? dimensions
      : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Parses every supported format except JPEG, which needs more than the first bytes */
export function readDimensionsFromBuffer(b: Buffer): Dimensions | undefined {
  // PNG: signature, then the IHDR chunk (Apple's CgBI variant puts a CgBI chunk first)
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    // Offset of the IHDR chunk type
    let ihdr = 12;
    if (b.toString('latin1', 12, 16) === 'CgBI') {
      // Skip the CgBI type, data and CRC, and the length of the next chunk
      ihdr += 4 + b.readUInt32BE(8) + 4 + 4;
    }
    if (b.length < ihdr + 12 || b.toString('latin1', ihdr, ihdr + 4) !== 'IHDR') {
      return undefined;
    }
    return { width: b.readUInt32BE(ihdr + 4), height: b.readUInt32BE(ihdr + 8) };
  }

  // GIF: logical screen size, as reported by ExifTool
  if (
    b.length >= 10 &&
    (b.toString('latin1', 0, 6) === 'GIF87a' || b.toString('latin1', 0, 6) === 'GIF89a')
  ) {
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }

  // PSD / PSB: height then width, big-endian
  if (b.length >= 26 && b.toString('latin1', 0, 4) === '8BPS') {
    return { width: b.readUInt32BE(18), height: b.readUInt32BE(14) };
  }

  // BMP: the DIB header size tells which header layout follows
  if (b.length >= 26 && b.toString('latin1', 0, 2) === 'BM') {
    const dibSize = b.readUInt32LE(14);
    if (dibSize === 12) {
      return { width: b.readUInt16LE(18), height: b.readUInt16LE(20) };
    }
    // Height is negative for top-down bitmaps
    return { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) };
  }

  // WebP: RIFF container with a VP8 (lossy), VP8L (lossless) or VP8X (extended) chunk
  if (
    b.length >= 30 &&
    b.toString('latin1', 0, 4) === 'RIFF' &&
    b.toString('latin1', 8, 12) === 'WEBP'
  ) {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8X') {
      return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    }
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
    return undefined;
  }

  return undefined;
}

function isJpeg(b: Buffer): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

/** Start-of-frame markers: SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC) */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** Walks the JPEG segments up to the first start-of-frame, skipping over EXIF, ICC and other data */
async function readJpegDimensions(
  handle: FileHandle,
  header: Buffer,
): Promise<Dimensions | undefined> {
  const { size } = await handle.stat();
  let offset = 2;
  // A segment header is at most 9 bytes up to the dimensions; read a little more to skip fill bytes
  let segment = header;
  let segmentStart = 0;
  for (let i = 0; i < 1000 && offset + 9 <= size; i++) {
    if (offset < segmentStart || offset + 16 > segmentStart + segment.length) {
      segment = await readAt(handle, offset, 16);
      segmentStart = offset;
    }
    let p = offset - segmentStart;
    if (segment[p] !== 0xff) {
      return undefined;
    }
    // Any number of 0xFF fill bytes may precede a marker
    while (p < segment.length - 1 && segment[p + 1] === 0xff) {
      p++;
      offset++;
    }
    if (p + 9 > segment.length) {
      segment = await readAt(handle, offset, 16);
      segmentStart = offset;
      continue;
    }
    const marker = segment[p + 1];
    if (marker === 0xd9 || marker === 0xda) {
      return undefined; // End of image, or image data, before any frame header
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // Markers without a length
      continue;
    }
    if (isStartOfFrame(marker)) {
      return { width: segment.readUInt16BE(p + 7), height: segment.readUInt16BE(p + 5) };
    }
    offset += 2 + segment.readUInt16BE(p + 2);
  }
  return undefined;
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}
