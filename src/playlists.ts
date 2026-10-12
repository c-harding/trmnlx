// Playlists from devices.yaml: what a device shows, as a list of entries, each a screen with its
// inputs. Named playlists (top-level `playlists`) can be used by devices and included in each other,
// as `playlist: <name>` or just `<name>`; includes are expanded here, so a device ends up with one
// flat list. Each entry's `when` is combined with its includes' then, and `otherwise` resolved, so
// each entry has one condition (see conditions.ts).
//
// Plain functions that throw a ConfigError, so config.ts can report it and stop, and tests can call
// them with made-up screens. An unknown screen in a playlist is only a warning (the entry is
// skipped), so a renamed or removed screen doesn't stop the server; anything else is an error.
import { ALWAYS, all, any, not, parseHours, type Condition, type Location } from "./conditions.ts";
import { inputTypeName, matchesInput, type InputDefinitions } from "./define-screen.ts";

/** One screen with its inputs (values as written in devices.yaml, checked against the screen's). */
export interface PlaylistEntry {
  screen: string;
  inputs: Record<string, unknown>;
  /** How long it stays before the playlist moves on (s); without it, until a press */
  duration?: number;
  /** When it applies; without it, always */
  when?: Condition;
  /**
   * From an include with `shuffle: true`: where that include is written, e.g.
   * `devices[0].playlist[2]`. A run of entries with the same value is played in a random order,
   * new each round (see device-state.ts)
   */
  shuffle?: string;
}

export class ConfigError extends Error {}

/** The screens there are, with their input definitions: all that checking a playlist needs. */
export type ScreenInputs = Record<string, InputDefinitions>;

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
  if (typeof value === "number") {
    // YAML's .nan and .inf: "a number" would say nothing
    if (Number.isNaN(value)) return ".nan (not a number)";
    if (!Number.isFinite(value)) return ".inf (infinite)";
    // For a whole number input
    if (!Number.isInteger(value)) return `a fraction (${value})`;
  }
  if (!Array.isArray(value)) return `a ${typeof value}`;
  // A list: say what's wrong in it, e.g. a hide rule written as a bare number
  const i = value.findIndex((item) => typeof item !== "string");
  return i < 0 ? "a list" : `a list with ${describe(value[i])} at position ${i + 1}`;
}

// Warnings already given: named playlists are expanded once per device using them
const warned = new Set<string>();

function warn(message: string) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`devices.yaml: ${message}`);
}

function checkFields(entry: Record<string, unknown>, allowed: string[], where: string) {
  for (const field of Object.keys(entry)) {
    if (!allowed.includes(field)) throw new ConfigError(`${where}.${field}: unknown field (expected ${allowed.join(", ")})`);
  }
}

// `when: otherwise`, until it's resolved against its siblings
const OTHERWISE = "otherwise";

/** An entry's or include's `when`: a condition, or `otherwise`. */
function parseWhen(value: unknown, where: string, location: Location | undefined): Condition | typeof OTHERWISE {
  if (value === OTHERWISE) return OTHERWISE;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${where} must be opening hours such as Mo-Fr 06:30-09:00 (OpenStreetMap's opening_hours syntax), or otherwise`);
  }
  // Without coordinates, the library would silently use fixed times for these
  if (/sunrise|sunset|dawn|dusk/i.test(value) && location?.lat === undefined) {
    throw new ConfigError(`${where}: sunrise, sunset, dawn and dusk need lat and lon in the location, e.g. location: { country: de, lat: 48.14, lon: 11.58 }`);
  }
  try {
    return parseHours(value, location);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Country code missing")) {
      throw new ConfigError(`${where}: holidays (PH, SH) need a location, e.g. location: { country: de, state: Bayern }`);
    }
    if (/no holidays .* defined for country/.test(message)) {
      throw new ConfigError(`${where}: no holidays known for this location (school holidays, SH, need its state, e.g. state: Bayern)`);
    }
    throw new ConfigError(`${where} isn't valid opening hours: ${message.trim()}`);
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
      throw new ConfigError(`${where}.inputs.${name} must be ${inputTypeName(definition)}, not ${describe(value)}`);
    }
  }
  return inputs;
}

/**
 * A screen entry: `screen`, optionally `inputs`, and in a playlist `duration` and `when` (which
 * expandPlaylist reads). `screenAt` is where the screen's name was given, for messages. An unknown
 * screen gives undefined and a warning (its inputs can't be checked, its other fields are), or an
 * error if `required`.
 */
