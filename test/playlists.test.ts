import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { Condition } from "../src/conditions.ts";
import { devicePlaylist, devicePlaylists, expandPlaylist, parseDuration, readDefaultScreen, readLocation, readNamedPlaylists, type ScreenInputs } from "../src/playlists.ts";

const screens: ScreenInputs = {
  placeholder: {},
  "mvg-departures": {
    station: { type: "string", default: "Marienplatz" },
    hide: { type: "list", default: [] },
  },
  journeys: {
    routes: { type: "list", default: [] },
    count: { type: "int", default: 5 },
  },
};
const fallback = { screen: "placeholder", inputs: {} };

/** The message of the error a function throws. */
function errorOf(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail("expected an error");
}

test("a device's screen is a playlist of one", () => {
  assert.deepEqual(devicePlaylist({ screen: "journeys" }, "devices[0]", {}, screens, fallback), [{ screen: "journeys", inputs: {} }]);
});

test("a device without screen or playlist shows the default screen", () => {
  assert.deepEqual(devicePlaylist({}, "devices[0]", {}, screens, fallback), [fallback]);
});

test("a device can't have both screen and playlist", () => {
  assert.match(errorOf(() => devicePlaylist({ screen: "journeys", playlist: [] }, "devices[0]", {}, screens, fallback)), /either screen or playlist/);
});

test("entries keep their inputs", () => {
  const playlist = devicePlaylist(
    { playlist: [{ screen: "mvg-departures", inputs: { station: "Ostbahnhof", hide: ["BUS", "show BUS 54"] } }, { screen: "placeholder" }] },
    "devices[0]",
    {},
    screens,
    fallback,
  );
  assert.deepEqual(playlist, [
    { screen: "mvg-departures", inputs: { station: "Ostbahnhof", hide: ["BUS", "show BUS 54"] } },
    { screen: "placeholder", inputs: {} },
  ]);
});

test("a device can name a playlist, and playlists include others", () => {
  const named = readNamedPlaylists(
    {
      morning: [{ screen: "mvg-departures" }, { playlist: "travel" }],
      travel: [{ screen: "journeys", inputs: { count: 3 } }],
    },
    screens,
  );
  assert.deepEqual(devicePlaylist({ playlist: "morning" }, "devices[0]", named, screens, fallback), [
    { screen: "mvg-departures", inputs: {} },
    { screen: "journeys", inputs: { count: 3 } },
  ]);
  assert.deepEqual(
    expandPlaylist([{ playlist: "travel" }, { screen: "placeholder" }], "devices[0].playlist", named, screens).map((e) => e.screen),
    ["journeys", "placeholder"],
  );
});

test("playlists that include each other are rejected, even if unused", () => {
  const message = errorOf(() => readNamedPlaylists({ a: [{ playlist: "b" }], b: [{ playlist: "a" }] }, screens));
  assert.match(message, /include each other: a → b → a/);
});

test("mistakes in named playlists are found even if no device uses them", () => {
  assert.match(errorOf(() => readNamedPlaylists({ spare: [{ screen: "journeys", inputs: { rooutes: [] } }] }, screens)), /playlists\.spare\[0\]\.inputs\.rooutes/);
});

test("unknown playlist names are rejected", () => {
  assert.match(errorOf(() => devicePlaylist({ playlist: "nope" }, "devices[0]", {}, screens, fallback)), /must name a playlist/);
  assert.match(errorOf(() => expandPlaylist([{ playlist: "nope" }], "devices[0].playlist", {}, screens)), /devices\[0\]\.playlist\[0\]\.playlist must name a playlist/);
});

test("inputs are checked against the screen's", () => {
  const check = (inputs: unknown) => errorOf(() => expandPlaylist([{ screen: "journeys", inputs }], "p", {}, screens));
  assert.match(check({ rooutes: [] }), /p\[0\]\.inputs\.rooutes: journeys has no such input \(it has routes, count\)/);
  assert.match(check({ routes: "Marienplatz -> Ost" }), /p\[0\]\.inputs\.routes must be a list of strings, not a string/);
  assert.match(check({ routes: ["a", 3] }), /must be a list of strings, not a list/);
  assert.match(check({ count: "3" }), /p\[0\]\.inputs\.count must be a whole number, not a string/);
  assert.match(check({ count: 2.5 }), /p\[0\]\.inputs\.count must be a whole number, not a fraction \(2\.5\)/);
  // YAML's .inf and .nan
  assert.match(check({ count: Infinity }), /count must be a whole number, not \.inf \(infinite\)/);
  assert.match(check({ count: NaN }), /count must be a whole number, not \.nan \(not a number\)/);
  assert.match(check({ routes: ["a", 54] }), /not a list with a number at position 2/);
  assert.match(check({ constructor: "x" }), /journeys has no such input/);
  assert.match(check(["routes"]), /inputs must be a mapping/);
});

