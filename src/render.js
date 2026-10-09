import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import satori from "satori";
import sharp from "sharp";

export const WIDTH = 800;
export const HEIGHT = 480;

// Satori reads TTF, OTF and WOFF, but not WOFF2
const loadFont = async (weight) => ({
  name: "Inter",
  weight,
  style: "normal",
  data: await readFile(fileURLToPath(import.meta.resolve(`@fontsource/inter/files/inter-latin-${weight}-normal.woff`))),
});

const fonts = await Promise.all([loadFont(400), loadFont(700)]);

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
