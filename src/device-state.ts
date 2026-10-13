// What the server remembers about each device: which of its playlists it shows (chosen on the screen
// page), where it is in it (and since when, for the entry's `duration`), and when it last checked
// in. Saved across restarts in the device's file (see state-file.ts), read on first need.
//
// The playlist moves through the entries that apply (their `when`, see conditions.ts): on a press,
// when the current entry's `duration` is up, or when it stops applying. A window that starts doesn't
// interrupt the current entry. When none applies, the device shows its default screen. It moves in
// rounds, each entry once: in the playlist's order, except that shuffled entries get a new random
// order each round (see shuffle.ts).
import { applies, earliest, inTimeZone, nextChange } from "./conditions.ts";
import { canonicalKey } from "./define-source.ts";
import type { DevicePlaylist, PlaylistEntry } from "./playlists.ts";
import { fitsRound, inOrder, isShuffled, newRound } from "./shuffle.ts";
import { savedState, stateChanged, type StateDevice } from "./state-file.ts";

interface DeviceState {
  /** The playlist shown: its index in the device's playlists (0 is `default`) */
  playlist: number;
  /** The current playlist entry's index; while none applies, the one shown last */
  index: number;
  /** When the current entry started, for its `duration`: set by each move */
  since?: Date;
  /**
   * The device's last /api/display, how long it was told to sleep (seconds), and the index of the
   * entry it was sent: -1 for the default screen, undefined if unknown (the playlist changed since,
   * across a restart)
   */
  checkIn?: { at: Date; refreshRate: number; shown: number | undefined };
  /** The last button press handled: its wake (Wake-Time), and when */
  press?: { wake: string; at: Date };
  /**
   * For a playlist with shuffled entries: the order of the round being played, and of those either
   * side of it, so the next entry is known ahead (for warming) and going back retraces the way
   */
  rounds?: Rounds;
}

/** Rounds of entries' indices, each entry once in each. */
interface Rounds {
  previous: number[];
  current: number[];
  next: number[];
}

/** What this module needs of a device. */
interface PlaylistDevice extends StateDevice {
  /** `default` first (see playlists.ts) */
  playlists: DevicePlaylist[];
  /** Shown while no entry applies */
  defaultScreen: PlaylistEntry;
  /** Where `when` is evaluated */
  timeZone: string;
}

const states = new Map<string, DeviceState>();

const stateOf = (device: PlaylistDevice) => {
  let state = states.get(device.mac);
  if (!state) states.set(device.mac, (state = restoreDevice(device)));
  return state;
};

/** The playlist the device shows: `default` until the screen page chooses another. */
export const activePlaylist = (device: PlaylistDevice) =>
  device.playlists[stateOf(device).playlist];

// The entries of the playlist the device shows
const entriesOf = (device: PlaylistDevice) => activePlaylist(device).entries;

/** New rounds for a playlist, or none if its order is fixed. */
function startRounds(playlist: PlaylistEntry[]): Rounds | undefined {
  if (!isShuffled(playlist)) return undefined;
  const current = newRound(playlist);
  return {
    previous: newRound(playlist, { before: current }),
    current,
    next: newRound(playlist, { after: current }),
  };
}

/** The rounds the device plays: of a fixed order, the playlist's order each time. */
function roundsOf(device: PlaylistDevice): Rounds {
  const state = stateOf(device);
  if (state.rounds) return state.rounds;
  const order = inOrder(entriesOf(device));
  return { previous: order, current: order, next: order };
}

// Saved state: the playlist shown (by name), its current entry, the rounds of a shuffled one, and the
// last check-in, with each entry saved as its index, screen and inputs. After a restart with a changed playlist, an entry is found
// again by its screen and inputs; one that's gone counts as unknown. A playlist that's gone falls back
// to `default`. Saved rounds that no longer fit the playlist start afresh.
const SECTION = "playlist";

const isObject = (value: unknown): value is Record<string, any> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const saveEntry = (playlist: PlaylistEntry[], index: number) => ({
  index,
  screen: playlist[index].screen,
  inputs: playlist[index].inputs,
});

/** A saved entry's index in the playlist: where it was if it's still there, else where it is now. */
export function findEntry(playlist: PlaylistEntry[], saved: unknown): number | undefined {
  if (!isObject(saved) || typeof saved.screen !== "string") return undefined;
  // Whatever order the inputs are written in
  const inputs = canonicalKey(saved.inputs);
  const same = (entry: PlaylistEntry | undefined) =>
    entry !== undefined && entry.screen === saved.screen && canonicalKey(entry.inputs) === inputs;
  if (Number.isInteger(saved.index) && same(playlist[saved.index])) return saved.index;
  const index = playlist.findIndex(same);
  return index < 0 ? undefined : index;
}

