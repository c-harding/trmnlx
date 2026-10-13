import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  activePlaylist,
  choosePlaylist,
  currentEntry,
  findEntry,
  restoreState,
} from "../src/device-state.ts";
import { flushState, persistTo, StateFile } from "../src/state-file.ts";
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
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      playlist: { index: 1 },
      telemetry: { rssi: -60 },
    });
    // Read once: a section saved later replaces only itself
    const again = new StateFile(path);
    assert.deepEqual(again.saved("telemetry"), { rssi: -60 });
    again.changed("playlist", () => ({ index: 2 }));
    again.flush();
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      playlist: { index: 2 },
      telemetry: { rssi: -60 },
    });
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
  const playlist = [
    entry("mvg-departures", { station: "Marienplatz" }),
    entry("journeys"),
    entry("mvg-departures", { station: "Ostbahnhof" }),
  ];
  assert.equal(findEntry(playlist, { index: 2, ...playlist[2] }), 2);
  // Reordered: found by screen and inputs
  assert.equal(findEntry(playlist, { index: 0, ...playlist[2] }), 2);
  assert.equal(
    findEntry(playlist, { index: 1, ...entry("mvg-departures", { station: "Marienplatz" }) }),
    0,
  );
  // Inputs written in another order
  assert.equal(
    findEntry([entry("journeys", { count: 3, rules: "deny:longdistance" })], {
      index: 0,
      ...entry("journeys", { rules: "deny:longdistance", count: 3 }),
    }),
    0,
  );
  // Gone, or not an entry
  assert.equal(findEntry(playlist, { index: 0, ...entry("departures") }), undefined);
  assert.equal(findEntry(playlist, "journeys"), undefined);
});

test("a device's state comes back from what was saved", () => {
  const playlist = [entry("mvg-departures"), entry("journeys")];
  const saved = JSON.parse(
    JSON.stringify({
      entry: { index: 1, ...playlist[1] },
      checkIn: {
        at: new Date("2026-10-12T10:00:00Z"),
        refreshRate: 300,
        shown: { index: 0, ...playlist[0] },
      },
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
  assert.deepEqual(restoreState(playlist, { entry: 3, checkIn: { at: "yesterday" } }), {
    index: 0,
  });
});

test("telemetry comes back from what was saved", () => {
  const saved = JSON.parse(
    JSON.stringify({
      batteryVoltage: 3.9,
      rssi: -60,
      firmwareVersion: "1.6.2",
      charging: false,
      seenAt: new Date("2026-10-12T10:00:00Z"),
    }),
  );
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
  assert.deepEqual(restoreState(playlist, { entry: { index: 1, ...playlist[1] }, since }), {
    index: 1,
    since: new Date(since),
  });
  // Its entry moved: found there, with its start time
  assert.deepEqual(
    restoreState([entry("journeys"), entry("mvg-departures")], {
      entry: { index: 1, ...playlist[1] },
      since,
    }),
    {
      index: 0,
      since: new Date(since),
    },
  );
  // Its entry is gone: the first entry starts afresh
  assert.deepEqual(
    restoreState([entry("placeholder")], { entry: { index: 1, ...playlist[1] }, since }),
    { index: 0 },
  );
  assert.deepEqual(restoreState(playlist, { entry: { index: 1, ...playlist[1] }, since: "soon" }), {
    index: 1,
  });
});

test("the playlist chosen comes back by name; one that's gone falls back to default", () => {
  const dir = mkdtempSync(join(tmpdir(), "trmnl-state-"));
  try {
    persistTo(pathToFileURL(`${dir}/`));
    const device = (username: string) => ({
      mac: username,
      username,
      playlists: [
        { name: "default", entries: [entry("mvg-departures"), entry("journeys")], offered: true },
        { name: "travel", entries: [entry("map"), entry("journeys")], offered: true },
      ],
      defaultScreen: entry("placeholder"),
      timeZone: "Europe/Berlin",
    });
    writeFileSync(
      join(dir, "kitchen.json"),
      JSON.stringify({
        playlist: { playlist: "travel", entry: { index: 1, ...entry("journeys") } },
      }),
    );
    writeFileSync(
      join(dir, "hallway.json"),
      JSON.stringify({ playlist: { playlist: "gone", entry: { index: 1, ...entry("journeys") } } }),
    );
    const kitchen = device("kitchen");
    assert.equal(activePlaylist(kitchen).name, "travel");
    assert.equal(currentEntry(kitchen).index, 1);
    // The saved entry is looked for in default
    const hallway = device("hallway");
    assert.equal(activePlaylist(hallway).name, "default");
    assert.equal(currentEntry(hallway).index, 1);
    choosePlaylist(hallway, "travel");
    flushState();
    const saved = JSON.parse(readFileSync(join(dir, "hallway.json"), "utf8")).playlist;
    assert.deepEqual([saved.playlist, saved.entry], ["travel", { index: 0, ...entry("map") }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a shuffled playlist's rounds come back if they still fit, else start afresh", () => {
  const playlist = [
    entry("clock"),
    ...["a", "b", "c"].map((title) => ({ ...entry("map", { title }), shuffle: "p[1]" })),
  ];
  const rounds = { previous: [0, 2, 1, 3], current: [0, 3, 1, 2], next: [0, 1, 3, 2] };
  assert.deepEqual(restoreState(playlist, { entry: { index: 3, ...playlist[3] }, rounds }), {
    index: 3,
    rounds,
  });
  // The clock moved: these rounds don't fit any more
  const fresh = restoreState(playlist, { rounds: { ...rounds, current: [3, 0, 1, 2] } });
  assert.notDeepEqual(fresh.rounds, rounds);
  assert.equal(fresh.rounds?.current[0], 0);
  // Without a saved entry, it starts at the round's first
  assert.equal(fresh.index, 0);
  // A playlist without shuffled entries has none
  assert.equal(restoreState([entry("clock")], { rounds }).rounds, undefined);
});
