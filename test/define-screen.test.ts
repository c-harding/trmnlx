import assert from "node:assert/strict";
import { test } from "node:test";
import { h } from "preact";
import { dataTtl, defineScreen, matchesInput, resolveInputs } from "../src/define-screen.ts";

test("an int input takes only whole numbers, a number input any finite one", () => {
  const int = { type: "int", default: 5 } as const;
  const number = { type: "number", default: 14 } as const;
  assert.ok(matchesInput(int, 3) && matchesInput(int, -2));
  assert.ok(!matchesInput(int, 2.5) && !matchesInput(int, "3") && !matchesInput(int, Infinity));
  assert.ok(matchesInput(number, 12.1) && !matchesInput(number, NaN));
  // A fraction for an int falls back to the default
  assert.deepEqual(resolveInputs({ count: int }, { count: 2.5 }), { count: 5 });
});

const now = new Date("2026-10-12T10:00:00Z");
const inSeconds = (s: number) => now.getTime() + s * 1000;

test("a screen's ttl is capped by when its data expires", () => {
  // Data for 5 min, screen valid for an hour: 5 min
  assert.equal(dataTtl(3600, inSeconds(300), false, now), 300);
  // The screen's own ttl when shorter
  assert.equal(dataTtl(45, inSeconds(300), false, now), 45);
  // Data kept until restart, or no data: unchanged
  assert.equal(dataTtl(3600, Infinity, false, now), 3600);
  assert.equal(dataTtl(Infinity, Infinity, false, now), Infinity);
});

test("data never makes a screen valid for less than a minute (plus margin), unless shown stale", () => {
  // Departures expiring in 55 s on a screen that changes in 62 s: still 62 s, not two wakes
  assert.equal(dataTtl(62, inSeconds(55), false, now), 62);
  assert.equal(dataTtl(3600, inSeconds(10), false, now), 62);
  // Already expired, e.g. a failure kept for 0 s: the same
  assert.equal(dataTtl(3600, inSeconds(-5), false, now), 62);
  // Shown stale: asked for again soon, once the new data has loaded
  assert.equal(dataTtl(60, inSeconds(-30), true, now), 15);
  assert.equal(dataTtl(5, inSeconds(-30), true, now), 5);
});

test("a screen's credits can depend on what it shows", async () => {
  const screen = defineScreen({
    inputs: { drawn: { type: "boolean", default: true } },
    ttl: () => 60,
    credits: ({ inputs }) => (inputs.drawn ? [{ text: "© Example", url: "https://example.org/" }] : []),
    view: () => h("div", null),
  });
  const render = (drawn: boolean) => screen.render({ device: { username: "x", timeZone: "UTC" }, now, telemetry: undefined, inputs: { drawn } });
  assert.deepEqual((await render(true)).credits, [{ text: "© Example", url: "https://example.org/" }]);
  assert.deepEqual((await render(false)).credits, []);
});

test("a screen's label comes from its inputs, with defaults filled in", () => {
  const screen = defineScreen({
    inputs: { title: { type: "string", default: "München" } },
    label: ({ inputs }) => inputs.title,
    ttl: () => 60,
    view: () => h("div", null),
  });
  assert.equal(screen.label({ title: "Graz" }), "Graz");
  assert.equal(screen.label({}), "München");
  // Without a label, or an empty one: none
  assert.equal(defineScreen({ ttl: () => 60, view: () => h("div", null) }).label({}), undefined);
  assert.equal(screen.label({ title: "" }), undefined);
});
