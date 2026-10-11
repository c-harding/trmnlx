import assert from "node:assert/strict";
import { test } from "node:test";
import { devicePlaylist, expandPlaylist, parseDuration, readDefaultScreen, readNamedPlaylists, type ScreenInputs } from "../src/playlists.ts";

const screens: ScreenInputs = {
  placeholder: {},
  "mvg-departures": {
    station: { type: "string", default: "Marienplatz" },
    hide: { type: "list", default: [] },
  },
  journeys: {
    routes: { type: "list", default: [] },
    count: { type: "number", default: 5 },
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
  assert.match(errorOf(() => readNamedPlaylists({ spare: [{ screen: "nope" }] }, screens)), /playlists\.spare\[0\]\.screen must be one of/);
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
  assert.match(check({ count: "3" }), /p\[0\]\.inputs\.count must be a number, not a string/);
  assert.match(check({ routes: ["a", 54] }), /not a list with a number at position 2/);
  assert.match(check({ constructor: "x" }), /journeys has no such input/);
  assert.match(check(["routes"]), /inputs must be a mapping/);
});

test("when is rejected until it's built", () => {
  assert.match(errorOf(() => expandPlaylist([{ screen: "placeholder", when: "Mo-Fr" }], "p", {}, screens)), /p\[0\]\.when: not supported yet/);
  assert.match(errorOf(() => expandPlaylist([{ playlist: "x", when: "Mo-Fr" }], "p", { x: [{ screen: "placeholder" }] }, screens)), /p\[0\]\.when: not supported yet/);
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
