// What the server remembers about devices across restarts: one JSON file per device, named after its
// username (e.g. state/kitchen.json, so renaming a device starts it afresh), with its MAC and a
// section per module (its playlist position and check-in, its telemetry). A device's
// file is read once, on first need; written after changes, at most once a second, to a temporary
// file renamed over the old one, so a crash mid-write can't leave half a file.
//
// Only the server saves state (see persistTo): without it, as in tests and the dev server, the
// modules keep everything in memory as before.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WRITE_DELAY_MS = 1000;
const RETRY_DELAY_MS = 60_000;

/** One device's file. */
export class StateFile {
  /** The file's sections, read on first need */
  private data: Record<string, unknown> | undefined;
  /** The file exists but couldn't be read (e.g. no permission): left alone rather than replaced */
  private unreadable = false;
  /** How each section changed since the last write is saved */
  private readonly savers = new Map<string, () => unknown>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly path: string) {}

  /** A section as saved, or undefined if there is none. */
  saved(section: string): unknown {
    return this.read()[section];
  }

  /** Schedules a write: call after each change, with how to save the section. */
  changed(section: string, save: () => unknown) {
    this.savers.set(section, save);
    this.timer ??= setTimeout(() => this.flush(), WRITE_DELAY_MS);
  }

  /** Writes pending changes now (also when the server stops). */
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.savers.size === 0) return;
    const data = this.read();
    if (this.unreadable) return;
    for (const [section, save] of this.savers) data[section] = save();
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(`${this.path}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
      renameSync(`${this.path}.tmp`, this.path);
      this.savers.clear();
    } catch (error) {
      // Tried again later, e.g. once the disk has space again
      console.error(`Could not save ${this.path}: ${(error as Error).message}`);
      this.timer = setTimeout(() => this.flush(), RETRY_DELAY_MS);
    }
  }

  private read() {
    if (this.data) return this.data;
    this.data = {};
    let text;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      // No file yet is normal; one that can't be read is left alone, so its other sections survive
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`Can't read ${this.path}, not saving it: ${(error as Error).message}`);
        this.unreadable = true;
      }
      return this.data;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not a JSON object");
      this.data = parsed as Record<string, unknown>;
    } catch (error) {
      // A broken file is replaced at the next write
      console.error(`Ignoring ${this.path}, starting afresh: ${(error as Error).message}`);
    }
    return this.data;
  }
}

/** What saving state needs of a device. */
export interface StateDevice {
  mac: string;
  username: string;
}

let stateDir: string | undefined;
// By username
const files = new Map<string, StateFile>();

/** Saves state in `dir` from now on. */
export function persistTo(dir: URL) {
  stateDir = fileURLToPath(dir);
}

/**
 * Where state is saved, if it is: also for what else should survive a restart or deploy, such as
 * drawn maps (see sources/map.ts).
 */
export const stateDirectory = () => stateDir;

/** Writes pending changes now: when the server stops. */
export function flushState() {
  for (const file of files.values()) file.flush();
}

/**
 * The device's file, if state is saved: e.g. state/kitchen.json. Usernames can be any text, so
 * they're encoded as in a URL ("a/b" → "a%2Fb").
 */
function fileFor({ username }: StateDevice) {
  if (!stateDir) return undefined;
  let file = files.get(username);
  if (!file) files.set(username, (file = new StateFile(join(stateDir, `${encodeURIComponent(username)}.json`))));
  return file;
}

/** A section of the device's saved state, or undefined if there is none or state isn't saved. */
export const savedState = (device: StateDevice, section: string) => fileFor(device)?.saved(section);

/**
 * Schedules saving a section of the device's state, if state is saved: call after each change.
 * The file also gets the device's MAC, to show which hardware it belongs to.
 */
export function stateChanged(device: StateDevice, section: string, save: () => unknown) {
  const file = fileFor(device);
  file?.changed("mac", () => device.mac);
  file?.changed(section, save);
}