/** A device's state from what was saved: the playlist it showed, if it still has it, and its place there. */
function restoreDevice(device: PlaylistDevice): DeviceState {
  const saved = savedState(device, SECTION);
  const name = isObject(saved) ? saved.playlist : undefined;
  const playlist = Math.max(
    0,
    device.playlists.findIndex((p) => p.name === name),
  );
  return { playlist, ...restoreState(device.playlists[playlist].entries, saved) };
}

/** The place in a playlist from what was saved (anything missing or broken is left out). */
export function restoreState(
  playlist: PlaylistEntry[],
  saved: unknown,
): Omit<DeviceState, "playlist"> {
  const record = isObject(saved) ? saved : {};
  const index = findEntry(playlist, record.entry);
  const old = isObject(record.rounds) ? record.rounds : {};
  const rounds = isShuffled(playlist)
    ? fitsRound(playlist, old.previous) &&
      fitsRound(playlist, old.current) &&
      fitsRound(playlist, old.next)
      ? { previous: old.previous, current: old.current, next: old.next }
      : startRounds(playlist)
    : undefined;
  // Without a saved entry, the first of the round
  const state: Omit<DeviceState, "playlist"> = { index: index ?? rounds?.current[0] ?? 0 };
  if (rounds) state.rounds = rounds;
  // Only for the same entry, wherever it is now: one that's gone starts afresh
  const since = typeof record.since === "string" ? new Date(record.since) : undefined;
  if (index !== undefined && since && !Number.isNaN(since.getTime())) state.since = since;
  const checkIn = record.checkIn;
  const at = isObject(checkIn) && typeof checkIn.at === "string" ? new Date(checkIn.at) : undefined;
  if (at && !Number.isNaN(at.getTime()) && typeof checkIn?.refreshRate === "number") {
    state.checkIn = {
      at,
      refreshRate: checkIn.refreshRate,
      shown: findEntry(playlist, checkIn.shown),
    };
  }
  return state;
}

/** Schedules saving the device's state. */
function changed(device: PlaylistDevice) {
  stateChanged(device, SECTION, () => {
    const { index, since, checkIn, rounds } = stateOf(device);
    const { name, entries: playlist } = activePlaylist(device);
    return {
      playlist: name,
      entry: saveEntry(playlist, index % playlist.length),
      since,
      rounds,
      checkIn: checkIn && {
        at: checkIn.at,
        refreshRate: checkIn.refreshRate,
        // The default screen isn't saved: unknown after a restart
        shown:
          checkIn.shown === undefined || checkIn.shown < 0
            ? undefined
            : saveEntry(playlist, checkIn.shown),
      },
    };
  });
}

// How far ahead to look for a change in whether entries apply; on the default screen, a device
// wakes at least this often to look again
const HORIZON_MS = 24 * 3600 * 1000;
// An entry whose condition can't be evaluated (the library throws, e.g. past its school holiday
// data, or for some windows in the hour repeated when summer time ends) doesn't apply, until then
const RETRY_EVALUATION_MS = 5 * 60 * 1000;

/**
 * Which of the device's entries apply at a time, and when that may next change for each
 * (undefined: not within a day). Without any `when`, all apply, without switching time zones.
 */
export function evaluate(
  device: PlaylistDevice,
  now: Date,
): { applying: boolean[]; changes: (Date | undefined)[] } {
  const playlist = entriesOf(device);
  if (!playlist.some((entry) => entry.when))
    return { applying: playlist.map(() => true), changes: playlist.map(() => undefined) };
  const until = new Date(now.getTime() + HORIZON_MS);
  return inTimeZone(device.timeZone, () => {
    const results = playlist.map(({ when, screen }) => {
      if (!when) return { applies: true, change: undefined };
      try {
        return { applies: applies(when, now), change: nextChange(when, now, until) };
      } catch (error) {
        console.error(
          `Can't tell when ${screen} applies for ${device.username}, leaving it out for now:`,
          error,
        );
        return { applies: false, change: new Date(now.getTime() + RETRY_EVALUATION_MS) };
      }
    });
    return {
      applying: results.map((result) => result.applies),
      changes: results.map((result) => result.change),
    };
  });
}

/**
 * The next applying entry from `index` in a direction (1 or -1), in the order the device plays
 * them, and into which round: `shift` 1 for the next round, -1 for the previous, 0 for this one.
 * Undefined if none applies. With only `index` applying, that's itself, a round on.
 */
function stepApplying(device: PlaylistDevice, index: number, step: number, applying: boolean[]) {
  const { previous, current, next } = roundsOf(device);
  const order = [...previous, ...current, ...next];
  const { length } = current;
  const at = length + current.indexOf(index);
  for (let k = 1; k <= length; k++) {
    const i = at + step * k;
    if (applying[order[i]])
      return { index: order[i], shift: i < length ? -1 : i >= 2 * length ? 1 : 0 };
  }
  return undefined;
}

