// What the server remembers about each device while it runs, by MAC: where it is in its playlist, and
// when it last checked in. In memory only: after a restart, every device starts at its playlist's
// first entry, and its next check-in is unknown until it checks in.
import type { PlaylistEntry } from "./playlists.ts";

interface DeviceState {
  /** The current playlist entry's index */
  index: number;
  /** The device's last /api/display, how long it was told to sleep (seconds), and the index of the entry it was sent */
  checkIn?: { at: Date; refreshRate: number; shown: number };
  /** The last button press handled: its wake (Wake-Time), and when */
  press?: { wake: string; at: Date };
}

/** What this module needs of a device. */
interface PlaylistDevice {
  mac: string;
  playlist: PlaylistEntry[];
}

const states = new Map<string, DeviceState>();

const stateOf = (device: PlaylistDevice) => {
  let state = states.get(device.mac);
  if (!state) states.set(device.mac, (state = { index: 0 }));
  return state;
};

/** An index moved by `step` entries (1 forward, -1 back) in a list of `length`, wrapping around. */
export const stepIndex = (index: number, length: number, step: number) => (((index + step) % length) + length) % length;

/** The device's current playlist entry, and its position (from 0) in the playlist. */
export function currentEntry(device: PlaylistDevice) {
  const index = stateOf(device).index % device.playlist.length;
  return { entry: device.playlist[index], index };
}

/** Moves the device's playlist on by `step` entries: 1 to the next, -1 to the previous. */
export function moveOn(device: PlaylistDevice, step: number) {
  const state = stateOf(device);
  state.index = stepIndex(state.index, device.playlist.length, step);
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
  const chosen = currentEntry(device).index;
  if (shown === undefined || shown === chosen) return moveOn(device, step);
  // A change from the screen page the device hasn't picked up yet
  if (step < 0) state.index = stepIndex(shown, device.playlist.length, step);
}

/** Records a check-in (/api/display): the refresh_rate the device was sent, and the index of its entry. */
export function recordCheckIn(device: PlaylistDevice, refreshRate: number, shown: number, at = new Date()) {
  stateOf(device).checkIn = { at, refreshRate, shown };
}

/**
 * When the device is expected to check in next: its last check-in plus the time it was told to
 * sleep. Undefined if it hasn't checked in since the server started. A little early in practice:
 * it sleeps after drawing, which takes a few seconds.
 */
export function expectedCheckIn(device: PlaylistDevice) {
  const checkIn = stateOf(device).checkIn;
  return checkIn && new Date(checkIn.at.getTime() + checkIn.refreshRate * 1000);
}

/**
 * The device's last check-in: the playlist entry it was sent (its index), and when the next is
 * expected. Undefined if it hasn't checked in since the server started.
 */
export function lastCheckIn(device: PlaylistDevice) {
  const checkIn = stateOf(device).checkIn;
  return checkIn && { shown: checkIn.shown, next: expectedCheckIn(device)! };
}
