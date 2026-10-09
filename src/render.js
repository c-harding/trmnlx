import { readFile } from "node:fs/promises";
import satori from "satori";
import sharp from "sharp";

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
 * Renders a layout to a PNG the display can show: 800 × 480, 4 grays, 2 bits per pixel.
 * The firmware picks 4-gray mode from the bit depth, and maps palette colours to gray itself.
 */
export async function renderPng(layout) {
  const svg = await satori(layout, { width: WIDTH, height: HEIGHT, fonts });
  return sharp(Buffer.from(svg))
    .grayscale()
    .png({ palette: true, colours: 4, compressionLevel: 9 })
    .toBuffer();
}
