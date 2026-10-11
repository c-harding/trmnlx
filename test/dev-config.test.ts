import assert from "node:assert/strict";
import { test } from "node:test";
import { durationText, readDevConfig } from "../src/dev-config.ts";
import type { ScreenInputs } from "../src/playlists.ts";

const screens: ScreenInputs = {
  placeholder: {},
  journeys: { routes: { type: "list", default: [] }, count: { type: "number", default: 5 } },
};

const yaml = `
playlists:
  travel:
    - screen: journeys
      inputs:
        routes:
          - Marienplatz -> München Ost
      duration: 10m
devices:
  - mac: "AA:BB:CC:DD:EE:01"
    username: kitchen
    password: secret-password
    token: secret-token
    timezone: Europe/Vienna
    playlist:
      - playlist: travel
        when: Sa,Su
      - screen: placeholder
        when: otherwise
  - mac: "AA:BB:CC:DD:EE:02"
    username: hallway
    password: other-password
    screen: placeholder
`;

test("devices.yaml's entries, by device and named playlist, for the dev server's form", () => {
  assert.deepEqual(readDevConfig(yaml, screens, "UTC"), [
    {
      id: "device/kitchen",
      label: "Device kitchen",
      device: { name: "kitchen", timeZone: "Europe/Vienna" },
      entries: [
        { label: "1. journeys (Sa,Su, 10m)", screen: "journeys", inputs: { routes: ["Marienplatz -> München Ost"] } },
        { label: "2. placeholder (not Sa,Su)", screen: "placeholder", inputs: {} },
      ],
    },
    {
      id: "device/hallway",
      label: "Device hallway",
      device: { name: "hallway", timeZone: "UTC" },
      entries: [{ label: "1. placeholder", screen: "placeholder", inputs: {} }],
    },
    {
      id: "playlist/travel",
      label: "Playlist travel",
      entries: [{ label: "1. journeys (10m)", screen: "journeys", inputs: { routes: ["Marienplatz -> München Ost"] } }],
    },
  ]);
});

test("no password, token or MAC reaches the browser", () => {
  const json = JSON.stringify(readDevConfig(yaml, screens, "UTC"));
  for (const secret of ["secret-password", "secret-token", "other-password", "AA:BB"]) assert.ok(!json.includes(secret), secret);
});

test("an invalid devices.yaml gives the server's message", () => {
  assert.throws(() => readDevConfig("devices:\n  - username: x\n    playlist: nope\n", screens, "UTC"), /devices\[0\]\.playlist must name a playlist/);
});

test("durations are written as in devices.yaml", () => {
  assert.equal(durationText(90), "1m30s");
  assert.equal(durationText(3600), "1h");
  assert.equal(durationText(5400), "1h30m");
});

test("entries are labelled by their screen, e.g. a map by its title", () => {
  const labels = readDevConfig(yaml, screens, "UTC", (screen, inputs) => (screen === "journeys" ? `${(inputs.routes as string[]).length} route(s)` : undefined));
  assert.deepEqual(
    labels.map((group) => group.entries.map((entry) => entry.label)),
    [["1. journeys: 1 route(s) (Sa,Su, 10m)", "2. placeholder (not Sa,Su)"], ["1. placeholder"], ["1. journeys: 1 route(s) (10m)"]],
  );
});
