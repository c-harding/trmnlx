import assert from "node:assert/strict";
import { test } from "node:test";
import { currentEntry, expectedCheckIn, moveOn, recordCheckIn, stepIndex } from "../src/device-state.ts";

const device = (mac: string, screens: string[]) => ({ mac, playlist: screens.map((screen) => ({ screen, inputs: {} })) });

test("stepIndex wraps around in both directions", () => {
  assert.equal(stepIndex(0, 3, 1), 1);
  assert.equal(stepIndex(2, 3, 1), 0);
  assert.equal(stepIndex(0, 3, -1), 2);
  assert.equal(stepIndex(0, 1, 1), 0);
  assert.equal(stepIndex(0, 1, -1), 0);
});

test("a device starts at its first entry and moves on, wrapping around", () => {
  const kitchen = device("A1", ["departures", "journeys", "placeholder"]);
  assert.equal(currentEntry(kitchen).entry.screen, "departures");
  moveOn(kitchen, 1);
  assert.deepEqual(currentEntry(kitchen), { entry: kitchen.playlist[1], index: 1 });
  moveOn(kitchen, 1);
  moveOn(kitchen, 1);
  assert.equal(currentEntry(kitchen).entry.screen, "departures");
  moveOn(kitchen, -1);
  assert.equal(currentEntry(kitchen).entry.screen, "placeholder");
});

test("devices move independently", () => {
  const a = device("A2", ["departures", "journeys"]);
  const b = device("B2", ["departures", "journeys"]);
  moveOn(a, 1);
  assert.equal(currentEntry(a).entry.screen, "journeys");
  assert.equal(currentEntry(b).entry.screen, "departures");
});

test("the next check-in is the last one plus the sleep it was sent", () => {
  const hallway = device("A3", ["placeholder"]);
  assert.equal(expectedCheckIn(hallway), undefined);
  recordCheckIn(hallway, 300, new Date("2026-10-12T10:00:00Z"));
  assert.deepEqual(expectedCheckIn(hallway), new Date("2026-10-12T10:05:00Z"));
});
