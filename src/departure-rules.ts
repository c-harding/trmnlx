// Which departures a departures screen hides (its `hide` input) and which connections it pins (its
// `pinned` input), from the device's settings. Not in components/departures.tsx, so tests can use
// them without the fonts that rendering loads.
import type { Departure } from "./departure.ts";

/**
 * A rule for which departures are hidden, as "<types> [line] [-> <destination>]", with the source's
 * own types (MVG's "BUS", "SBAHN", …; Transitous' "BUS", "METRO", …): "BUS" hides all buses,
 * "TRAM -> Amalienburgstraße" trams going there, "BUS 54" one bus line. Several types are separated
 * by "|" ("BUS|REGIONAL_BUS"); without types, before an arrow, any ("-> Messestadt Ost"). Line and
 * destination are compared ignoring case.
 * "show" in front ("show BUS 54") makes it an exception that shows matching departures again; "!"
 * does too, but in YAML only quoted ("- '!BUS 54'"), since an unquoted "!" starts a YAML tag.
 */
export interface HideRule {
  show: boolean;
  types: string[] | undefined;
  line: string | undefined;
  destination: string | undefined;
}

export const parseHideRule = (text: string): HideRule | undefined => {
  const marker = /^(?:show\s+|!)/i.exec(text.trim())?.[0];
  const show = marker !== undefined;
  const [departure, ...arrow] = text
    .trim()
    .slice(marker?.length ?? 0)
    .split("->");
  const [types, line, ...extra] = departure.trim().split(/\s+/).filter(Boolean);
  const destination = arrow.join("->").trim();
  if ((!types && !destination) || extra.length > 0 || (arrow.length > 0 && !destination)) {
    console.error(
      `Ignoring hide rule ${JSON.stringify(text)}: expected "<types> [line] [-> <destination>]"`,
    );
    return undefined;
  }
  return {
    show,
    types: types ? types.toUpperCase().split("|") : undefined,
    line,
    destination: destination || undefined,
  };
};

/**
 * A pinned connection, as "<types> -> <station>": the next direct one of those types (the source's
 * own, separated by "|": "SBAHN|UBAHN -> Ostbahnhof") there, of any type without them
 * ("-> Ostbahnhof", `types` empty). Undefined, and logged, without an arrow and a station.
 */
export const parsePin = (text: string): { types: string[]; target: string } | undefined => {
  const [types, ...arrow] = text.trim().split("->");
  const target = arrow.join("->").trim();
  if (arrow.length === 0 || !target || /\s/.test(types.trim())) {
    console.error(`Ignoring pin ${JSON.stringify(text)}: expected "<types> -> <station>"`);
    return undefined;
  }
  return { types: types.trim().toUpperCase().split("|").filter(Boolean), target };
};

const sameText = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const matchesRule = (rule: HideRule, d: Departure) =>
  (!rule.types || rule.types.includes(d.type)) &&
  (!rule.line || sameText(rule.line, d.line)) &&
  (!rule.destination || sameText(rule.destination, d.destination));

/** Whether a departure is shown: the last rule matching it decides, and without one it is. */
export const isShown = (rules: HideRule[], d: Departure) =>
  rules.reduce((shown, rule) => (matchesRule(rule, d) ? rule.show : shown), true);
