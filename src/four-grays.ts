// Images reduced to 4 grays for the display's 4-gray mode: drawn maps (sources/map.ts) and screens
// (render.ts).
import sharp, { type Sharp } from "sharp";

/**
 * An image as a palette PNG of 4 grays, which sharp picks (the firmware maps them to the display's).
 * sharp dithers what falls between its grays, which suits anti-aliased edges, but not flat areas:
 * water whose gray isn't one of the 4 would be a pattern of dots. So a pixel the same as all its
 * neighbours (inside an area of one gray) gets the nearest of the 4 instead, and only edges stay
 * dithered.
 */
export async function fourGrayPng(image: Sharp) {
  const { data: source, info } = await image.grayscale().extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const raw = { width, height, channels: 1 } as const;
  const dithered = await sharp(source, { raw }).png({ palette: true, colours: 4 }).toBuffer();
  const { data } = await sharp(dithered).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  const grays = [...new Set(data)];
  const nearest = Uint8Array.from({ length: 256 }, (_, gray) =>
    grays.reduce((a, b) => (Math.abs(b - gray) < Math.abs(a - gray) ? b : a)),
  );
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const gray = source[i];
      const flat =
        (x === 0 || source[i - 1] === gray) &&
        (x === width - 1 || source[i + 1] === gray) &&
        (y === 0 || source[i - width] === gray) &&
        (y === height - 1 || source[i + width] === gray);
      if (flat) data[i] = nearest[gray];
    }
  }
  // Still the same 4 grays, so nothing more to dither
  return sharp(data, { raw }).png({ palette: true, colours: 4, dither: 0, compressionLevel: 9 }).toBuffer();
}
