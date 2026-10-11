import assert from "node:assert/strict";
import { test } from "node:test";
import { buttonStep, currentEntry, expectedCheckIn, moveOn, pressButton, recordCheckIn, stepIndex } from "../src/device-state.ts";

const device = (mac: string, screens: string[]) => ({ mac, username: mac, playlist: screens.map((screen) => ({ screen, inputs: {} })) });

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
  recordCheckIn(hallway, 300, 0, new Date("2026-10-12T10:00:00Z"));
  assert.deepEqual(expectedCheckIn(hallway), new Date("2026-10-12T10:05:00Z"));
});

test("KEY3: a short press moves on, the special function back, other wakes not at all", () => {
  assert.equal(buttonStep("EXT0", undefined), 1);
  assert.equal(buttonStep("EXT1", undefined), 1);
  assert.equal(buttonStep("button", undefined), 1);
  assert.equal(buttonStep("button", "true"), -1);
  assert.equal(buttonStep("timer", undefined), 0);
  assert.equal(buttonStep(undefined, undefined), 0);
});

test("KEY3: headers that don't mean a press", () => {
  assert.equal(buttonStep("powercycle", undefined), 0);
  assert.equal(buttonStep("EXT0", "false"), 1);
  assert.equal(buttonStep("EXT0", "true"), -1);
});

test("a press moves the playlist once, though the firmware retries the request", () => {
  const d = device("AA:00:00:00:00:05", ["a", "b", "c"]);
  const at = new Date("2026-10-12T10:00:00Z");
  pressButton(d, 1, "8123", at);
  pressButton(d, 1, "8123", new Date(at.getTime() + 17_000));
  assert.equal(currentEntry(d).index, 1);
  // Another wake, or the same Wake-Time much later, is another press
  pressButton(d, 1, "7950", new Date(at.getTime() + 60_000));
  pressButton(d, 1, "7950", new Date(at.getTime() + 60 * 60_000));
  assert.equal(currentEntry(d).index, 0);
  // Without Wake-Time, every request counts
  pressButton(d, -1, undefined, at);
  pressButton(d, -1, undefined, at);
  assert.equal(currentEntry(d).index, 1);
});

test("a press after Next on the screen page shows the entry chosen there", () => {
  const d = device("AA:00:00:00:00:06", ["a", "b", "c", "d"]);
  recordCheckIn(d, 300, 0);
  moveOn(d, 1);
  moveOn(d, 1);
  // The device still shows a: a short press shows c, as chosen on the page
  pressButton(d, 1, "1");
  assert.equal(currentEntry(d).entry.screen, "c");
  recordCheckIn(d, 300, 2);
  pressButton(d, 1, "2");
  assert.equal(currentEntry(d).entry.screen, "d");
  recordCheckIn(d, 300, 3);
  // Going back is from the entry the device shows (d), not the one chosen on the page (a)
  moveOn(d, 1);
  pressButton(d, -1, "3");
  assert.equal(currentEntry(d).entry.screen, "c");
});

test("a press: a retry after the page's choice stays put, back from the device's entry, no check-in yet", () => {
  const d = device("AA:00:00:00:00:07", ["a", "b", "c", "d"]);
  // No check-in recorded: a press moves from the current entry
  pressButton(d, 1, "1");
  assert.equal(currentEntry(d).entry.screen, "b");
  recordCheckIn(d, 300, 1);
  moveOn(d, 1);
  moveOn(d, 1);
  // The device shows b, the page chose d: a short press shows d, and its retry doesn't move on
  pressButton(d, 1, "2");
  pressButton(d, 1, "2");
  assert.equal(currentEntry(d).entry.screen, "d");
  // Back is from b, the device's entry
  pressButton(d, -1, "3");
  assert.equal(currentEntry(d).entry.screen, "a");
});
