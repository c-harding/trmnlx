// What the server remembers about each device: where it is in its playlist (and since when, for the
// entry's `duration`), and when it last checked in. Saved across restarts in the device's file (see state-file.ts), read on first need.
import type { PlaylistEntry } from "./playlists.ts";
import { canonicalKey } from "./define-source.ts";
import { savedState, stateChanged, type StateDevice } from "./state-file.ts";

interface DeviceState {
  /** The current playlist entry's index */
  index: number;
  /** When the current entry started, for its `duration`: set by each move */
  since?: Date;
  /**
   * The device's last /api/display, how long it was told to sleep (seconds), and the index of the
   * entry it was sent (unknown if the playlist changed since, across a restart)
   */
  checkIn?: { at: Date; refreshRate: number; shown: number | undefined };
  /** The last button press handled: its wake (Wake-Time), and when */
  press?: { wake: string; at: Date };
}

/** What this module needs of a device. */
interface PlaylistDevice extends StateDevice {
  playlist: PlaylistEntry[];
}

const states = new Map<string, DeviceState>();

const stateOf = (device: PlaylistDevice) => {
  let state = states.get(device.mac);
  if (!state) states.set(device.mac, (state = restoreState(device.playlist, savedState(device, SECTION))));
  return state;
};

// Saved state: the current entry and the last check-in, with each entry saved
// as its index, screen and inputs. After a restart with a changed playlist, an entry is found again
// by its screen and inputs; one that's gone counts as unknown.
const SECTION = "playlist";

interface SavedEntry extends PlaylistEntry {
  index: number;
}

const isObject = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value);

const saveEntry = (playlist: PlaylistEntry[], index: number): SavedEntry => ({ index, ...playlist[index] });

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

/** A device's state from what was saved (anything missing or broken is left out). */
export function restoreState(playlist: PlaylistEntry[], saved: unknown): DeviceState {
  const record = isObject(saved) ? saved : {};
  const index = findEntry(playlist, record.entry);
  const state: DeviceState = { index: index ?? 0 };
  // Only for the same entry, wherever it is now: one that's gone starts afresh
  const since = typeof record.since === "string" ? new Date(record.since) : undefined;
  if (index !== undefined && since && !Number.isNaN(since.getTime())) state.since = since;
  const checkIn = record.checkIn;
  const at = isObject(checkIn) && typeof checkIn.at === "string" ? new Date(checkIn.at) : undefined;
  if (at && !Number.isNaN(at.getTime()) && typeof checkIn?.refreshRate === "number") {
    state.checkIn = { at, refreshRate: checkIn.refreshRate, shown: findEntry(playlist, checkIn.shown) };
  }
  return state;
}

/** Schedules saving the device's state. */
function changed(device: PlaylistDevice) {
  const { playlist } = device;
  stateChanged(device, SECTION, () => {
    const { index, since, checkIn } = stateOf(device);
    return {
      entry: saveEntry(playlist, index % playlist.length),
      since,
      checkIn: checkIn && {
        at: checkIn.at,
        refreshRate: checkIn.refreshRate,
        shown: checkIn.shown === undefined ? undefined : saveEntry(playlist, checkIn.shown),
      },
    };
  });
}

/** An index moved by `step` entries (1 forward, -1 back) in a list of `length`, wrapping around. */
export const stepIndex = (index: number, length: number, step: number) => (((index + step) % length) + length) % length;

/**
 * The device's current playlist entry, its position (from 0) in the playlist, and the seconds
 * until the playlist moves on by itself (Infinity if it doesn't).
 */
export function currentEntry(device: PlaylistDevice, now = new Date()) {
  moveOnIfDue(device, now);
  const state = stateOf(device);
  const index = state.index % device.playlist.length;
  const entry = device.playlist[index];
  // Worked out together with the entry, so a move by another request later can't mix the two up
  const untilMove =
    entry.duration === undefined || !state.since || device.playlist.length === 1
      ? Infinity
      : Math.max(0, Math.ceil((state.since.getTime() + entry.duration * 1000 - now.getTime()) / 1000));
  return { entry, index, untilMove };
}

/**
 * Moves on to the next entry once the current one's `duration` is up: the next then gets its full
 * duration from now, however late this is noticed (e.g. after the device was offline). Without a
 * duration, or with nothing else to move to, the entry stays until a press.
 */
function moveOnIfDue(device: PlaylistDevice, now: Date) {
  const state = stateOf(device);
  const { duration } = device.playlist[state.index % device.playlist.length];
  if (duration === undefined || device.playlist.length === 1) return;
  if (!state.since) {
    // E.g. the first time, or after a restart with a changed playlist
    state.since = now;
    changed(device);
  } else if (now.getTime() >= state.since.getTime() + duration * 1000) {
    moveOn(device, 1, now);
  }
}


/** Moves the device's playlist on by `step` entries: 1 to the next, -1 to the previous. */
export function moveOn(device: PlaylistDevice, step: number, now = new Date()) {
  const state = stateOf(device);
  state.index = stepIndex(state.index, device.playlist.length, step);
  // The entry moved to gets its full duration
  state.since = now;
  changed(device);
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
export function pressButton(device: PlaylistDevice, step: number, wake: string | undefined, at = new Date()) {
  const state = stateOf(device);
  const last = state.press;
  if (wake && last?.wake === wake && at.getTime() - last.at.getTime() < RETRY_WINDOW_MS) return;
  if (wake) state.press = { wake, at };
  const shown = state.checkIn?.shown;
  const chosen = currentEntry(device, at).index;
  if (shown === undefined || shown === chosen) return moveOn(device, step, at);
  // A change the device hasn't picked up yet (from the screen page, or a duration that ran out):
  // a short press shows that entry, going back is from the device's; either gets its full duration
  if (step < 0) state.index = stepIndex(shown, device.playlist.length, step);
  state.since = at;
  changed(device);
}

/** Records a check-in (/api/display): the refresh_rate the device was sent, and the index of its entry. */
export function recordCheckIn(device: PlaylistDevice, refreshRate: number, shown: number, at = new Date()) {
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
