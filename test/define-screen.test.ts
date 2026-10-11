import assert from "node:assert/strict";
import { test } from "node:test";
import { dataTtl } from "../src/define-screen.ts";

const now = new Date("2026-10-12T10:00:00Z");
const inSeconds = (s: number) => now.getTime() + s * 1000;

test("a screen's ttl is capped by when its data expires", () => {
  // Data for 5 min, screen valid for an hour: 5 min
  assert.equal(dataTtl(3600, inSeconds(300), false, now), 300);
  // The screen's own ttl when shorter
  assert.equal(dataTtl(45, inSeconds(300), false, now), 45);
  // Data kept until restart, or no data: unchanged
  assert.equal(dataTtl(3600, Infinity, false, now), 3600);
  assert.equal(dataTtl(Infinity, Infinity, false, now), Infinity);
});

test("data never makes a screen valid for less than a minute (plus margin), unless shown stale", () => {
  // Departures expiring in 55 s on a screen that changes in 62 s: still 62 s, not two wakes
  assert.equal(dataTtl(62, inSeconds(55), false, now), 62);
  assert.equal(dataTtl(3600, inSeconds(10), false, now), 62);
  // Already expired, e.g. a failure kept for 0 s: the same
  assert.equal(dataTtl(3600, inSeconds(-5), false, now), 62);
  // Shown stale: asked for again soon, once the new data has loaded
  assert.equal(dataTtl(60, inSeconds(-30), true, now), 15);
  assert.equal(dataTtl(5, inSeconds(-30), true, now), 5);
});