const secondsUntil = (time: Date | undefined, now: Date) =>
  time ? Math.max(0, Math.ceil((time.getTime() - now.getTime()) / 1000)) : Infinity;

/**
 * What the device shows now: its current playlist entry and its position (from 0) in the playlist,
 * or the default screen (position -1) while no entry applies. Also the positions of the entries
 * that apply, and the seconds until the playlist moves on by itself (Infinity if it doesn't): the
 * end of the entry's `duration` (while it's the only one that applies, not before another may
 * start applying) or of its `when`; for the default screen, when an entry may start applying.
 */
export function currentEntry(device: PlaylistDevice, now = new Date()) {
  const { applying, changes } = evaluate(device, now);
  moveOnIfDue(device, now, applying);
  const state = stateOf(device);
  const playlist = entriesOf(device);
  const index = state.index % playlist.length;
  // In the order of the round, for the page's position ("2/3")
  const applyingIndices = roundsOf(device).current.filter((i) => applying[i]);
  if (!applying[index]) {
    const check = earliest(changes) ?? new Date(now.getTime() + HORIZON_MS);
    return {
      entry: device.defaultScreen,
      index: -1,
      applying: applyingIndices,
      untilMove: secondsUntil(check, now),
    };
  }
  const entry = playlist[index];
  // Worked out together with the entry, so a move by another request later can't mix the two up
  let durationEnd =
    entry.duration !== undefined && state.since
      ? new Date(state.since.getTime() + entry.duration * 1000)
      : undefined;
  if (durationEnd && applyingIndices.length === 1) {
    // Alone, its duration only counts once another entry applies too
    const others = earliest(changes.filter((_change, i) => i !== index));
    durationEnd = others && (others > durationEnd ? others : durationEnd);
  }
  return {
    entry,
    index,
    applying: applyingIndices,
    untilMove: secondsUntil(earliest([durationEnd, changes[index]]), now),
  };
}

/**
 * Moves on once the current entry's `duration` is up, or it no longer applies (or, from the
 * default screen, once one applies): to the next entry that applies, which gets its full
 * duration from now, however late this is noticed (e.g. after the device was offline).
 */
function moveOnIfDue(device: PlaylistDevice, now: Date, applying: boolean[]) {
  const state = stateOf(device);
  const playlist = entriesOf(device);
  const index = state.index % playlist.length;
  if (!applying[index]) {
    const next = stepApplying(device, index, 1, applying);
    if (next !== undefined) moveTo(device, next, now);
    return;
  }
  const { duration } = playlist[index];
  if (duration === undefined) return;
  if (!state.since) {
    // E.g. the first time, or after a restart with a changed playlist
    state.since = now;
    changed(device);
  } else if (now.getTime() >= state.since.getTime() + duration * 1000) {
    // The only one that applies stays (as if it had no duration)
    const next = stepApplying(device, index, 1, applying);
    if (next !== undefined && next.index !== index) moveTo(device, next, now);
  }
}

/** Shows an entry from now on, with its full duration, in the round `shift` from this one. */
function moveTo(
  device: PlaylistDevice,
  { index, shift = 0 }: { index: number; shift?: number },
  now: Date,
) {
  const state = stateOf(device);
  const { rounds } = state;
  if (rounds && shift !== 0) {
    const playlist = entriesOf(device);
    state.rounds =
      shift > 0
        ? {
            previous: rounds.current,
            current: rounds.next,
            next: newRound(playlist, { after: rounds.next }),
          }
        : {
            previous: newRound(playlist, { before: rounds.previous }),
            current: rounds.previous,
            next: rounds.current,
          };
  }
  state.index = index;
  state.since = now;
  changed(device);
}

/**
 * What the device shows now and what one press would show (the next and previous entries that
 * apply), for warming their data.
 */
export function entriesNearby(device: PlaylistDevice, now = new Date()): PlaylistEntry[] {
  const { entry, index } = currentEntry(device, now);
  if (index < 0) return [entry];
  // The ones either side of it, in the order it plays
  const { applying } = evaluate(device, now);
  const near = new Set([
    index,
    stepApplying(device, index, 1, applying)?.index ?? index,
    stepApplying(device, index, -1, applying)?.index ?? index,
  ]);
  const playlist = entriesOf(device);
  return [...near].map((i) => playlist[i]);
}

/**
 * Moves the device's playlist on by `step` entries that apply: 1 to the next, -1 to the
 * previous. The entry moved to gets its full duration. Nothing happens while none applies.
 */