function screenEntry(
  entry: Record<string, unknown>,
  where: string,
  screens: ScreenInputs,
  { screenAt = `${where}.screen`, fields = ["screen", "inputs", "duration", "when"], required = false } = {},
): PlaylistEntry | undefined {
  if (entry.playlist !== undefined) throw new ConfigError(`${where}: give either screen or playlist, not both`);
  checkFields(entry, fields, where);
  const duration = entry.duration === undefined ? undefined : parseDuration(entry.duration, `${where}.duration`);
  const known = Object.keys(screens).join(", ");
  if (typeof entry.screen !== "string" || (required && !Object.hasOwn(screens, entry.screen))) {
    throw new ConfigError(`${screenAt} must be one of ${known}`);
  }
  if (!Object.hasOwn(screens, entry.screen)) {
    warn(`${screenAt}: there's no screen ${entry.screen} (there are ${known}), so it's left out`);
    return undefined;
  }
  const result: PlaylistEntry = { screen: entry.screen, inputs: checkInputs(entry.screen, entry.inputs, where, screens) };
  if (duration !== undefined) result.duration = duration;
  return result;
}

/**
 * A playlist's entries, with includes (`playlist: <name>`, or just the name) replaced by the named
 * playlist's entries, and each entry's condition: its own `when`, and its includes' (all must
 * apply). `when: otherwise` applies when none of its siblings in this list does (an include
 * counting as applying when any of its entries does). `location` is for holidays in `when`.
 * `named` are the raw named playlists; `including` the names being expanded, to catch cycles.
 */
export function expandPlaylist(
  raw: unknown,
  where: string,
  named: Record<string, unknown>,
  screens: ScreenInputs,
  including: string[] = [],
  location?: Location,
): PlaylistEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ConfigError(`${where} must be a non-empty list of entries`);
  // Each item of the list: its entries, and its own `when`
  const items = raw.map((entry, i): { entries: PlaylistEntry[]; when: Condition | typeof OTHERWISE } => {
    const at = `${where}[${i}]`;
    // A name alone includes that playlist
    if (typeof entry === "string" || typeof entry === "number") {
      return { entries: namedPlaylist(nameOf(entry), at, named, screens, including, location), when: ALWAYS };
    }
    if (!isObject(entry)) throw new ConfigError(`${at} must be a playlist's name or an entry (screen: …, or playlist: …)`);
    const when = entry.when === undefined ? ALWAYS : parseWhen(entry.when, `${at}.when`, location);
    if (entry.playlist === undefined || entry.screen !== undefined) {
      const screen = screenEntry(entry, at, screens);
      return { entries: screen ? [screen] : [], when };
    }
    checkFields(entry, ["playlist", "duration", "when", "shuffle"], at);
    if (entry.shuffle !== undefined && typeof entry.shuffle !== "boolean") throw new ConfigError(`${at}.shuffle must be true or false`);
    let entries = namedPlaylist(nameOf(entry.playlist), `${at}.playlist`, named, screens, including, location);
    // The include's duration, for its entries without their own
    const duration = entry.duration === undefined ? undefined : parseDuration(entry.duration, `${at}.duration`);
    if (duration !== undefined) entries = entries.map((included) => (included.duration === undefined ? { ...included, duration } : included));
    // Shuffled as one, also any shuffled includes inside it
    if (entry.shuffle) entries = entries.map((included) => ({ ...included, shuffle: at }));
    return { entries, when };
  });
  // When each item applies: its own `when`, and for an include any of its entries' conditions
  const appliesWhen = (item: (typeof items)[number]) =>
    item.when === OTHERWISE ? undefined : all([item.when, any(item.entries.map((entry) => entry.when ?? ALWAYS))]);
  const otherwise = not(any(items.map(appliesWhen).filter((condition) => condition !== undefined)));
  return items.flatMap(({ entries, when }) =>
    entries.map((entry) => withWhen(entry, all([when === OTHERWISE ? otherwise : when, entry.when ?? ALWAYS]))),
  );
}

