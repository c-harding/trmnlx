// Routes for the journeys screen.
//
// A route is written as stops separated by "->", e.g. "Marienplatz -> (Raubling) -> Innsbruck Hbf":
// from, any via stops, to, as Transitous names them. A stop in brackets is searched but not shown
// in titles.

export interface RouteStop {
  name: string;
  /** In brackets: searched, but left out of titles, e.g. "(Raubling)" */
  hidden: boolean;
}

export interface Route {
  stops: RouteStop[];
}

/** A route from its text (see above), or undefined (logged) if it isn't one. */
export function parseRoute(text: string): Route | undefined {
  const stops = text.split("->").map((part): RouteStop => {
    const stop = part.trim();
    // Only a stop wholly in brackets: "Hauptbahnhof (U-Bahn/Tram)" is a name
    const bracketed = /^\((.*)\)$/.exec(stop);
    return bracketed ? { name: bracketed[1].trim(), hidden: true } : { name: stop, hidden: false };
  });
  if (stops.length >= 2 && stops.every((stop) => stop.name)) return { stops };
  console.error(`Ignoring route ${JSON.stringify(text)}: expected "<from> -> [<via> -> …] <to>"`);
  return undefined;
}

/** The route's stops without those in brackets, e.g. "Marienplatz → Innsbruck Hbf". */
export const routeTitle = (stops: RouteStop[]) =>
  stops
    .filter((stop) => !stop.hidden)
    .map((stop) => stop.name)
    .join(" → ");
