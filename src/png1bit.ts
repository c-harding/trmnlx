import { crc32, deflateSync } from "node:zlib";

// Writes a 1-bit grayscale PNG (colour type 0), where black is 0 and white is 1; and 8-bit
// grayscale ones, synchronously (e.g. for an image inside a screen's layout).
//
// The firmware reads 1-bit *palette* PNGs the other way round: whatever the palette's order, it
// ends up treating black as 1, which shows inverted on the display. sharp (libvips) only writes
// 1-bit PNGs with a palette, so this small encoder writes the grayscale form instead.

function chunk(type: string, data: Buffer) {
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Encodes 8-bit gray pixels (one byte per pixel, row by row) as a 1-bit PNG: values of 128 and
 * above become white, the rest black.
 */
export function encodePng1Bit(pixels: Uint8Array, width: number, height: number) {
  const rowBytes = Math.ceil(width / 8);
  // Each row starts with a filter type byte (0: none), followed by 8 pixels per byte, first pixel
  // in the highest bit
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (rowBytes + 1) + 1;
    for (let x = 0; x < width; x++) {
      if (pixels[y * width + x] >= 128) raw[row + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 1; // bit depth
  header[9] = 0; // colour type: grayscale
  // compression, filter method and interlacing: all 0 (the only/default values)

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Encodes 8-bit gray pixels (one byte per pixel, row by row) as an 8-bit grayscale PNG. */
export function encodePngGray(pixels: Uint8Array, width: number, height: number) {
  // Each row starts with a filter type byte (0: none)
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++)
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // colour type: grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
