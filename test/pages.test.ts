import assert from "node:assert/strict";
import { test } from "node:test";
import { statusText } from "../src/pages.ts";

const status = { screen: "journeys", position: 2, count: 3, now: new Date("2026-10-12T10:00:00Z"), timeZone: "Europe/Berlin" };

test("the screen page says where the playlist is and when the device checks in", () => {
  assert.equal(statusText({ ...status, expectedCheckIn: undefined }).showing, "Showing journeys (2 of 3).");
  assert.match(statusText({ ...status, expectedCheckIn: undefined }).checkIn, /hasn't checked in since the server started/);
  assert.match(statusText({ ...status, expectedCheckIn: new Date("2026-10-12T10:05:00Z") }).checkIn, /is expected around 12:05\.$/);
  assert.match(statusText({ ...status, expectedCheckIn: new Date("2026-10-12T09:55:00Z") }).checkIn, /was expected around 11:55\.$/);
});

test("a check-in on another day comes with its date", () => {
  assert.match(statusText({ ...status, expectedCheckIn: new Date("2026-10-10T06:05:00Z") }).checkIn, /was expected around 10 Oct 2026, 08:05\.$/);
});
