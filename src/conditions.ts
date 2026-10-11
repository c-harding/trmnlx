// When playlist entries apply: conditions from `when` in devices.yaml, in OpenStreetMap's
// opening_hours syntax (e.g. "Mo-Fr 06:30-09:00; PH off"), combined with `all`, `any` and `not` (an
// include's `when` with its entries', and `otherwise`). Evaluated with the opening_hours library,
// which answers both questions a playlist needs: does it apply at a time, and when does that next
// change (for when the device should wake).
//
// The library always works in the process's local time zone and takes none as a parameter, so
// conditions are evaluated inside inTimeZone, with the device's time zone.
import opening_hours from "opening_hours";

/** Where a device is: for public and school holidays (`PH`, `SH`), and sunrise and sunset. */
export interface Location {
  /** e.g. "de", "at" */
  country: string;
  /** As OpenStreetMap names it, e.g. "Bayern", "Tirol" */
  state?: string;
  /** In degrees, for `sunrise`, `sunset`, `dawn` and `dusk` */
  lat?: number;
  lon?: number;
}

export type Condition =
  | { kind: "always" }
  | { kind: "never" }
  | { kind: "hours"; text: string; hours: opening_hours }
  | { kind: "all" | "any"; parts: Condition[] }
  | { kind: "not"; part: Condition };

export const ALWAYS: Condition = { kind: "always" };
const NEVER: Condition = { kind: "never" };

/** A condition from a `when`; throws an Error with the library's message if it isn't valid. */
export function parseHours(text: string, location: Location | undefined): Condition {
  // The address is for holidays, the coordinates for sunrise and sunset. The library only takes
  // coordinates as strings (as Nominatim gives them): numbers are silently ignored, and it then
  // uses 06:00 and 18:00, whatever its types say
  const place = location && {
    lat: String(location.lat ?? 0),
    lon: String(location.lon ?? 0),
    address: { country_code: location.country, state: location.state ?? "" },
  };
  return { kind: "hours", text, hours: new opening_hours(text, place as unknown as ConstructorParameters<typeof opening_hours>[1]) };
}

/** All of the conditions apply (always, if there are none). */
export function all(parts: Condition[]): Condition {
  const kept = parts.filter((part) => part.kind !== "always");
  if (kept.some((part) => part.kind === "never")) return NEVER;
  return kept.length === 0 ? ALWAYS : kept.length === 1 ? kept[0] : { kind: "all", parts: kept };
}

/** Any of the conditions applies (never, if there are none). */
export function any(parts: Condition[]): Condition {
  const kept = parts.filter((part) => part.kind !== "never");
  if (kept.some((part) => part.kind === "always")) return ALWAYS;
  return kept.length === 0 ? NEVER : kept.length === 1 ? kept[0] : { kind: "any", parts: kept };
}

export function not(part: Condition): Condition {
  if (part.kind === "always") return NEVER;
  if (part.kind === "never") return ALWAYS;
  if (part.kind === "not") return part.part;
  return { kind: "not", part };
}

/** Whether the condition applies at a time. Call inside inTimeZone. */
export function applies(condition: Condition, at: Date): boolean {
  switch (condition.kind) {
    case "always":
      return true;
    case "never":
      return false;
    case "hours":
      return condition.hours.getState(at);
    case "all":
      return condition.parts.every((part) => applies(part, at));
    case "any":
      return condition.parts.some((part) => applies(part, at));
    case "not":
      return !applies(condition.part, at);
  }
}

/**
 * When whether the condition applies may next change, after a time: undefined if never (or not
 * before `until`, which keeps the search short). For a
 * combination, the earliest change of its parts, which can be a little early (the combination
 * may not change then), never late. Call inside inTimeZone.
 */
export function nextChange(condition: Condition, at: Date, until?: Date): Date | undefined {
  switch (condition.kind) {
    case "always":
    case "never":
      return undefined;
    case "hours":
      return condition.hours.getNextChange(at, until);
    case "all":
    case "any":
      return earliest(condition.parts.map((part) => nextChange(part, at, until)));
    case "not":
      return nextChange(condition.part, at, until);
  }
}

/** The earliest of some times, ignoring undefined ones; undefined if there are none. */
export function earliest(times: (Date | undefined)[]): Date | undefined {
  let first: Date | undefined;
  for (const time of times) if (time && (!first || time < first)) first = time;
  return first;
}

/**
 * Runs `fn` with the process's local time zone set to `zone`, and restores it afterwards: the
 * opening_hours library works in local time only. Safe because it's synchronous: nothing else runs
 * in between. Switching costs about 0.3 ms, so evaluate everything for a device in one call. The
 * server's own date formatting always passes an explicit timeZone, so it isn't affected.
 */
export function inTimeZone<T>(zone: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}