// What an entry's condition is, in words, to compare in tests
function describeWhen(entry: { when?: Condition }): string {
  const describe = (c: Condition): string =>
    c.kind === "hours" ? c.text : c.kind === "not" ? `not(${describe(c.part)})` : c.kind === "all" || c.kind === "any" ? `${c.kind}(${c.parts.map(describe).join(", ")})` : c.kind;
  return entry.when ? describe(entry.when) : "always";
}

test("when: an entry's own, its include's, and otherwise among its siblings", () => {
  const named = readNamedPlaylists({ travel: [{ screen: "journeys", when: "Sa,Su" }, { screen: "placeholder" }] }, screens);
  const playlist = expandPlaylist(
    [
      { screen: "mvg-departures", when: "Mo-Fr 06:30-09:00" },
      { playlist: "travel", when: "08:00-20:00" },
      { screen: "placeholder", when: "otherwise" },
    ],
    "p",
    named,
    screens,
  );
  assert.deepEqual(playlist.map(describeWhen), [
    "Mo-Fr 06:30-09:00",
    "all(08:00-20:00, Sa,Su)",
    "08:00-20:00",
    // The include counts as applying when any of its entries does: its second one always does
    "not(any(Mo-Fr 06:30-09:00, 08:00-20:00))",
  ]);
});

test("otherwise is resolved within its own playlist, not the ones including it", () => {
  const named = readNamedPlaylists({ inner: [{ screen: "journeys", when: "Sa,Su" }, { screen: "placeholder", when: "otherwise" }] }, screens);
  const playlist = expandPlaylist([{ screen: "mvg-departures", when: "Mo-Fr 06:30-09:00" }, "inner"], "p", named, screens);
  assert.deepEqual(playlist.map(describeWhen), ["Mo-Fr 06:30-09:00", "Sa,Su", "not(Sa,Su)"]);
});

