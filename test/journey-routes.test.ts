import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedOnRoute, parseRoute, parseRules } from "../src/journey-routes.ts";
import type { Journey, JourneyLeg, Point } from "../src/sources/transitous.ts";

const at = {
  marienplatz: { name: "Marienplatz", lat: 48.1374, lon: 11.5755 },
  ost: { name: "Ost", lat: 48.127, lon: 11.605 },
  raubling: { name: "Raubling", lat: 47.79, lon: 12.11 },
  kufstein: { name: "Kufstein", lat: 47.583, lon: 12.166 },
  innsbruck: { name: "Innsbruck", lat: 47.263, lon: 11.401 },
};

const ride = (mode: string, ...stops: Point[]): JourneyLeg => ({
  line: mode,
  mode,
  from: stops[0].name,
  to: stops.at(-1)!.name,
  departure: 0,
  plannedDeparture: 0,
  arrival: 1,
  plannedArrival: 1,
  realTime: false,
  cancelled: false,
  operator: "",
  stops,
});
const journey = (...legs: JourneyLeg[]): Journey => ({
  departure: 0,
  arrival: 1,
  changes: legs.length - 1,
  legs,
});

const noLongDistance = parseRules("deny:longdistance", "test");
const route = parseRoute(
  "Marienplatz -> (Raubling) -> (Kufstein) -[allow:longdistance]-> Innsbruck Hbf",
)!;
const routeStops = [at.marienplatz, at.raubling, at.kufstein, at.innsbruck];

test("parseRoute: stops, hidden stops and rules per stretch", () => {
  assert.deepEqual(
    route.stops.map((stop) => [stop.name, stop.hidden]),
    [
      ["Marienplatz", false],
      ["Raubling", true],
      ["Kufstein", true],
      ["Innsbruck Hbf", false],
    ],
  );
  assert.deepEqual(
    route.rules.map((rules) => rules.length),
    [0, 0, 1],
  );
  assert.deepEqual(
    parseRoute("Kufstein -[allow:longdistance]> Innsbruck")!.rules.map((rules) => rules.length),
    [1],
  );
  assert.equal(
    parseRoute("Garmisch-Partenkirchen -> Mittenwald")!.stops[0].name,
    "Garmisch-Partenkirchen",
  );
  assert.equal(parseRoute("Hauptbahnhof (U-Bahn/Tram) -> Ost")!.stops[0].hidden, false);
});

test("a long-distance train from Kufstein is allowed, from Munich it isn't", () => {
  const fromKufstein = journey(
    ride("METRO", at.marienplatz, at.ost),
    ride("REGIONAL_RAIL", at.ost, at.raubling, at.kufstein),
    ride("HIGHSPEED_RAIL", at.kufstein, at.innsbruck),
  );
  const fromMunich = journey(
    ride("METRO", at.marienplatz, at.ost),
    ride("HIGHSPEED_RAIL", at.ost, at.raubling, at.kufstein, at.innsbruck),
  );
  assert.equal(allowedOnRoute(fromKufstein, route, routeStops, noLongDistance), true);
  assert.equal(allowedOnRoute(fromMunich, route, routeStops, noLongDistance), false);
});

test("a regional train through Kufstein is allowed; an ICE ending there isn't", () => {
  assert.equal(
    allowedOnRoute(
      journey(ride("REGIONAL_RAIL", at.marienplatz, at.raubling, at.kufstein, at.innsbruck)),
      route,
      routeStops,
      noLongDistance,
    ),
    true,
  );
  const ice = journey(
    ride("HIGHSPEED_RAIL", at.marienplatz, at.raubling, at.kufstein),
    ride("HIGHSPEED_RAIL", at.kufstein, at.innsbruck),
  );
  assert.equal(allowedOnRoute(ice, route, routeStops, noLongDistance), false);
});

test("without screen rules, everything is allowed", () => {
  assert.equal(
    allowedOnRoute(
      journey(ride("HIGHSPEED_RAIL", at.marienplatz, at.innsbruck)),
      route,
      routeStops,
      [],
    ),
    true,
  );
});

test("deny and allow combine: the last rule mentioning a mode decides", () => {
  const stops = [at.marienplatz, at.innsbruck];
  const noBus = parseRoute("Marienplatz -[deny:bus]> Innsbruck")!;
  assert.equal(
    allowedOnRoute(
      journey(ride("BUS", at.marienplatz, at.innsbruck)),
      noBus,
      stops,
      noLongDistance,
    ),
    false,
  );
  assert.equal(
    allowedOnRoute(
      journey(ride("TRAM", at.marienplatz, at.innsbruck)),
      noBus,
      stops,
      noLongDistance,
    ),
    true,
  );
  const noCoach = parseRoute("Marienplatz -[allow:longdistance, deny:coach]> Innsbruck")!;
  assert.equal(
    allowedOnRoute(
      journey(ride("HIGHSPEED_RAIL", at.marienplatz, at.innsbruck)),
      noCoach,
      stops,
      noLongDistance,
    ),
    true,
  );
  assert.equal(
    allowedOnRoute(
      journey(ride("COACH", at.marienplatz, at.innsbruck)),
      noCoach,
      stops,
      noLongDistance,
    ),
    false,
  );
});

test("without the route's stop coordinates, a ride must be allowed on every stretch", () => {
  const fromKufstein = journey(
    ride("REGIONAL_RAIL", at.marienplatz, at.kufstein),
    ride("HIGHSPEED_RAIL", at.kufstein, at.innsbruck),
  );
  assert.equal(allowedOnRoute(fromKufstein, route, undefined, noLongDistance), false);
});

test("unknown rules are ignored", () => {
  assert.equal(parseRules("allow:highspeed deny:longdistance", "test").length, 1);
});