export function moveOn(device: PlaylistDevice, step: number, now = new Date()) {
  const { index } = currentEntry(device, now);
  if (index < 0) return;
  const { applying } = evaluate(device, now);
  moveTo(device, stepApplying(device, index, step, applying) ?? { index }, now);
}

/**
 * Switches the device to another of its playlists, by name (only those the screen page offers),
 * starting at its first entry that applies, with its full duration. The entry the device was sent
 * is looked for in the new playlist, so the page still knows whether its preview is live: the
 * default screen stays itself, another entry is unknown unless it's in the new playlist too.
 */
export function choosePlaylist(device: PlaylistDevice, name: string, now = new Date()) {
  const state = stateOf(device);
  const chosen = device.playlists.findIndex(
    (playlist) => playlist.name === name && playlist.offered,
  );
  if (chosen < 0 || chosen === state.playlist) return;
  const { checkIn } = state;
  if (checkIn?.shown !== undefined && checkIn.shown >= 0) {
    checkIn.shown = findEntry(
      device.playlists[chosen].entries,
      saveEntry(entriesOf(device), checkIn.shown),
    );
  }
  state.playlist = chosen;
  state.rounds = startRounds(entriesOf(device));
  // The first entry of the round, or if it doesn't apply, the next that does (see moveOnIfDue)
  moveTo(device, { index: roundsOf(device).current[0] }, now);
}

// What woke the device when it was the button (KEY3 on the 7.5" DIY kit), by chip: Update-Source is the
// ESP-IDF wake cause, "EXT0" on the S3 build, "EXT1" on an ESP32, "button" (GPIO) on the C3-based OG
const BUTTON_WAKES = ["EXT0", "EXT1", "button"];

/**
 * How far a check-in moves the playlist, from its headers: back one for the button's special
 * function (a double click or a 1–5 s hold, sent as special_function: true), on one for a short
 * press (a wake by the button), otherwise not at all.
 */
export function buttonStep(updateSource: string | undefined, specialFunction: string | undefined) {
  if (specialFunction === "true") return -1;
  return updateSource !== undefined && BUTTON_WAKES.includes(updateSource) ? 1 : 0;
}

// The firmware retries a failed /api/display (an HTTP error or a 15 s timeout) up to 5 times, 2 s
// apart: within this time, a request from the same wake is a retry
const RETRY_WINDOW_MS = 2 * 60 * 1000;

/**
 * Moves the playlist for a button press, from the entry the device shows: if the screen page changed
 * the entry since the device's last check-in, a short press shows the entry chosen there, and going
 * back is from the entry on the device. Once per wake: retries repeat the press's headers. `wake`
 * is the Wake-Time header (how long the device's previous wake took, in ms), the same in a wake's
 * retries but almost never in two wakes; without it, every request counts.
 */
export function pressButton(
  device: PlaylistDevice,
  step: number,
  wake: string | undefined,
  at = new Date(),
) {
  const state = stateOf(device);
  const last = state.press;
  if (wake && last?.wake === wake && at.getTime() - last.at.getTime() < RETRY_WINDOW_MS) return;
  if (wake) state.press = { wake, at };
  const shown = state.checkIn?.shown;
  const chosen = currentEntry(device, at).index;
  if (shown === undefined || chosen < 0 || shown === chosen || (shown < 0 && step < 0))
    return moveOn(device, step, at);
  // A change the device hasn't picked up yet (from the screen page, or a duration or window that
  // ended): a short press shows that entry, going back is from the device's; either gets its full
  // duration
  // (From the default screen, a short press shows the entry that started applying since)
  const back =
    step < 0 ? stepApplying(device, shown, -1, evaluate(device, at).applying) : undefined;
  moveTo(device, back ?? { index: chosen }, at);
}

/** Records a check-in (/api/display): the refresh_rate the device was sent, and the index of its entry. */
export function recordCheckIn(
  device: PlaylistDevice,
  refreshRate: number,
  shown: number,
  at = new Date(),
) {
  stateOf(device).checkIn = { at, refreshRate, shown };
  changed(device);
}

/**
 * When the device is expected to check in next: its last check-in plus the time it was told to
 * sleep. Undefined if it has never checked in. A little early in practice:
 * it sleeps after drawing, which takes a few seconds.
 */
export function expectedCheckIn(device: PlaylistDevice) {
  const checkIn = stateOf(device).checkIn;
  return checkIn && new Date(checkIn.at.getTime() + checkIn.refreshRate * 1000);
}

/**
 * The device's last check-in: the playlist entry it was sent (its index, if known), and when the
 * next is expected. Undefined if it has never checked in.
 */
export function lastCheckIn(device: PlaylistDevice) {
  const checkIn = stateOf(device).checkIn;
  return checkIn && { shown: checkIn.shown, next: expectedCheckIn(device)! };
}
