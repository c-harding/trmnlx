import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { canonicalKey, defineSource, paramsOf } from "../src/define-source.ts";

// A clock the tests move by hand
let clock = 0;
const realNow = Date.now;
beforeEach(() => {
  clock = 1_000_000_000_000;
  Date.now = () => clock;
});
afterEach(() => {
  Date.now = realNow;
});

test("canonicalKey: equal for deeply equal values, whatever the field order", () => {
  assert.equal(canonicalKey({ a: 1, b: [1, { y: 2, x: 1 }] }), canonicalKey({ b: [1, { x: 1, y: 2 }], a: 1 }));
  assert.equal(canonicalKey({ a: 1, b: undefined }), canonicalKey({ a: 1 }));
  assert.notEqual(canonicalKey([1, 2]), canonicalKey([2, 1]));
  assert.equal(canonicalKey({ t: new Date(5) }), canonicalKey({ t: new Date(5) }));
  assert.equal(canonicalKey(undefined), "undefined");
});

/** A source counting its loads, with a result per call. */
function counting<T>(options: { maxAge: number | ((value: T) => number); refreshAhead?: (value: T) => number }, value: () => T) {
  let loads = 0;
  const source = defineSource({
    name: "test",
    params: paramsOf<{ n: number }>(),
    async load() {
      loads++;
      return value();
    },
    maxAge: options.maxAge as (value: T) => number,
    refreshAhead: options.refreshAhead,
  });
  return { source, loads: () => loads };
}

test("results are cached for maxAge, then loaded again", async () => {
  const { source, loads } = counting({ maxAge: 1000 }, () => 1);
  await source({ n: 1 });
  await source({ n: 1 });
  assert.equal(loads(), 1);
  clock += 1001;
  await source({ n: 1 });
  assert.equal(loads(), 2);
});

test("different params are cached separately", async () => {
  const { source, loads } = counting({ maxAge: 1000 }, () => 1);
  await source({ n: 1 });
  await source({ n: 2 });
  assert.equal(loads(), 2);
});

test("concurrent requests share one load", async () => {
  const { source, loads } = counting({ maxAge: 1000 }, () => 1);
  await Promise.all([source({ n: 1 }), source({ n: 1 }), source({ n: 1 })]);
  assert.equal(loads(), 1);
});

test("Infinity and NaN keep a result until restart", async () => {
  for (const maxAge of [Infinity, NaN]) {
    const { source, loads } = counting({ maxAge }, () => 1);
    await source({ n: 1 });
    clock += 10 ** 9;
    await source({ n: 1 });
    assert.equal(loads(), 1);
  }
});

test("load gets the previous result once it has expired", async () => {
  const seen: (number | undefined)[] = [];
  let n = 0;
  const source = defineSource({
    name: "test",
    params: paramsOf<{ n: number }>(),
    async load(_params, _dependencies, previous: number | undefined) {
      seen.push(previous);
      return ++n;
    },
    maxAge: 1000,
  });
  await source({ n: 1 });
  clock += 1001;
  await source({ n: 1 });
  assert.deepEqual(seen, [undefined, 1]);
});

test("a load that throws isn't cached", async () => {
  let fail = true;
  const { source, loads } = counting({ maxAge: 1000 }, () => {
    if (fail) throw new Error("boom");
    return 1;
  });
  await assert.rejects(source({ n: 1 }));
  fail = false;
  assert.equal(await source({ n: 1 }), 1);
  assert.equal(loads(), 2);
});

test("refreshAhead answers from the cache and loads the next result in the background", async () => {
  let n = 0;
  const { source, loads } = counting<{ n: number }>({ maxAge: 300_000, refreshAhead: () => 90_000 }, () => ({ n: ++n }));
  assert.equal((await source({ n: 1 })).n, 1);
  clock += 200_000; // 100 s left: not yet
  assert.equal((await source({ n: 1 })).n, 1);
  assert.equal(loads(), 1);
  clock += 30_000; // 70 s left: in the window
  assert.equal((await source({ n: 1 })).n, 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(loads(), 2);
  assert.equal((await source({ n: 1 })).n, 2);
});
