import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHours } from "../src/conditions.ts";
import {
  activePlaylist,
  buttonStep,
  choosePlaylist,
  currentEntry,
  entriesNearby,
  expectedCheckIn,
  lastCheckIn,
  moveOn,
  pressButton,
  recordCheckIn,
} from "../src/device-state.ts";

const fallback = { screen: "placeholder", inputs: {} };
// A device's playlists with only its own
const only = <T>(entries: T[]) => [{ name: "default", entries, offered: true }];
const device = (mac: string, screens: string[]) => ({
  mac,
  username: mac,
  playlists: only(screens.map((screen) => ({ screen, inputs: {} }))),
  defaultScreen: fallback,
  timeZone: "Europe/Berlin",
});

test("a device starts at its first entry and moves on, wrapping around", () => {
  const kitchen = device("A1", ["departures", "journeys", "placeholder"]);
  assert.equal(currentEntry(kitchen).entry.screen, "departures");
  moveOn(kitchen, 1);
  assert.deepEqual(currentEntry(kitchen), {
    entry: kitchen.playlists[0].entries[1],
    index: 1,
    applying: [0, 1, 2],
    untilMove: Infinity,
  });
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

// A playlist whose entries have durations (s), or none for undefined
const timed = (mac: string, durations: (number | undefined)[]) => ({
  mac,
  username: mac,
  playlists: only(
    durations.map((duration, i) => ({
      screen: `s${i}`,
      inputs: {},
      ...(duration === undefined ? {} : { duration }),
    })),
  ),
  defaultScreen: fallback,
  timeZone: "Europe/Berlin",
});
const at = (s: number) => new Date(Date.UTC(2026, 9, 12, 10, 0, s));
const untilMove = (d: ReturnType<typeof timed>, now: Date) => currentEntry(d, now).untilMove;

test("the playlist moves on once an entry's duration is up, the next getting its full duration", () => {
  const d = timed("AA:00:00:00:00:10", [60, 30, undefined]);
  assert.equal(currentEntry(d, at(0)).index, 0);
  assert.equal(untilMove(d, at(0)), 60);
  assert.equal(currentEntry(d, at(59)).index, 0);
  assert.equal(currentEntry(d, at(60)).index, 1);
  assert.equal(untilMove(d, at(60)), 30);
  // Noticed late (due at 90): one step, to the last entry, which has no duration and stays
  assert.equal(currentEntry(d, at(100)).index, 2);
  assert.equal(untilMove(d, at(100)), Infinity);
  assert.equal(currentEntry(d, at(10_000)).index, 2);
});

test("a press gives the entry it moves to its full duration", () => {
  const d = timed("AA:00:00:00:00:11", [60, 60]);
  currentEntry(d, at(0));
  moveOn(d, 1, at(50));
  assert.equal(untilMove(d, at(50)), 60);
  pressButton(d, 1, undefined, at(100));
  assert.equal(currentEntry(d, at(100)).index, 0);
  assert.equal(untilMove(d, at(100)), 60);
});

test("a press after a duration ran out shows that entry, as after the screen page's buttons", () => {
  const d = timed("AA:00:00:00:00:12", [60, 60, 60]);
  currentEntry(d, at(0));
  recordCheckIn(d, 60, 0, at(0));
  // The device still shows 0; its duration is up: a short press shows 1, with its full duration
  pressButton(d, 1, "1", at(70));
  assert.equal(currentEntry(d, at(70)).index, 1);
  assert.equal(untilMove(d, at(70)), 60);
});

test("a playlist of one entry with a duration doesn't move on", () => {
  const d = timed("AA:00:00:00:00:13", [60]);
  currentEntry(d, at(0));
  assert.deepEqual(currentEntry(d, at(600)), {
    entry: d.playlists[0].entries[0],
    index: 0,
    applying: [0],
    untilMove: Infinity,
  });
});

// A playlist whose entries apply at times: `when` texts, or undefined for always
const windows = (
  mac: string,
  whens: (string | undefined)[],
  durations: (number | undefined)[] = [],
) => ({
  mac,
  username: mac,
  playlists: only(
    whens.map((when, i) => ({
      screen: `w${i}`,
      inputs: {},
      ...(when === undefined ? {} : { when: parseHours(when, undefined) }),
      ...(durations[i] === undefined ? {} : { duration: durations[i] }),
    })),
  ),
  defaultScreen: fallback,
  timeZone: "Europe/Berlin",
});
// Thursday 1 Oct 2026, at a time in Berlin
const thu = (time: string) => new Date(`2026-10-01T${time}:00+02:00`);

test("only entries that apply are shown, and Next skips the others", () => {
  const d = windows("AA:00:00:00:00:20", ["Mo-Fr 06:30-09:00", "Sa,Su", undefined]);
  const morning = currentEntry(d, thu("07:00"));
  assert.equal(morning.index, 0);
  assert.deepEqual(morning.applying, [0, 2]);
  // The window ends at 09:00: that's when it moves on by itself
  assert.equal(morning.untilMove, 2 * 3600);
  moveOn(d, 1, thu("07:00"));
  assert.equal(currentEntry(d, thu("07:00")).index, 2);
  moveOn(d, 1, thu("07:00"));
  assert.equal(currentEntry(d, thu("07:00")).index, 0);
});

test("the playlist moves on when the entry's window ends; one starting doesn't interrupt", () => {
  const d = windows("AA:00:00:00:00:21", ["Mo-Fr 06:30-09:00", undefined]);
  // At 06:00 only the second applies
  assert.equal(currentEntry(d, thu("06:00")).index, 1);
  // At 07:00 the morning window has started, but the second entry stays
  assert.equal(currentEntry(d, thu("07:00")).index, 1);
  moveOn(d, 1, thu("07:00"));
  assert.equal(currentEntry(d, thu("07:00")).index, 0);
  // At 09:00 it ends: on to the next that applies
  assert.equal(currentEntry(d, thu("09:00")).index, 1);
});

test("with nothing applying, the default screen until something does", () => {
  const d = windows("AA:00:00:00:00:22", ["Mo-Fr 06:30-09:00", "Sa,Su"]);
  const night = currentEntry(d, thu("03:00"));
  assert.deepEqual([night.index, night.entry, night.applying], [-1, fallback, []]);
  // Woken when the morning window starts
  assert.equal(night.untilMove, 3.5 * 3600);
  // Pressing changes nothing
  moveOn(d, 1, thu("03:00"));
  assert.equal(currentEntry(d, thu("03:00")).index, -1);
  assert.equal(currentEntry(d, thu("06:30")).index, 0);
});

test("a duration only moves on when another entry applies", () => {
  const d = windows("AA:00:00:00:00:23", ["Mo-Fr 06:30-09:00", undefined], [600, 600]);
  currentEntry(d, thu("06:00"));
  // Only the second applies before 06:30: its duration doesn't count until then
  assert.equal(currentEntry(d, thu("06:00")).untilMove, 30 * 60);
  assert.equal(currentEntry(d, thu("06:20")).index, 1);
  // From 06:30 both apply, and its 10 minutes are long up: on to the first
  assert.equal(currentEntry(d, thu("06:31")).index, 0);
});

test("a short press after the default screen shows the entry that started applying", () => {
  const d = windows("AA:00:00:00:00:24", ["Mo-Fr 06:30-09:00", "Mo-Fr 06:30-09:00"]);
  recordCheckIn(d, 60, currentEntry(d, thu("06:00")).index, thu("06:00"));
  // The device was sent the default screen; the window opens, and a press shows the first entry
  pressButton(d, 1, "1", thu("06:31"));
  assert.equal(currentEntry(d, thu("06:31")).index, 0);
});

test("an entry whose condition can't be evaluated is left out for now, not an error", () => {
  const d = windows("AA:00:00:00:00:25", [undefined, undefined]);
  const broken = {
    kind: "hours",
    text: "SH",
    hours: {
      getState: () => {
        throw new Error("no data");
      },
    },
  };
  (d.playlists[0].entries[0] as { when?: unknown }).when = broken;
  const result = currentEntry(d, thu("07:00"));
  assert.deepEqual([result.index, result.applying], [1, [1]]);
});

// A device with its own playlist and two others: `travel`, and `night`, which applies only at night
const switching = (mac: string, offered = true) => ({
  mac,
  username: mac,
  playlists: [
    {
      name: "default",
      entries: [
        { screen: "departures", inputs: {} },
        { screen: "journeys", inputs: {} },
      ],
      offered,
    },
    {
      name: "travel",
      entries: [
        { screen: "map", inputs: {} },
        { screen: "journeys", inputs: {} },
      ],
      offered: true,
    },
    {
      name: "night",
      entries: [{ screen: "clock", inputs: {}, when: parseHours("22:00-06:00", undefined) }],
      offered: true,
    },
  ],
  defaultScreen: fallback,
  timeZone: "Europe/Berlin",
});

test("choosing a playlist starts at its first entry that applies, with its full duration", () => {
  const d = switching("AA:00:00:00:00:30");
  moveOn(d, 1, thu("07:00"));
  choosePlaylist(d, "travel", thu("07:00"));
  assert.equal(activePlaylist(d).name, "travel");
  assert.deepEqual(currentEntry(d, thu("07:00")), {
    entry: d.playlists[1].entries[0],
    index: 0,
    applying: [0, 1],
    untilMove: Infinity,
  });
  // Back: from its first entry again
  choosePlaylist(d, "default", thu("07:00"));
  assert.equal(currentEntry(d, thu("07:00")).entry.screen, "departures");
  // Nothing in it applies: the default screen
  choosePlaylist(d, "night", thu("07:00"));
  assert.equal(currentEntry(d, thu("07:00")).index, -1);
  assert.equal(currentEntry(d, thu("22:00")).entry.screen, "clock");
});

test("only playlists offered can be chosen", () => {
  const d = switching("AA:00:00:00:00:31", false);
  choosePlaylist(d, "nope", thu("07:00"));
  assert.equal(activePlaylist(d).name, "default");
  choosePlaylist(d, "travel", thu("07:00"));
  // The default isn't offered: it's only the default screen
  choosePlaylist(d, "default", thu("07:00"));
  assert.equal(activePlaylist(d).name, "travel");
});

test("after a switch, the entry the device got is looked for in the new playlist", () => {
  const d = switching("AA:00:00:00:00:32");
  moveOn(d, 1, thu("07:00"));
  recordCheckIn(d, 300, currentEntry(d, thu("07:00")).index, thu("07:00"));
  // journeys is in travel too, at index 1
  choosePlaylist(d, "travel", thu("07:01"));
  assert.equal(lastCheckIn(d)?.shown, 1);
  // Not in night: unknown
  choosePlaylist(d, "night", thu("07:02"));
  assert.equal(lastCheckIn(d)?.shown, undefined);
  // The default screen stays itself
  recordCheckIn(d, 300, -1, thu("07:03"));
  choosePlaylist(d, "default", thu("07:04"));
  assert.equal(lastCheckIn(d)?.shown, -1);
});

// A clock, then four maps shuffled
const shuffled = (mac: string) => ({
  mac,
  username: mac,
  playlists: only([
    { screen: "clock", inputs: {} },
    ...["a", "b", "c", "d"].map((title) => ({ screen: "map", inputs: { title }, shuffle: "p[1]" })),
  ]),
  defaultScreen: fallback,
  timeZone: "Europe/Berlin",
});
const titleOf = (d: ReturnType<typeof shuffled>) => {
  const { entry } = currentEntry(d);
  return entry.screen === "map" ? (entry.inputs as { title: string }).title : entry.screen;
};

test("a shuffled playlist plays each entry once a round, the others in their places", () => {
  const d = shuffled("AA:00:00:00:00:40");
  for (let round = 0; round < 5; round++) {
    const seen = [titleOf(d)];
    for (let i = 0; i < 4; i++) {
      moveOn(d, 1);
      seen.push(titleOf(d));
    }
    assert.equal(seen[0], "clock");
    assert.deepEqual(seen.slice(1).sort(), ["a", "b", "c", "d"]);
    moveOn(d, 1);
  }
});

test("Prev retraces the way through a shuffled playlist, also across rounds", () => {
  const d = shuffled("AA:00:00:00:00:41");
  const seen = [titleOf(d)];
  for (let i = 0; i < 7; i++) {
    moveOn(d, 1);
    seen.push(titleOf(d));
  }
  for (let i = 6; i >= 0; i--) {
    moveOn(d, -1);
    assert.equal(titleOf(d), seen[i]);
  }
});

test("the next and previous entries of a shuffled playlist are known ahead, for warming", () => {
  const d = shuffled("AA:00:00:00:00:42");
  // Through a whole round, so the next is in the round after
  for (let i = 0; i < 6; i++) {
    const near = entriesNearby(d);
    assert.equal(near[0], currentEntry(d).entry);
    moveOn(d, 1);
    assert.ok(near.includes(currentEntry(d).entry));
    moveOn(d, -1);
    moveOn(d, -1);
    assert.ok(near.includes(currentEntry(d).entry));
    moveOn(d, 1);
    moveOn(d, 1);
  }
});