/** An entry with a condition: none for one that always applies. */
function withWhen({ when: _, ...entry }: PlaylistEntry, when: Condition): PlaylistEntry {
  return when.kind === "always" ? entry : { ...entry, when };
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
  location: Location | undefined,
): PlaylistEntry[] {
  if (typeof name !== "string" || !Object.hasOwn(named, name)) {
    const known = Object.keys(named);
    // A screen's name where a playlist's is expected: say how to show the screen
    const screen = typeof name === "string" && Object.hasOwn(screens, name) ? `; for the screen ${name}, write screen: ${name}` : "";
    throw new ConfigError(`${where} must name a playlist (${known.length ? `there are ${known.join(", ")}` : "there are none under playlists"}${screen})`);
  }
  if (including.includes(name)) throw new ConfigError(`Playlists include each other: ${[...including, name].join(" → ")}`);
  return expandPlaylist(named[name], `playlists.${name}`, named, screens, [...including, name], location);
}

// For checking named playlists before knowing which devices use them, and so which location they
// get: only needed for holidays to parse, the real location comes with each device
const CHECKING_LOCATION: Location = { country: "de", state: "Bayern", lat: 48.14, lon: 11.58 };

/**
 * The top-level `playlists`: checked as a whole, so mistakes in unused ones are found too. A
 * missing location for holidays is only found with the devices using them (they may have one).
 */
export function readNamedPlaylists(raw: unknown, screens: ScreenInputs, location?: Location): Record<string, unknown> {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new ConfigError("playlists must be a mapping of names to lists of entries");
  for (const name of Object.keys(raw)) namedPlaylist(name, "playlists", raw, screens, [], location ?? CHECKING_LOCATION);
  return raw;
}

/**
 * A `location`, at the top level or a device's: `country` (e.g. de), and optionally `state` and the
 * coordinates `lat` and `lon`.
 */
export function readLocation(raw: unknown, where: string): Location | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new ConfigError(`${where} must be a country and optionally a state, e.g. { country: de, state: Bayern }`);
  checkFields(raw, ["country", "state", "lat", "lon"], where);
  if (typeof raw.country !== "string" || !/^[a-z]{2}$/i.test(raw.country)) {
    throw new ConfigError(`${where}.country must be a two-letter country code, e.g. de or at`);
  }
  if (raw.state !== undefined && (typeof raw.state !== "string" || raw.state === "")) {
    throw new ConfigError(`${where}.state must be a state's name as OpenStreetMap writes it, e.g. Bayern or Tirol`);
  }
  if ((raw.lat === undefined) !== (raw.lon === undefined)) throw new ConfigError(`${where}: give both lat and lon, or neither`);
  for (const [field, limit] of [["lat", 90], ["lon", 180]] as const) {
    const value = raw[field];
    if (value !== undefined && (typeof value !== "number" || !(Math.abs(value) <= limit))) {
      throw new ConfigError(`${where}.${field} must be a number of degrees, from -${limit} to ${limit}`);
    }
  }
  return {
    country: raw.country.toLowerCase(),
    ...(raw.state === undefined ? {} : { state: raw.state as string }),
    ...(raw.lat === undefined ? {} : { lat: raw.lat as number, lon: raw.lon as number }),
  };
}

/** The top-level `defaultScreen`: a screen's name, or `screen` and `inputs` like an entry. */
export function readDefaultScreen(raw: unknown, screens: ScreenInputs): PlaylistEntry {
  const available = Object.keys(screens);
  if (available.length === 0) throw new ConfigError("No screens found next to the server (screens/*.js)");
  // Without one: the placeholder if there is one, otherwise the first screen found
  if (raw === undefined) return { screen: available.includes("placeholder") ? "placeholder" : available[0], inputs: {} };
  // Not planned to get `when` or `duration`: it's what shows when no entry applies
  const fields = ["screen", "inputs"];
  // It must exist: it's what shows when nothing else can
  const options = { fields, required: true };
  if (typeof raw === "string") return screenEntry({ screen: raw }, "defaultScreen", screens, { ...options, screenAt: "defaultScreen" })!;
  if (isObject(raw)) return screenEntry(raw, "defaultScreen", screens, { ...options, screenAt: "defaultScreen.screen" })!;
  throw new ConfigError(`defaultScreen must be a screen's name, or screen and inputs`);
}

/**
 * A device's playlist: its `playlist` (a list of entries, or a named playlist's name), or its
 * `screen` as a playlist of one, or otherwise the default screen. `location` is the device's, for
 * holidays in `when`.
 */
