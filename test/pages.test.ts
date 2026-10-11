import assert from "node:assert/strict";
import { test } from "node:test";
import { statusText } from "../src/pages.ts";

const status = { position: 2, screen: "journeys", count: 3, now: new Date("2026-10-12T10:00:00Z"), timeZone: "Europe/Berlin" };
const caption = (checkIn: { shown: number; next: string } | undefined) =>
  statusText({ ...status, checkIn: checkIn && { shown: checkIn.shown, next: new Date(checkIn.next) } }).caption;

test("the screen page says which entry is showing", () => {
  assert.equal(statusText({ ...status, checkIn: undefined }).showing, "Showing journeys (2/3)");
  assert.equal(statusText({ ...status, count: 1, position: 1, checkIn: undefined }).showing, "Showing journeys");
});

test("the preview is live once the device got the entry", () => {
  assert.equal(caption({ shown: 2, next: "2026-10-12T10:05:00Z" }), "Live preview:");
  // Still live when the device is overdue: it keeps showing what it got
  assert.equal(caption({ shown: 2, next: "2026-10-12T09:58:00Z" }), "Live preview:");
});

test("otherwise it says when the device will pick it up", () => {
  assert.equal(caption({ shown: 1, next: "2026-10-12T10:05:00Z" }), "Preview (will be applied at 12:05):");
  assert.equal(caption({ shown: 1, next: "2026-10-13T06:05:00Z" }), "Preview (will be applied at 13 Oct 2026, 08:05):");
  // Overdue, or no check-in since the server started
  assert.equal(caption({ shown: 1, next: "2026-10-12T09:58:00Z" }), "Preview (will be applied when device comes online):");
  assert.equal(caption(undefined), "Preview (will be applied when device comes online):");
});