test("mistakes in when stop the server with where they are", () => {
  assert.match(errorOf(() => expandPlaylist([{ screen: "placeholder", when: "Mo-Fx 06:30" }], "p", {}, screens)), /p\[0\]\.when isn't valid opening hours: Mo-F/);
  assert.match(errorOf(() => expandPlaylist([{ screen: "placeholder", when: 9 }], "p", {}, screens)), /p\[0\]\.when must be opening hours such as Mo-Fr 06:30-09:00/);
  assert.match(errorOf(() => expandPlaylist([{ screen: "placeholder", when: "PH off" }], "p", {}, screens)), /p\[0\]\.when: holidays \(PH, SH\) need a location/);
  assert.doesNotThrow(() => expandPlaylist([{ screen: "placeholder", when: "PH off" }], "p", {}, screens, [], { country: "de", state: "Bayern" }));
  assert.match(errorOf(() => readDefaultScreen({ screen: "placeholder", when: "Mo-Fr" }, screens)), /defaultScreen\.when: unknown field/);
  assert.match(
    errorOf(() => expandPlaylist([{ screen: "placeholder", when: "sunrise-sunset" }], "p", {}, screens, [], { country: "de" })),
    /p\[0\]\.when: sunrise, sunset, dawn and dusk need lat and lon in the location/,
  );
  assert.doesNotThrow(() => expandPlaylist([{ screen: "placeholder", when: "(sunrise-01:00)-sunset" }], "p", {}, screens, [], { country: "de", lat: 48.14, lon: 11.58 }));
  assert.match(
    errorOf(() => expandPlaylist([{ screen: "placeholder", when: "SH" }], "p", {}, screens, [], { country: "de" })),
    /p\[0\]\.when: no holidays known for this location \(school holidays, SH, need its state/,
  );
});

test("named playlists with SH are checked without a top-level location (devices may have their own)", () => {
  assert.doesNotThrow(() => readNamedPlaylists({ school: [{ screen: "placeholder", when: "SH" }] }, screens));
});

test("locations: a country code and optionally a state", () => {
  assert.deepEqual(readLocation({ country: "DE", state: "Bayern" }, "location"), { country: "de", state: "Bayern" });
  assert.deepEqual(readLocation({ country: "at" }, "location"), { country: "at" });
  assert.equal(readLocation(undefined, "location"), undefined);
  assert.match(errorOf(() => readLocation({ country: "Germany" }, "devices[0].location")), /devices\[0\]\.location\.country must be a two-letter country code/);
  assert.match(errorOf(() => readLocation("de", "location")), /location must be a country/);
  assert.deepEqual(readLocation({ country: "de", lat: 48.14, lon: 11.58 }, "location"), { country: "de", lat: 48.14, lon: 11.58 });
  assert.match(errorOf(() => readLocation({ country: "de", lat: 48.14 }, "location")), /location: give both lat and lon, or neither/);
  assert.match(errorOf(() => readLocation({ country: "de", lat: 148, lon: 11 }, "location")), /location\.lat must be a number of degrees, from -90 to 90/);
});

test("durations: 90s, 10m, 1h, 1h30m", () => {
  assert.equal(parseDuration("90s", "d"), 90);
  assert.equal(parseDuration("10m", "d"), 600);
  assert.equal(parseDuration("1h", "d"), 3600);
  assert.equal(parseDuration("1h30m", "d"), 5400);
  for (const wrong of ["90", 90, "0m", "", "10 minutes", "1.5h"]) {
    assert.match(errorOf(() => parseDuration(wrong, "p[0].duration")), /p\[0\]\.duration must be a duration such as 90s/);
  }
  assert.match(errorOf(() => parseDuration("5s", "p[0].duration")), /p\[0\]\.duration must be at least 10s/);
});

test("an entry's duration, or its include's for those without one", () => {
  const named = readNamedPlaylists({ travel: [{ screen: "journeys", duration: "10m" }, { screen: "placeholder" }] }, screens);
  assert.deepEqual(expandPlaylist([{ screen: "placeholder", duration: "90s" }, { playlist: "travel", duration: "2m" }, "travel"], "p", named, screens), [
    { screen: "placeholder", inputs: {}, duration: 90 },
    { screen: "journeys", inputs: {}, duration: 600 },
    { screen: "placeholder", inputs: {}, duration: 120 },
    { screen: "journeys", inputs: {}, duration: 600 },
    { screen: "placeholder", inputs: {} },
  ]);
  assert.match(errorOf(() => readDefaultScreen({ screen: "placeholder", duration: "5m" }, screens)), /defaultScreen\.duration: unknown field/);
});

test("playlist names that YAML reads as numbers still work", () => {
  const named = readNamedPlaylists({ 1: [{ screen: "placeholder" }] }, screens);
  assert.deepEqual(devicePlaylist({ playlist: 1 }, "devices[0]", named, screens, fallback), [{ screen: "placeholder", inputs: {} }]);
  assert.deepEqual(expandPlaylist([{ playlist: 1 }], "p", named, screens), [{ screen: "placeholder", inputs: {} }]);
});

test("an entry can't be both a screen and an include", () => {
  assert.match(errorOf(() => expandPlaylist([{ screen: "placeholder", playlist: "x" }], "p", {}, screens)), /p\[0\]: give either screen or playlist, not both/);
});

test("unknown fields and empty playlists are rejected", () => {
  assert.match(errorOf(() => expandPlaylist([{ screen: "placeholder", input: {} }], "p", {}, screens)), /p\[0\]\.input: unknown field/);
  assert.match(errorOf(() => expandPlaylist([], "p", {}, screens)), /p must be a non-empty list/);
  assert.match(errorOf(() => expandPlaylist([true], "p", {}, screens)), /p\[0\] must be a playlist's name or an entry/);
});

test("defaultScreen: a name, screen and inputs, or a sensible default", () => {
  assert.deepEqual(readDefaultScreen("journeys", screens), { screen: "journeys", inputs: {} });
  assert.deepEqual(readDefaultScreen({ screen: "mvg-departures", inputs: { station: "Ostbahnhof" } }, screens), {
    screen: "mvg-departures",
    inputs: { station: "Ostbahnhof" },
  });
  assert.deepEqual(readDefaultScreen(undefined, screens), { screen: "placeholder", inputs: {} });
  assert.deepEqual(readDefaultScreen(undefined, { journeys: {} }), { screen: "journeys", inputs: {} });
  assert.match(errorOf(() => readDefaultScreen("nope", screens)), /^defaultScreen must be one of/);
  assert.match(errorOf(() => readDefaultScreen({ screen: "nope" }, screens)), /^defaultScreen\.screen must be one of/);
  assert.match(errorOf(() => readDefaultScreen({ screen: "placeholder", when: "Mo-Fr" }, screens)), /defaultScreen\.when: unknown field/);
  assert.match(
    errorOf(() => expandPlaylist([{ screen: "placeholder", when: "sunrise-sunset" }], "p", {}, screens, [], { country: "de" })),
    /p\[0\]\.when: sunrise, sunset, dawn and dusk need lat and lon in the location/,
  );
  assert.doesNotThrow(() => expandPlaylist([{ screen: "placeholder", when: "(sunrise-01:00)-sunset" }], "p", {}, screens, [], { country: "de", lat: 48.14, lon: 11.58 }));
  assert.match(
    errorOf(() => expandPlaylist([{ screen: "placeholder", when: "SH" }], "p", {}, screens, [], { country: "de" })),
    /p\[0\]\.when: no holidays known for this location \(school holidays, SH, need its state/,
  );
});

test("named playlists with SH are checked without a top-level location (devices may have their own)", () => {
  assert.doesNotThrow(() => readNamedPlaylists({ school: [{ screen: "placeholder", when: "SH" }] }, screens));
});

test("a name alone in a playlist includes that named playlist", () => {
  const named = readNamedPlaylists({ departures: [{ screen: "mvg-departures" }], travel: [{ screen: "journeys" }, "departures"] }, screens);
  assert.deepEqual(
    devicePlaylist({ playlist: ["departures", "travel"] }, "devices[0]", named, screens, fallback).map((e) => e.screen),
    ["mvg-departures", "journeys", "mvg-departures"],
  );
  assert.match(errorOf(() => readNamedPlaylists({ a: ["a"] }, screens)), /include each other: a → a/);
});

test("a screen's name where a playlist's is expected says how to show the screen", () => {
  assert.match(
    errorOf(() => expandPlaylist(["journeys"], "devices[0].playlist", {}, screens)),
    /devices\[0\]\.playlist\[0\] must name a playlist \(there are none under playlists; for the screen journeys, write screen: journeys\)/,
  );
});

test("an unknown screen is left out with a warning, once; defaultScreen when nothing is left", () => {
  const warnings: string[] = [];
  const warn = mock.method(console, "warn", (message: string) => warnings.push(message));
  try {
    const named = readNamedPlaylists({ travel: [{ screen: "jouneys" }, { screen: "journeys" }] }, screens);
    // Expanded again for a device: the same warning isn't repeated
    assert.deepEqual(devicePlaylist({ playlist: "travel" }, "devices[0]", named, screens, fallback), [{ screen: "journeys", inputs: {} }]);
    assert.deepEqual(warnings, [
      "devices.yaml: playlists.travel[0].screen: there's no screen jouneys (there are placeholder, mvg-departures, journeys), so it's left out",
    ]);
    // Nothing left, or an unknown screen as the device's screen: its defaultScreen
    assert.deepEqual(devicePlaylist({ playlist: [{ screen: "gone" }] }, "devices[1]", {}, screens, fallback), [fallback]);
    assert.deepEqual(devicePlaylist({ screen: "gone" }, "devices[2]", {}, screens, fallback), [fallback]);
    assert.match(warnings.at(-1)!, /devices\[2\]: none of its playlist's screens exist, so it shows defaultScreen \(placeholder\)/);
  } finally {
    warn.mock.restore();
  }
  // The entry's other fields are still checked
  assert.match(errorOf(() => expandPlaylist([{ screen: "gone", duration: "soon" }], "p", {}, screens)), /p\[0\]\.duration must be a duration/);
});

test("a device's playlists: its own as default, then its alternatives in order", () => {
  const named = { travel: [{ screen: "journeys" }], maps: [{ screen: "placeholder" }] };
  const summary = (device: Record<string, unknown>) =>
    devicePlaylists(device, "devices[0]", named, screens, fallback).map(({ name, entries, offered }) => [name, entries.map((e) => e.screen), offered]);
  assert.deepEqual(summary({ playlist: "travel", playlists: { morning: [{ screen: "mvg-departures" }], maps: "maps" } }), [
    ["default", ["journeys"], true],
    ["morning", ["mvg-departures"], true],
    ["maps", ["placeholder"], true],
  ]);
  // A list of named playlists, each under its own name; without a playlist or screen of its own,
  // the default screen, which isn't offered
  assert.deepEqual(summary({ playlists: ["maps", "travel"] }), [
    ["default", ["placeholder"], false],
    ["maps", ["placeholder"], true],
    ["travel", ["journeys"], true],
  ]);
  assert.deepEqual(summary({ screen: "journeys" }), [["default", ["journeys"], true]]);
  // An include's fields alone: of the named playlist of the same name, or the one it gives; nothing:
  // that playlist as it is
  const playlists = devicePlaylists(
    { playlists: { maps: { duration: "10m", shuffle: true }, trips: { playlist: "travel" }, travel: null } },
    "devices[0]",
    named,
    screens,
    fallback,
  );
  assert.deepEqual(
    playlists.slice(1).map(({ name, entries }) => [name, entries.map((e) => [e.screen, e.duration, e.shuffle])]),
    [
      ["maps", [["placeholder", 600, "devices[0].playlists.maps[0]"]]],
      ["trips", [["journeys", undefined, undefined]]],
      ["travel", [["journeys", undefined, undefined]]],
    ],
  );
});

test("a device's playlists are checked", () => {
  const named = { travel: [{ screen: "journeys" }] };
  const error = (playlists: unknown) => errorOf(() => devicePlaylists({ playlists }, "devices[0]", named, screens, fallback));
  assert.match(error({ default: "travel" }), /devices\[0\]\.playlists: default is the name of the device's playlist/);
  assert.match(error(["travel", "travel"]), /devices\[0\]\.playlists\[1\]: travel is given twice/);
  assert.match(error([{ screen: "journeys" }]), /devices\[0\]\.playlists\[0\] must be a playlist's name; for entries of its own/);
  assert.match(error(["nope"]), /devices\[0\]\.playlists\.nope must name a playlist \(there are travel\)/);
  assert.match(error("travel"), /devices\[0\]\.playlists must be a mapping of names to playlists, or a list/);
  assert.match(error({ evening: [{ screen: "journeys", inputs: { count: "five" } }] }), /devices\[0\]\.playlists\.evening\[0\]\.inputs\.count must be/);
});

test("an include can be shuffled: its entries are tagged with where it's written, the outer one winning", () => {
  const named = {
    maps: [{ screen: "placeholder" }, { screen: "journeys" }],
    all: [{ playlist: "maps", shuffle: true }, { screen: "mvg-departures" }],
  };
  const tags = (raw: unknown) => expandPlaylist(raw, "devices[0].playlist", named, screens).map((e) => [e.screen, e.shuffle]);
  assert.deepEqual(tags([{ screen: "mvg-departures" }, { playlist: "maps", shuffle: true, duration: "10m" }, { playlist: "maps", shuffle: false }]), [
    ["mvg-departures", undefined],
    ["placeholder", "devices[0].playlist[1]"],
    ["journeys", "devices[0].playlist[1]"],
    ["placeholder", undefined],
    ["journeys", undefined],
  ]);
  // Inside a shuffled include, a shuffled one is shuffled with the rest
  assert.deepEqual(new Set(tags([{ playlist: "all", shuffle: true }]).map(([, tag]) => tag)), new Set(["devices[0].playlist[0]"]));
  assert.deepEqual(tags(["all"]).map(([, tag]) => tag), ["playlists.all[0]", "playlists.all[0]", undefined]);
  assert.match(errorOf(() => tags([{ playlist: "maps", shuffle: "yes" }])), /devices\[0\]\.playlist\[0\]\.shuffle must be true or false/);
  assert.match(errorOf(() => tags([{ screen: "journeys", shuffle: true }])), /devices\[0\]\.playlist\[0\]\.shuffle: unknown field/);
});
