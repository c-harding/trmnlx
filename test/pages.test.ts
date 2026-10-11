import assert from "node:assert/strict";
import { test } from "node:test";
import { statusText } from "../src/pages.ts";

// journeys, the second of three entries that apply now; departures applies at other times
const status = {
  screen: "journeys",
  index: 1,
  position: 2,
  count: 3,
  otherTimes: ["departures"],
  now: new Date("2026-10-12T10:00:00Z"),
  timeZone: "Europe/Berlin",
};
const caption = (checkIn: { shown: number | undefined; next: string } | undefined) =>
  statusText({ ...status, checkIn: checkIn && { shown: checkIn.shown, next: new Date(checkIn.next) } }).caption;

test("the screen page says which entry is showing, among those that apply now", () => {
  const text = statusText({ ...status, checkIn: undefined });
  assert.equal(text.showing, "Showing journeys (2/3)");
  assert.equal(text.title, "Also in the playlist, at other times: departures");
  assert.equal(text.canMove, true);
  assert.equal(statusText({ ...status, count: 1, position: 1, otherTimes: [], checkIn: undefined }).showing, "Showing journeys");
  assert.equal(statusText({ ...status, count: 1, position: 1, otherTimes: [], checkIn: undefined }).canMove, false);
});

test("with nothing applying, it says the default screen is showing", () => {
  const text = statusText({ ...status, screen: "placeholder", index: -1, position: 0, count: 0, otherTimes: ["journeys"], checkIn: undefined });
  assert.equal(text.showing, "Showing placeholder, the default: nothing in the playlist applies now");
  assert.equal(text.canMove, false);
});

test("the preview is live once the device got the entry", () => {
  assert.equal(caption({ shown: 1, next: "2026-10-12T10:05:00Z" }), "Live preview:");
  // Still live when the device is overdue: it keeps showing what it got
  assert.equal(caption({ shown: 1, next: "2026-10-12T09:58:00Z" }), "Live preview:");
});

test("otherwise it says when the device will pick it up", () => {
  assert.equal(caption({ shown: 0, next: "2026-10-12T10:05:00Z" }), "Preview (will be applied at 12:05):");
  assert.equal(caption({ shown: 0, next: "2026-10-13T06:05:00Z" }), "Preview (will be applied at 13 Oct 2026, 08:05):");
  // Overdue, or no check-in since the server started
  assert.equal(caption({ shown: 0, next: "2026-10-12T09:58:00Z" }), "Preview (will be applied when device comes online):");
  assert.equal(caption(undefined), "Preview (will be applied when device comes online):");
});
