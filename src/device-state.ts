// What the server remembers about each device while it runs, by MAC: where it is in its playlist, and
// when it last checked in. In memory only: after a restart, every device starts at its playlist's
// first entry, and its next check-in is unknown until it checks in.
import type { PlaylistEntry } from "./playlists.ts";

interface DeviceState {
  /** The current playlist entry's index */
  index: number;
  /** The device's last /api/display, and how long it was told to sleep (seconds) */
  checkIn?: { at: Date; refreshRate: number };
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

/** Records a check-in (/api/display) and the refresh_rate the device was sent. */
export function recordCheckIn(device: PlaylistDevice, refreshRate: number, at = new Date()) {
  stateOf(device).checkIn = { at, refreshRate };
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
