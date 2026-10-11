import assert from "node:assert/strict";
import { test } from "node:test";
import { oneAtATime } from "../src/sources/map.ts";

test("maps are drawn one at a time, a failure not holding up the next", async () => {
  const events: string[] = [];
  const draw = (name: string, fail = false) => async () => {
    events.push(`${name} starts`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    events.push(`${name} ends`);
    if (fail) throw new Error(name);
    return name;
  };
  const results = await Promise.allSettled([oneAtATime(draw("a", true)), oneAtATime(draw("b")), oneAtATime(draw("c"))]);
  assert.deepEqual(events, ["a starts", "a ends", "b starts", "b ends", "c starts", "c ends"]);
  assert.deepEqual(results.map((result) => result.status), ["rejected", "fulfilled", "fulfilled"]);
});
