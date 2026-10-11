import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findEntry, restoreState } from "../src/device-state.ts";
import { StateFile } from "../src/state-file.ts";
import { restoreTelemetry } from "../src/telemetry.ts";

const entry = (screen: string, inputs: Record<string, unknown> = {}) => ({ screen, inputs });

test("a state file keeps its sections, written on flush", () => {
  const dir = mkdtempSync(join(tmpdir(), "trmnl-state-"));
  try {
    const path = join(dir, "state", "AA-BB.json");
    const file = new StateFile(path);
    assert.equal(file.saved("playlist"), undefined);
    file.changed("playlist", () => ({ index: 1 }));
    file.changed("telemetry", () => ({ rssi: -60 }));
    file.flush();
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { playlist: { index: 1 }, telemetry: { rssi: -60 } });
    // Read once: a section saved later replaces only itself
    const again = new StateFile(path);
    assert.deepEqual(again.saved("telemetry"), { rssi: -60 });
    again.changed("playlist", () => ({ index: 2 }));
    again.flush();
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { playlist: { index: 2 }, telemetry: { rssi: -60 } });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("a broken state file is ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "trmnl-state-"));
  try {
    const path = join(dir, "AA-BB.json");
    writeFileSync(path, "{ not json");
    assert.equal(new StateFile(path).saved("playlist"), undefined);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("a saved entry is found where it was, or where it moved to", () => {
  const playlist = [entry("mvg-departures", { station: "Marienplatz" }), entry("journeys"), entry("mvg-departures", { station: "Ostbahnhof" })];
  assert.equal(findEntry(playlist, { index: 2, ...playlist[2] }), 2);
  // Reordered: found by screen and inputs
  assert.equal(findEntry(playlist, { index: 0, ...playlist[2] }), 2);
  assert.equal(findEntry(playlist, { index: 1, ...entry("mvg-departures", { station: "Marienplatz" }) }), 0);
  // Inputs written in another order
  assert.equal(findEntry([entry("journeys", { count: 3, rules: "deny:longdistance" })], { index: 0, ...entry("journeys", { rules: "deny:longdistance", count: 3 }) }), 0);
  // Gone, or not an entry
  assert.equal(findEntry(playlist, { index: 0, ...entry("departures") }), undefined);
  assert.equal(findEntry(playlist, "journeys"), undefined);
});

test("a device's state comes back from what was saved", () => {
  const playlist = [entry("mvg-departures"), entry("journeys")];
  const saved = JSON.parse(
    JSON.stringify({
      entry: { index: 1, ...playlist[1] },
      checkIn: { at: new Date("2026-10-12T10:00:00Z"), refreshRate: 300, shown: { index: 0, ...playlist[0] } },
    }),
  );
  assert.deepEqual(restoreState(playlist, saved), {
    index: 1,
    checkIn: { at: new Date("2026-10-12T10:00:00Z"), refreshRate: 300, shown: 0 },
  });
  // The entry it was sent is gone: the check-in stays, what it shows is unknown
  assert.deepEqual(restoreState([entry("journeys")], saved), {
    index: 0,
    checkIn: { at: new Date("2026-10-12T10:00:00Z"), refreshRate: 300, shown: undefined },
  });
  // Nothing, or something broken, saved: the first entry
  assert.deepEqual(restoreState(playlist, undefined), { index: 0 });
  assert.deepEqual(restoreState(playlist, { entry: 3, checkIn: { at: "yesterday" } }), { index: 0 });
});

test("telemetry comes back from what was saved", () => {
  const saved = JSON.parse(JSON.stringify({ batteryVoltage: 3.9, rssi: -60, firmwareVersion: "1.6.2", charging: false, seenAt: new Date("2026-10-12T10:00:00Z") }));
  assert.deepEqual(restoreTelemetry(saved), {
    batteryVoltage: 3.9,
    rssi: -60,
    firmwareVersion: "1.6.2",
    charging: false,
    usbConnected: undefined,
    seenAt: new Date("2026-10-12T10:00:00Z"),
  });
  assert.equal(restoreTelemetry({ rssi: -60 }), undefined);
  assert.equal(restoreTelemetry(undefined), undefined);
});

test("when the current entry started comes back only for the same entry", () => {
  const playlist = [entry("mvg-departures"), entry("journeys")];
  const since = "2026-10-12T10:00:00.000Z";
  assert.deepEqual(restoreState(playlist, { entry: { index: 1, ...playlist[1] }, since }), { index: 1, since: new Date(since) });
  // Its entry moved: found there, with its start time
  assert.deepEqual(restoreState([entry("journeys"), entry("mvg-departures")], { entry: { index: 1, ...playlist[1] }, since }), {
    index: 0,
    since: new Date(since),
  });
  // Its entry is gone: the first entry starts afresh
  assert.deepEqual(restoreState([entry("placeholder")], { entry: { index: 1, ...playlist[1] }, since }), { index: 0 });
  assert.deepEqual(restoreState(playlist, { entry: { index: 1, ...playlist[1] }, since: "soon" }), { index: 1 });
});
