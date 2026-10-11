// Playlists from devices.yaml: what a device shows, as a list of entries, each a screen with its
// inputs. Named playlists (top-level `playlists`) can be used by devices and included in each other,
// as `playlist: <name>` or just `<name>`; includes are expanded here, so a device ends up with one
// flat list.
//
// Plain functions that throw a ConfigError, so config.ts can report it and stop, and tests can call
// them with made-up screens.
import { matchesInput, type InputDefinitions } from "./define-screen.ts";

/** One screen with its inputs (values as written in devices.yaml, checked against the screen's). */
export interface PlaylistEntry {
  screen: string;
  inputs: Record<string, unknown>;
  /** How long it stays before the playlist moves on (s); without it, until a press */
  duration?: number;
}

export class ConfigError extends Error {}

/** The screens there are, with their input definitions: all that checking a playlist needs. */
export type ScreenInputs = Record<string, InputDefinitions>;

// Planned (see ARCHITECTURE.md), but not built yet: rejected rather than silently ignored
const NOT_YET = ["when"];

// A device wakes at most every 5 seconds, and a playlist moving faster than the screen page polls
// would skip entries there
const MIN_DURATION = 10;

/** Seconds from a duration such as `90s`, `10m`, `1h` or `1h30m`, at least MIN_DURATION. */
export function parseDuration(value: unknown, where: string): number {
  const match = typeof value === "string" ? /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value.replaceAll(" ", "")) : null;
  const seconds = match ? (Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) : 0;
  if (!match || seconds === 0) throw new ConfigError(`${where} must be a duration such as 90s, 10m, 1h or 1h30m`);
  if (seconds < MIN_DURATION) throw new ConfigError(`${where} must be at least ${MIN_DURATION}s`);
  return seconds;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function describe(value: unknown): string {
  if (value === null) return "empty";
  if (!Array.isArray(value)) return `a ${typeof value}`;
  // A list: say what's wrong in it, e.g. a hide rule written as a bare number
  const i = value.findIndex((item) => typeof item !== "string");
  return i < 0 ? "a list" : `a list with ${describe(value[i])} at position ${i + 1}`;
}

function checkFields(entry: Record<string, unknown>, allowed: string[], where: string, notYet = NOT_YET) {
  for (const field of Object.keys(entry)) {
    if (notYet.includes(field)) throw new ConfigError(`${where}.${field}: not supported yet`);
    if (!allowed.includes(field)) throw new ConfigError(`${where}.${field}: unknown field (expected ${allowed.join(", ")})`);
  }
}

/** A screen's inputs, checked against its definitions: known names, values of the right type. */
function checkInputs(screen: string, inputs: unknown, where: string, screens: ScreenInputs): Record<string, unknown> {
  if (inputs === undefined || inputs === null) return {};
  if (!isObject(inputs)) throw new ConfigError(`${where}.inputs must be a mapping of input names to values`);
  const definitions = screens[screen];
  for (const [name, value] of Object.entries(inputs)) {
    // Own definitions only: not "constructor" and the like from the prototype
    const definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
    if (!definition) {
      const known = Object.keys(definitions);
      throw new ConfigError(`${where}.inputs.${name}: ${screen} has no such input (${known.length ? `it has ${known.join(", ")}` : "it has none"})`);
    }
    if (!matchesInput(definition, value)) {
      const expected = definition.type === "list" ? "a list of strings" : `a ${definition.type}`;
      throw new ConfigError(`${where}.inputs.${name} must be ${expected}, not ${describe(value)}`);
    }
  }
  return inputs;
}

/**
 * A screen entry: `screen`, optionally `inputs`, and in a playlist `duration`. `screenAt` is where
 * the screen's name was given, for messages; `notYet` the fields still to come there.
 */
function screenEntry(
  entry: Record<string, unknown>,
  where: string,
  screens: ScreenInputs,
  screenAt = `${where}.screen`,
  notYet = NOT_YET,
  fields = ["screen", "inputs", "duration"],
): PlaylistEntry {
  if (entry.playlist !== undefined) throw new ConfigError(`${where}: give either screen or playlist, not both`);
  checkFields(entry, fields, where, notYet);
  if (typeof entry.screen !== "string" || !Object.hasOwn(screens, entry.screen)) {
    throw new ConfigError(`${screenAt} must be one of ${Object.keys(screens).join(", ")}`);
  }
  const result: PlaylistEntry = { screen: entry.screen, inputs: checkInputs(entry.screen, entry.inputs, where, screens) };
  if (entry.duration !== undefined) result.duration = parseDuration(entry.duration, `${where}.duration`);
  return result;
}

