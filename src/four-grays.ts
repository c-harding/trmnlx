// Images reduced to 4 grays for the display's 4-gray mode: drawn maps (sources/map.ts) and screens
// (render.ts).
import sharp, { type Sharp } from "sharp";

/** The display's four grays: black, dark gray, light gray, white (as #000, #555, #aaa, #fff). */
export const LEVELS = [0, 85, 170, 255];
const nearest = (gray: number) =>
  LEVELS.reduce((a, b) => (Math.abs(b - gray) < Math.abs(a - gray) ? b : a));

/**
 * An image as a palette PNG of the display's four grays (LEVELS), the same for every image, so a
 * color drawn as one of them (e.g. a railway's #555) always stays it, and every image has the same
 * contrast. A pixel the same as all its neighbours (inside an area of one gray) gets the nearest
 * level; the rest, mostly anti-aliased edges, are dithered by error diffusion (Floyd–Steinberg): each
 * takes the nearest level and passes on the difference to its neighbours to the right and below, so
 * an edge keeps its average darkness, mixed from the two nearest levels (85 apart, rather than
 * whichever grays an image would otherwise get, which could leave black specks on a thin gray line).
 */
export async function fourGrayPng(image: Sharp) {
  const { data: source, info } = await image
    .grayscale()
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const out = Buffer.alloc(width * height);
  const error = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const gray = source[i];
      const flat =
        (x === 0 || source[i - 1] === gray) &&
        (x === width - 1 || source[i + 1] === gray) &&
        (y === 0 || source[i - width] === gray) &&
        (y === height - 1 || source[i + width] === gray);
      if (flat) {
        out[i] = nearest(gray);
        continue;
      }
      const value = Math.max(0, Math.min(255, gray + error[i]));
      const level = nearest(value);
      out[i] = level;
      const rest = value - level;
      if (x + 1 < width) error[i + 1] += (rest * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) error[i + width - 1] += (rest * 3) / 16;
        error[i + width] += (rest * 5) / 16;
        if (x + 1 < width) error[i + width + 1] += rest / 16;
      }
    }
  }
  // Only the four levels, so the palette is exactly them and there's nothing more to dither
  return sharp(out, { raw: { width, height, channels: 1 } })
    .png({ palette: true, colours: 4, dither: 0, compressionLevel: 9 })
    .toBuffer();
}
