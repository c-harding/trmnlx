// A departure from a stop, as the departures screens show it, whatever the source (MVG, Transitous).

/** How a departure's line is drawn: buses and trams written out ("Bus 54"), S-Bahn lines in a round badge, the rest in a square one. */
export type DepartureKind = "bus" | "tram" | "s-bahn" | "other";

export interface Departure {
  /** e.g. "U2", "54", "REX", "RJX 19960" */
  line: string;
  /** The source's own category, e.g. MVG's "UBAHN" or Transitous' "METRO"; hide rules match it */
  type: string;
  kind: DepartureKind;
  /** Line and direction: departures sharing it are the "next" ones; empty if unknown */
  lineId: string;
  destination: string;
  /** The expected departure (ms since the epoch), including any delay */
  time: number;
  /** The scheduled departure (ms since the epoch) */
  planned: number;
  cancelled: boolean;
  /** Notes, e.g. "Fährt nur bis Ostbahnhof"; empty if the source has none */
  messages: string[];
}
