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
function counting<T>(
  options: { maxAge: number | ((value: T) => number); refreshAhead?: (value: T) => number; staleUntil?: (value: T) => number },
  value: () => T,
) {
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
    staleUntil: options.staleUntil,
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

// Lets background loads finish
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("staleUntil shows an expired result while the next one loads in the background", async () => {
  let n = 0;
  const start = clock;
  const { source, loads } = counting<{ n: number }>({ maxAge: 1000, staleUntil: () => start + 5000 }, () => ({ n: ++n }));
  assert.equal((await source({ n: 1 })).n, 1);
  clock += 2000; // expired, but before staleUntil: answered straight away
  assert.equal((await source({ n: 1 })).n, 1);
  assert.equal((await source({ n: 1 })).n, 1);
  await settle();
  assert.equal(loads(), 2);
  assert.equal((await source({ n: 1 })).n, 2);
});

test("past staleUntil, a request waits for the next result", async () => {
  let n = 0;
  const start = clock;
  const { source, loads } = counting<{ n: number }>({ maxAge: 1000, staleUntil: () => start + 5000 }, () => ({ n: ++n }));
  await source({ n: 1 });
  clock += 6000;
  assert.equal((await source({ n: 1 })).n, 2);
  assert.equal(loads(), 2);
});

test("warm loads ahead only without a result that can be shown", async () => {
  let n = 0;
  const start = clock;
  const { source, loads } = counting<{ n: number }>({ maxAge: 1000, staleUntil: () => start + 5000 }, () => ({ n: ++n }));
  source.warm({ n: 1 }); // nothing yet: loads
  await settle();
  assert.equal(loads(), 1);
  clock += 2000; // expired but can be shown: left alone
  source.warm({ n: 1 });
  await settle();
  assert.equal(loads(), 1);
  clock += 4000; // past staleUntil: loads, and a request then gets the result without loading again
  source.warm({ n: 1 });
  await settle();
  assert.equal(loads(), 2);
  assert.equal((await source({ n: 1 })).n, 2);
  assert.equal(loads(), 2);
});

test("warm does nothing for a source without staleUntil", async () => {
  const { source, loads } = counting({ maxAge: 1000 }, () => 1);
  source.warm({ n: 1 });
  await settle();
  assert.equal(loads(), 0);
});

test("withExpiry says when a result expires and whether it was shown stale", async () => {
  let n = 0;
  const start = clock;
  const { source } = counting<{ n: number }>({ maxAge: 1000, staleUntil: () => start + 5000 }, () => ({ n: ++n }));
  assert.deepEqual(await source.withExpiry({ n: 1 }), { value: { n: 1 }, expiresAt: start + 1000, stale: false });
  clock += 2000;
  assert.deepEqual(await source.withExpiry({ n: 1 }), { value: { n: 1 }, expiresAt: start + 1000, stale: true });
  await settle();
  assert.deepEqual(await source.withExpiry({ n: 1 }), { value: { n: 2 }, expiresAt: clock + 1000, stale: false });
});

test("withExpiry: fresh while refreshing ahead, and the new expiry for a request waiting on a load", async () => {
  let n = 0;
  const start = clock;
  const { source } = counting<{ n: number }>({ maxAge: 1000, refreshAhead: () => 500 }, () => ({ n: ++n }));
  await source({ n: 1 });
  clock += 700; // in the refresh window: answered from the cache, not stale
  assert.deepEqual(await source.withExpiry({ n: 1 }), { value: { n: 1 }, expiresAt: start + 1000, stale: false });
  await settle();
  clock += 2000; // expired, no staleUntil: waits, and gets the new result's expiry
  const [a, b] = await Promise.all([source.withExpiry({ n: 1 }), source.withExpiry({ n: 1 })]);
  assert.deepEqual(a, { value: { n: 3 }, expiresAt: clock + 1000, stale: false });
  assert.deepEqual(b, a);
});
