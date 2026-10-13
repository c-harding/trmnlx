import assert from "node:assert/strict";
import { test } from "node:test";
import { contourInterval, contourLines, slopeInterval } from "../src/contours.ts";

test("contour lines are closer together further in", () => {
  assert.deepEqual([14, 13, 12, 10.5, 9, 7].map(contourInterval), [20, 50, 100, 200, 500, 1000]);
});

// A cone 250 m high in the middle of a 60 × 60 grid, at sea level around it
const size = 60;
const cone = Float32Array.from({ length: size * size }, (_, i) =>
  Math.max(0, 250 - 10 * Math.hypot((i % size) - 30, Math.floor(i / size) - 30)),
);

test("a hill gets one closed line per level, every interval above sea level, every fifth an index contour", () => {
  const levels = contourLines(cone, size, size, 50);
  assert.deepEqual(
    levels.map((l) => l.level),
    [50, 100, 150, 200, 250].slice(0, levels.length),
  );
  assert.ok(levels.length >= 4);
  for (const { lines } of levels) {
    assert.equal(lines.length, 1);
    const line = lines[0];
    assert.deepEqual(line[0], line.at(-1));
  }
  assert.deepEqual(
    levels.map((l) => l.index),
    levels.map((l) => l.level === 250),
  );
});

test("a slope reaching the grid's edge gets lines that stop there, not along it", () => {
  // Rising from 0 on the left to 590 on the right
  const slope = Float32Array.from({ length: size * size }, (_, i) => (i % size) * 10);
  const levels = contourLines(slope, size, size, 100);
  const onEdge = (p: { x: number; y: number }) =>
    p.x <= 0 || p.y <= 0 || p.x >= size || p.y >= size;
  for (const { lines } of levels) {
    for (const line of lines) {
      for (let k = 1; k < line.length; k++)
        assert.ok(!(onEdge(line[k - 1]) && onEdge(line[k])), "a step along the edge");
    }
  }
  assert.equal(levels.length, 5);
});

test("slopeInterval: the round interval nearest 2.5 times the steep slopes' rise per screen pixel", () => {
  // A plane rising 4 m per grid cell, shown one cell per pixel: 2.5 × 4 = 10 m
  const size = 20;
  const plane = (rise: number) =>
    Float32Array.from({ length: size * size }, (_, i) => 100 + (i % size) * rise);
  assert.equal(slopeInterval(plane(4), size, size, 1), 10);
  // 9 m per pixel (Snowdonia at zoom 13): 22.5, nearest 25
  assert.equal(slopeInterval(plane(9), size, size, 1), 25);
  // Two cells per pixel (tiles shown at half their size): twice as steep on screen
  assert.equal(slopeInterval(plane(9), size, size, 2), 50);
  // 24 m per pixel (Everest at 13): 60, nearest 50
  assert.equal(slopeInterval(plane(24), size, size, 1), 50);
  // Only sea: nothing to judge by
  assert.equal(slopeInterval(new Float32Array(size * size), size, size, 1), undefined);
});
