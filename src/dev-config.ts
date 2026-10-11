// The dev server's view of devices.yaml: each device's and each named playlist's entries, so one can
// be loaded into its form. Read with the same functions as the server (includes expanded,
// `otherwise` resolved), but only what the form needs leaves this module: screens, inputs, `when`
// and `duration` as text, device names and time zones. Never passwords, tokens or MACs.
import { parse } from "yaml";
import type { Condition } from "./conditions.ts";
import {
  devicePlaylist,
  expandPlaylist,
  readDefaultScreen,
  readLocation,
  readNamedPlaylists,
  type PlaylistEntry,
  type ScreenInputs,
} from "./playlists.ts";

/** An entry that can be loaded into the form. */
export interface LoadableEntry {
  /** e.g. "2. journeys (Sa,Su 08:00-20:00, 10m)" */
  label: string;
  screen: string;
  inputs: Record<string, unknown>;
}

/** A device's or a named playlist's entries. */
export interface EntryGroup {
  /** For the URL: "device/kitchen" or "playlist/travel" */
  id: string;
  label: string;
  /** For a device: what fills the form's device settings */
  device?: { name: string; timeZone: string };
  entries: LoadableEntry[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A condition as text: its opening hours, combined in words. */
export function whenText(condition: Condition): string {
  const inner = (part: Condition) => (part.kind === "all" || part.kind === "any" ? `(${whenText(part)})` : whenText(part));
  switch (condition.kind) {
    case "always":
      return "always";
    case "never":
      return "never";
    case "hours":
      return condition.text;
    case "all":
      return condition.parts.map(inner).join(" and ");
    case "any":
      return condition.parts.map(inner).join(" or ");
    case "not":
      return `not ${inner(condition.part)}`;
  }
}

/** A duration as written in devices.yaml, e.g. 90 → "1m30s". */
export function durationText(seconds: number) {
  const parts = [[Math.floor(seconds / 3600), "h"], [Math.floor(seconds / 60) % 60, "m"], [seconds % 60, "s"]] as const;
  return parts.filter(([amount]) => amount > 0).map(([amount, unit]) => `${amount}${unit}`).join("");
}

/** An entry's label from its screen and inputs, e.g. "Graz" for a map (see `label` in defineScreen). */
export type LabelOf = (screen: string, inputs: Record<string, unknown>) => string | undefined;

const loadable = (entries: PlaylistEntry[], labelOf: LabelOf): LoadableEntry[] =>
  entries.map(({ screen, inputs, when, duration }, i) => {
    const label = labelOf(screen, inputs);
    const details = [when && whenText(when), duration !== undefined && durationText(duration)].filter(Boolean);
    return { label: `${i + 1}. ${screen}${label ? `: ${label}` : ""}${details.length ? ` (${details.join(", ")})` : ""}`, screen, inputs };
  });

/**
 * The entries of devices.yaml's text, grouped by device and named playlist, labelled with `labelOf`.
 * Throws (a ConfigError or a YAML error) if the file isn't valid, as the server would.
 */
export function readDevConfig(text: string, screens: ScreenInputs, defaultTimeZone: string, labelOf: LabelOf = () => undefined): EntryGroup[] {
  const data: unknown = parse(text);
  if (!isObject(data)) throw new Error("devices.yaml must be a mapping");
  const defaultScreen = readDefaultScreen(data.defaultScreen, screens);
  const location = readLocation(data.location, "location");
  const named = readNamedPlaylists(data.playlists, screens, location);
  const devices = Array.isArray(data.devices) ? data.devices : [];

  const deviceGroups = devices.filter(isObject).map((device, i): EntryGroup => {
    const where = `devices[${i}]`;
    const name = typeof device.username === "string" ? device.username : where;
    const timeZone = typeof device.timezone === "string" ? device.timezone : defaultTimeZone;
    const playlist = devicePlaylist(device, where, named, screens, defaultScreen, readLocation(device.location, `${where}.location`) ?? location);
    return { id: `device/${name}`, label: `Device ${name}`, device: { name, timeZone }, entries: loadable(playlist, labelOf) };
  });
  const playlistGroups = Object.keys(named).map(
    (name): EntryGroup => ({
      id: `playlist/${name}`,
      label: `Playlist ${name}`,
      entries: loadable(expandPlaylist(named[name], `playlists.${name}`, named, screens, [name], location), labelOf),
    }),
  );
  return [...deviceGroups, ...playlistGroups];
}
