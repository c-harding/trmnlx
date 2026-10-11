import { readFile } from "node:fs/promises";
import type { VNode } from "preact";
import satori, { type Font, type FontWeight } from "satori";
import sharp from "sharp";
import { fourGrayPng } from "./four-grays.ts";
import { encodePng1Bit } from "./png1bit.ts";

// Screens are rendered one at a time and rarely, so sharp's cache and thread pool only cost
// memory: without them the process used about 65 MB less, for about 3 ms more per render.
sharp.cache(false);
sharp.concurrency(1);

export const WIDTH = 800;
export const HEIGHT = 480;

// The full static Inter fonts (scripts/build copies assets/fonts next to the server), for text of
// 32 px and more. Not the variable font, which Satori fails to read, and not the Google Fonts
// subsets, which lack symbols such as ≈ and →.
//
// Smaller text uses TRMNL's pixel fonts (see `pixelFont` in components/type.ts), each drawn on a
// pixel grid at one size: 12, 16 and 21 px. They stay crisp in black and white, where Inter's
// anti-aliased edges are cut off unevenly.
const loadFont = async (name: string, file: string, weight: FontWeight): Promise<Font> => ({
  name,
  weight,
  style: "normal",
  data: await readFile(new URL(`./fonts/${file}`, import.meta.url)),
});

const fonts = await Promise.all([
  loadFont("Inter", "Inter-Regular.ttf", 400),
  loadFont("Inter", "Inter-Bold.ttf", 700),
  ...[12, 16, 21].flatMap((size) => [
    loadFont(`TRMNL${size}`, `TRMNL${size}-Regular.ttf`, 400),
    loadFont(`TRMNL${size}`, `TRMNL${size}-Bold.ttf`, 700),
  ]),
]);

/**
 * Renders a layout to a PNG the display can show, 800 × 480. The firmware picks its display mode
 * from the bit depth:
 * - 4 colours (2 bits per pixel, palette): 4-gray mode, always a full refresh, which flashes. The
 *   firmware maps the palette colours to gray itself;
 * - 2 colours (1 bit per pixel, grayscale): black and white, with a fast partial refresh.
 *   Anti-aliased edges are thresholded, so nothing in between survives. Not a palette PNG, which
 *   the firmware would show inverted (see png1bit.ts).
 */
export async function renderPng(layout: VNode, { colors = 4 }: { colors?: 2 | 4 } = {}) {
  const svg = await satori(layout, { width: WIDTH, height: HEIGHT, fonts });
  const image = sharp(Buffer.from(svg)).grayscale();
  if (colors === 2) {
    const { data, info } = await image.threshold(128).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
    return encodePng1Bit(data, info.width, info.height);
  }
  return fourGrayPng(image);
}
