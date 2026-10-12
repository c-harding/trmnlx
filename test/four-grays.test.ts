import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { fourGrayPng, LEVELS } from "../src/four-grays.ts";

const grays = async (png: Buffer) => sharp(png).extractChannel(0).raw().toBuffer();

test("an image becomes the display's four grays, whatever grays it has", async () => {
  // A gradient: every shade from black to white
  const width = 256, height = 8;
  const gradient = Buffer.alloc(width * height);
  for (let i = 0; i < gradient.length; i++) gradient[i] = i % width;
  const out = await grays(await fourGrayPng(sharp(gradient, { raw: { width, height, channels: 1 } })));
  assert.deepEqual(new Set(out), new Set(LEVELS));
});

test("flat areas keep their gray exactly, also a dark gray between black and lighter grays", async () => {
  // Bands of dark gray (a railway's #555) and light gray (water) next to white, each wider than a pixel
  const width = 30, height = 10;
  const image = Buffer.alloc(width * height, 255);
  for (let y = 0; y < height; y++) for (let x = 0; x < 10; x++) { image[y * width + x] = 85; image[y * width + x + 10] = 170; }
  const out = await grays(await fourGrayPng(sharp(image, { raw: { width, height, channels: 1 } })));
  assert.deepEqual([out[5 * width + 4], out[5 * width + 14], out[5 * width + 24]], [85, 170, 255]);
});

test("an edge between grays keeps its darkness, mixed from the two nearest levels", async () => {
  // A checkerboard of 100 and 140 (no pixel flat): its average, 120, from dark and light gray only
  const width = 40, height = 40;
  const image = Buffer.alloc(width * height);
  for (let i = 0; i < image.length; i++) image[i] = ((i % width) + Math.floor(i / width)) % 2 ? 100 : 140;
  const out = await grays(await fourGrayPng(sharp(image, { raw: { width, height, channels: 1 } })));
  assert.deepEqual(new Set(out), new Set([85, 170]));
  const mean = out.reduce((a, b) => a + b, 0) / out.length;
  assert.ok(Math.abs(mean - 120) < 3, `mean ${mean}`);
});