/**
 * A playlist's entries, with includes (`playlist: <name>`, or just the name) replaced by the named
 * playlist's entries.
 * `named` are the raw named playlists; `including` the names being expanded, to catch cycles.
 */
export function expandPlaylist(
  raw: unknown,
  where: string,
  named: Record<string, unknown>,
  screens: ScreenInputs,
  including: string[] = [],
): PlaylistEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ConfigError(`${where} must be a non-empty list of entries`);
  return raw.flatMap((entry, i): PlaylistEntry[] => {
    const at = `${where}[${i}]`;
    // A name alone includes that playlist
    if (typeof entry === "string" || typeof entry === "number") return namedPlaylist(nameOf(entry), at, named, screens, including);
    if (!isObject(entry)) throw new ConfigError(`${at} must be a playlist's name or an entry (screen: …, or playlist: …)`);
    if (entry.playlist === undefined || entry.screen !== undefined) return [screenEntry(entry, at, screens)];
    checkFields(entry, ["playlist", "duration"], at);
    const entries = namedPlaylist(nameOf(entry.playlist), `${at}.playlist`, named, screens, including);
    if (entry.duration === undefined) return entries;
    // The include's duration, for its entries without their own
    const duration = parseDuration(entry.duration, `${at}.duration`);
    return entries.map((included) => (included.duration === undefined ? { ...included, duration } : included));
  });
}

// YAML reads a name like 1 as a number, but keys (the names in `playlists`) as strings
const nameOf = (name: unknown) => (typeof name === "number" ? String(name) : name);

/** A named playlist's entries, expanded; `where` is where its name was given. */
function namedPlaylist(
  name: unknown,
  where: string,
  named: Record<string, unknown>,
  screens: ScreenInputs,
  including: string[],
): PlaylistEntry[] {
  if (typeof name !== "string" || !Object.hasOwn(named, name)) {
    const known = Object.keys(named);
    // A screen's name where a playlist's is expected: say how to show the screen
    const screen = typeof name === "string" && Object.hasOwn(screens, name) ? `; for the screen ${name}, write screen: ${name}` : "";
    throw new ConfigError(`${where} must name a playlist (${known.length ? `there are ${known.join(", ")}` : "there are none under playlists"}${screen})`);
  }
  if (including.includes(name)) throw new ConfigError(`Playlists include each other: ${[...including, name].join(" → ")}`);
  return expandPlaylist(named[name], `playlists.${name}`, named, screens, [...including, name]);
}

/** The top-level `playlists`: checked as a whole, so mistakes in unused ones are found too. */
export function readNamedPlaylists(raw: unknown, screens: ScreenInputs): Record<string, unknown> {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new ConfigError("playlists must be a mapping of names to lists of entries");
  for (const name of Object.keys(raw)) namedPlaylist(name, "playlists", raw, screens, []);
  return raw;
}

/** The top-level `defaultScreen`: a screen's name, or `screen` and `inputs` like an entry. */
export function readDefaultScreen(raw: unknown, screens: ScreenInputs): PlaylistEntry {
  const available = Object.keys(screens);
  if (available.length === 0) throw new ConfigError("No screens found next to the server (screens/*.js)");
  // Without one: the placeholder if there is one, otherwise the first screen found
  if (raw === undefined) return { screen: available.includes("placeholder") ? "placeholder" : available[0], inputs: {} };
  // Not planned to get `when` or `duration`: it's what shows when no entry applies
  const fields = ["screen", "inputs"];
  if (typeof raw === "string") return screenEntry({ screen: raw }, "defaultScreen", screens, "defaultScreen", [], fields);
  if (isObject(raw)) return screenEntry(raw, "defaultScreen", screens, "defaultScreen.screen", [], fields);
  throw new ConfigError(`defaultScreen must be a screen's name, or screen and inputs`);
}

/**
 * A device's playlist: its `playlist` (a list of entries, or a named playlist's name), or its
 * `screen` as a playlist of one, or otherwise the default screen.
 */
export function devicePlaylist(
  device: { screen?: unknown; playlist?: unknown },
  where: string,
  named: Record<string, unknown>,
  screens: ScreenInputs,
  defaultScreen: PlaylistEntry,
): PlaylistEntry[] {
  if (device.screen !== undefined && device.playlist !== undefined) {
    throw new ConfigError(`${where}: give either screen or playlist, not both`);
  }
  if (device.screen !== undefined) return [screenEntry({ screen: device.screen }, where, screens)];
  const name = nameOf(device.playlist);
  if (typeof name === "string") return namedPlaylist(name, `${where}.playlist`, named, screens, []);
  if (device.playlist !== undefined) return expandPlaylist(device.playlist, `${where}.playlist`, named, screens);
  return [defaultScreen];
}