export function devicePlaylist(
  device: { screen?: unknown; playlist?: unknown },
  where: string,
  named: Record<string, unknown>,
  screens: ScreenInputs,
  defaultScreen: PlaylistEntry,
  location?: Location,
): PlaylistEntry[] {
  if (device.screen !== undefined && device.playlist !== undefined) {
    throw new ConfigError(`${where}: give either screen or playlist, not both`);
  }
  let playlist = [defaultScreen];
  const name = nameOf(device.playlist);
  if (device.screen !== undefined) {
    const screen = screenEntry({ screen: device.screen }, where, screens);
    playlist = screen ? [screen] : [];
  } else if (typeof name === "string") {
    playlist = namedPlaylist(name, `${where}.playlist`, named, screens, [], location);
  } else if (device.playlist !== undefined) {
    playlist = expandPlaylist(device.playlist, `${where}.playlist`, named, screens, [], location);
  }
  return orDefault(playlist, where, defaultScreen);
}

/** A playlist, or the default screen if every screen in it was left out. */
function orDefault(playlist: PlaylistEntry[], where: string, defaultScreen: PlaylistEntry) {
  if (playlist.length > 0) return playlist;
  warn(`${where}: none of its playlist's screens exist, so it shows defaultScreen (${defaultScreen.screen})`);
  return [defaultScreen];
}

/** One of a device's playlists, which the screen page switches between. */
export interface DevicePlaylist {
  name: string;
  entries: PlaylistEntry[];
  /** Whether the screen page offers it: not `default` when it's only the default screen */
  offered: boolean;
}

// The name of a device's `playlist` (or `screen`) among its playlists
export const DEFAULT_PLAYLIST = "default";

/**
 * A device's playlists: first `default` (its `playlist` or `screen`, see devicePlaylist), offered
 * only if it has one of those, then those of its `playlists`, in order. `playlists` is a mapping
 * of names to playlists (a list of entries, or a named playlist's name, like `playlist`), or a
 * list of named playlists' names, each offered under its own name.
 */
export function devicePlaylists(
  device: { screen?: unknown; playlist?: unknown; playlists?: unknown },
  where: string,
  named: Record<string, unknown>,
  screens: ScreenInputs,
  defaultScreen: PlaylistEntry,
  location?: Location,
): DevicePlaylist[] {
  const result: DevicePlaylist[] = [
    {
      name: DEFAULT_PLAYLIST,
      entries: devicePlaylist(device, where, named, screens, defaultScreen, location),
      offered: device.screen !== undefined || device.playlist !== undefined,
    },
  ];
  if (device.playlists === undefined) return result;
  const at = `${where}.playlists`;
  let alternatives: Record<string, unknown>;
  if (Array.isArray(device.playlists)) {
    alternatives = {};
    device.playlists.forEach((name, i) => {
      if (typeof name !== "string" && typeof name !== "number") {
        throw new ConfigError(`${at}[${i}] must be a playlist's name; for entries of its own, give playlists as a mapping of names to entries`);
      }
      if (Object.hasOwn(alternatives, String(name))) throw new ConfigError(`${at}[${i}]: ${name} is given twice`);
      alternatives[String(name)] = String(name);
    });
  } else if (isObject(device.playlists)) {
    alternatives = device.playlists;
  } else {
    throw new ConfigError(`${at} must be a mapping of names to playlists, or a list of playlists' names`);
  }
  for (const [name, given] of Object.entries(alternatives)) {
    if (name === DEFAULT_PLAYLIST) throw new ConfigError(`${at}: ${DEFAULT_PLAYLIST} is the name of the device's playlist (or screen), so it can't name another`);
    // One include's fields (`duration: 10m`, `shuffle: true`) instead of a list: of the named
    // playlist of the same name, unless they give another (`playlist: …`); nothing (`maps:`): that
    // playlist as it is
    const raw =
      given === null ? [{ playlist: name }]
      : isObject(given) && given.screen === undefined ? [{ playlist: name, ...given }]
      : given;
    const entries =
      typeof nameOf(raw) === "string"
        ? namedPlaylist(nameOf(raw), `${at}.${name}`, named, screens, [], location)
        : expandPlaylist(raw, `${at}.${name}`, named, screens, [], location);
    result.push({ name, entries: orDefault(entries, `${at}.${name}`, defaultScreen), offered: true });
  }
  return result;
}
