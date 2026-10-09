import { readFile } from "node:fs/promises";
import satori from "satori";
import sharp from "sharp";
import { encodePng1Bit } from "./png1bit.js";

// Screens are rendered one at a time and rarely, so sharp's cache and thread pool only cost
// memory: without them the process used about 65 MB less, for about 3 ms more per render.
sharp.cache(false);
sharp.concurrency(1);

export const WIDTH = 800;
export const HEIGHT = 480;

// The full static Inter fonts (scripts/build copies assets/fonts next to the server). Not the
// variable font, which Satori fails to read, and not the Google Fonts subsets, which lack symbols
// such as ≈ and →.
const loadFont = async (file, weight) => ({
  name: "Inter",
  weight,
  style: "normal",
  data: await readFile(new URL(`./fonts/${file}`, import.meta.url)),
});

const fonts = await Promise.all([loadFont("Inter-Regular.ttf", 400), loadFont("Inter-Bold.ttf", 700)]);

/**
 * Renders a layout to a PNG the display can show, 800 × 480. The firmware picks its display mode
 * from the bit depth:
 * - 4 colours (2 bits per pixel, palette): 4-gray mode, always a full refresh, which flashes. The
 *   firmware maps the palette colours to gray itself;
 * - 2 colours (1 bit per pixel, grayscale): black and white, with a fast partial refresh.
 *   Anti-aliased edges are thresholded, so nothing in between survives. Not a palette PNG, which
 *   the firmware would show inverted (see png1bit.js).
 */
export async function renderPng(layout, { colors = 4 } = {}) {
  const svg = await satori(layout, { width: WIDTH, height: HEIGHT, fonts });
  const image = sharp(Buffer.from(svg)).grayscale();
  if (colors === 2) {
    const { data, info } = await image.threshold(128).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
    return encodePng1Bit(data, info.width, info.height);
  }
  return image.png({ palette: true, colours: colors, compressionLevel: 9 }).toBuffer();
}
