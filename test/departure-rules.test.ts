import assert from "node:assert/strict";
import { test } from "node:test";
import { isShown, parseHideRule, parsePin } from "../src/departure-rules.ts";
import type { Departure } from "../src/departure.ts";

test("a pin: types, an arrow and a station; without types, any", () => {
  assert.deepEqual(parsePin("UBAHN -> Hauptbahnhof"), { types: ["UBAHN"], target: "Hauptbahnhof" });
  assert.deepEqual(parsePin("sbahn|UBAHN -> Ostbahnhof"), {
    types: ["SBAHN", "UBAHN"],
    target: "Ostbahnhof",
  });
  assert.deepEqual(parsePin("-> Ostbahnhof"), { types: [], target: "Ostbahnhof" });
  // Without an arrow (the old form), a station or with a space in the types: left out
  assert.equal(parsePin("UBAHN Hauptbahnhof"), undefined);
  assert.equal(parsePin("UBAHN ->"), undefined);
  assert.equal(parsePin("UBAHN 54 -> Ostbahnhof"), undefined);
});

test("hide rules: without types before an arrow, any type", () => {
  const departure = (type: string, line: string, destination: string) =>
    ({ type, line, destination }) as Departure;
  const rules = ["-> Messestadt Ost", "show UBAHN U2 -> Messestadt Ost"].map(parseHideRule);
  assert.deepEqual(rules[0], {
    show: false,
    types: undefined,
    line: undefined,
    destination: "Messestadt Ost",
  });
  const valid = rules.filter((rule) => rule !== undefined);
  assert.equal(isShown(valid, departure("BUS", "139", "Messestadt Ost")), false);
  assert.equal(isShown(valid, departure("UBAHN", "U2", "Messestadt Ost")), true);
  assert.equal(isShown(valid, departure("UBAHN", "U2", "Feldmoching")), true);
  // Types are still needed without an arrow; "*" is no longer a type wildcard
  assert.equal(parseHideRule(""), undefined);
  assert.deepEqual(parseHideRule("* -> X")?.types, ["*"]);
});
