// Routes for the journeys screen, and which transport may be used on them.
//
// A route is written as stops separated by "->", e.g. "Marienplatz -> (Raubling) -> Innsbruck Hbf":
// from, any via stops, to, as Transitous names them. A stop in brackets is searched but not shown
// in titles.
//
// Which transport counts is set by rules: "allow:<modes>" and "deny:<modes>", where <modes> is a
// Transitous mode ("bus", "highspeed_rail", …) or a group ("longdistance", "regional", "local").
// The screen's rules apply everywhere (e.g. "deny:longdistance" for a Deutschlandticket); a
// stretch written "-[rules]>" (or "-[rules]->") instead of "->" adds its own after them. E.g.
// "Marienplatz -> (Raubling) -> (Kufstein) -[allow:longdistance]> Innsbruck Hbf" allows a Railjet from
// Kufstein (the Klimaticket Österreich covers it), but not one from Munich.
import type { Journey, Point } from "./sources/transitous.ts";

export interface RouteStop {
  name: string;
  /** In brackets: searched, but left out of titles, e.g. "(Raubling)" */
  hidden: boolean;
}

/** Allows or denies some modes; of the rules that match a ride's mode, the last one decides. */
export interface Rule {
  allow: boolean;
  modes: ReadonlySet<string>;
}

export interface Route {
  stops: RouteStop[];
  /** One list per stretch between two stops: its own rules, applied after the screen's */
  rules: Rule[][];
}

// Transitous' modes (MOTIS), as rides have them (see correctedMode in sources/transitous.ts)
const MODES = [
  "AIRPLANE", "AREAL_LIFT", "BUS", "CABLE_CAR", "COACH", "FERRY", "FUNICULAR", "HIGHSPEED_RAIL",
  "LONG_DISTANCE", "METRO", "NIGHT_RAIL", "ODM", "OTHER", "RAIL", "REGIONAL_FAST_RAIL",
  "REGIONAL_RAIL", "SUBURBAN", "SUBWAY", "TRAM",
];
const GROUPS: Record<string, string[]> = {
  // Not covered by a Deutschlandticket (WESTbahn and Flix included, see correctedMode)
  longdistance: ["HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL", "COACH"],
  regional: ["REGIONAL_RAIL", "REGIONAL_FAST_RAIL"],
  // METRO is the S-Bahn, SUBWAY the U-Bahn
  local: ["BUS", "TRAM", "SUBWAY", "METRO", "SUBURBAN", "FERRY"],
};

/** Rules from text such as "deny:longdistance" or "allow:longdistance, deny:coach"; unknown ones are logged and ignored. */
export function parseRules(text: string, where: string): Rule[] {
  const rules: Rule[] = [];
  for (const token of text.split(/[\s,]+/).filter(Boolean)) {
    const match = /^(allow|deny):(\w+)$/i.exec(token);
    const name = match?.[2].toLowerCase();
    const modes = name && (GROUPS[name] ?? (MODES.includes(name.toUpperCase()) ? [name.toUpperCase()] : undefined));
    if (!match || !modes) {
      console.error(
        `Ignoring ${JSON.stringify(token)} in ${where}: expected allow:<mode> or deny:<mode>, with a group (${Object.keys(GROUPS).join(", ")}) or a mode (${MODES.join(", ").toLowerCase()})`,
      );
      continue;
    }
    rules.push({ allow: match[1].toLowerCase() === "allow", modes: new Set(modes) });
  }
  return rules;
}

/** Whether rules allow a mode: the last rule mentioning it decides; without one, it's allowed. */
const allows = (rules: Rule[], mode: string) => rules.findLast((rule) => rule.modes.has(mode))?.allow ?? true;

// "->", or "-[rules]>" / "-[rules]->"
const STRETCH = /-(?:\[([^\]]*)\])?-?>/;

/** A route from its text (see above), or undefined (logged) if it isn't one. */
export function parseRoute(text: string): Route | undefined {
  // Splitting with a capture group alternates stops and the rules of the stretches between them
  const parts = text.split(STRETCH);
  const stops: RouteStop[] = [];
  const rules: Rule[][] = [];
  parts.forEach((part: string | undefined, i) => {
    if (i % 2 === 1) {
      rules.push(parseRules(part ?? "", `route ${JSON.stringify(text)}`));
      return;
    }
    const stop = (part ?? "").trim();
    // Only a stop wholly in brackets: "Hauptbahnhof (U-Bahn/Tram)" is a name
    const bracketed = /^\((.*)\)$/.exec(stop);
    stops.push(bracketed ? { name: bracketed[1].trim(), hidden: true } : { name: stop, hidden: false });
  });
  if (stops.length >= 2 && stops.every((stop) => stop.name)) return { stops, rules };
  console.error(`Ignoring route ${JSON.stringify(text)}: expected "<from> -> [<via> -> …] <to>"`);
  return undefined;
}

/** The route's stops without those in brackets, e.g. "Marienplatz → Innsbruck Hbf". */
export const routeTitle = (stops: RouteStop[]) =>
  stops
    .filter((stop) => !stop.hidden)
    .map((stop) => stop.name)
    .join(" → ");

// Stops in different datasets have different IDs, but the same place: a via stop counts as passed
// at a ride's stop within this distance
const SAME_PLACE_METRES = 300;

function metresBetween(a: Point, b: Point) {
  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.hypot(x, y) * 6_371_000;
}

/**
 * Whether every ride of a journey may be used: each stretch of the route it covers must allow its
 * mode, by the screen's rules and then the stretch's own. `routeStops` are the route's stops as
 * looked up (with coordinates); rides are placed on the stretches by where they pass the via
 * stops. Without them (a lookup failed), a ride must be allowed on every stretch.
 */
export function allowedOnRoute(journey: Journey, route: Route, routeStops: Point[] | undefined, screenRules: Rule[]) {
  const allowedOn = (stretch: number, mode: string) => allows([...screenRules, ...route.rules[stretch]], mode);
  if (!routeStops) return journey.legs.every((leg) => route.rules.every((_rules, stretch) => allowedOn(stretch, leg.mode)));

  const lastStretch = route.rules.length - 1;
  // The stretch the journey is on: it moves on at each via stop the rides pass
  let stretch = 0;
  const atNextViaStop = (point: Point) =>
    stretch < lastStretch && metresBetween(point, routeStops[stretch + 1]) <= SAME_PLACE_METRES;

  for (const leg of journey.legs) {
    const [boarding, ...rest] = leg.stops;
    // Boarding at a via stop: the ride starts on the next stretch
    while (atNextViaStop(boarding)) stretch++;
    let allowed = allowedOn(stretch, leg.mode);
    rest.forEach((point, i) => {
      const alighting = i === rest.length - 1;
      while (atNextViaStop(point)) {
        stretch++;
        // Passing a via stop: the ride continues on the next stretch too (but not when it ends there)
        if (!alighting) allowed &&= allowedOn(stretch, leg.mode);
      }
    });
    if (!allowed) return false;
  }
  return true;
}
