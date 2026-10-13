import assert from "node:assert/strict";
import { test } from "node:test";
import { fitsRound, inOrder, isShuffled, newRound } from "../src/shuffle.ts";

const entry = (screen: string, shuffle?: string) => ({
  screen,
  inputs: {},
  ...(shuffle === undefined ? {} : { shuffle }),
});
// A fixed entry, a shuffled run of four, another fixed entry
const playlist = [
  entry("clock"),
  entry("a", "p[1]"),
  entry("b", "p[1]"),
  entry("c", "p[1]"),
  entry("d", "p[1]"),
  entry("journeys"),
];
// Random numbers in turn, as Math.random gives them
const sequence =
  (...values: number[]) =>
  () =>
    values.shift() ?? 0;

test("only a shuffled run changes order; the other entries keep their places", () => {
  assert.equal(isShuffled(playlist), true);
  assert.equal(isShuffled([entry("clock")]), false);
  assert.deepEqual(inOrder(playlist), [0, 1, 2, 3, 4, 5]);
  // Fisher–Yates from the run's end: 4 swaps with 1, 3 with 1, 2 with 2
  assert.deepEqual(newRound(playlist, {}, sequence(0, 0, 0.5)), [0, 3, 2, 4, 1, 5]);
  for (let i = 0; i < 50; i++) {
    const round = newRound(playlist);
    assert.equal(fitsRound(playlist, round), true);
    assert.deepEqual([round[0], round[5]], [0, 5]);
  }
});

test("runs from different includes are shuffled apart", () => {
  const two = [entry("a", "p[0]"), entry("b", "p[0]"), entry("c", "p[1]"), entry("d", "p[1]")];
  for (let i = 0; i < 50; i++) {
    const round = newRound(two);
    assert.deepEqual([...round.slice(0, 2)].sort(), [0, 1]);
    assert.deepEqual([...round.slice(2)].sort(), [2, 3]);
  }
});

test("where rounds meet, no entry shows twice in a row", () => {
  const all = [entry("a", "p"), entry("b", "p"), entry("c", "p")];
  // Unchanged, the round would start with 2, which the previous one ended with
  assert.deepEqual(newRound(all, {}, sequence(0.99, 0.99)), [0, 1, 2]);
  assert.deepEqual(newRound(all, { after: [1, 2, 0] }, sequence(0.99, 0.99)), [1, 0, 2]);
  // Going back: it mustn't end with the entry the following round starts with
  assert.deepEqual(newRound(all, { before: [2, 0, 1] }, sequence(0.99, 0.99)), [0, 2, 1]);
  // A single entry can't avoid itself
  assert.deepEqual(newRound([entry("a", "p")], { after: [0] }), [0]);
});

test("a saved round fits only a playlist of the same shape", () => {
  assert.equal(fitsRound(playlist, [0, 4, 3, 2, 1, 5]), true);
  // A fixed entry moved, an entry twice, the wrong length, not a list
  assert.equal(fitsRound(playlist, [1, 0, 3, 2, 4, 5]), false);
  assert.equal(fitsRound(playlist, [0, 1, 1, 2, 4, 5]), false);
  assert.equal(fitsRound(playlist, [0, 1, 2, 3, 4]), false);
  assert.equal(fitsRound(playlist, "0,1,2"), false);
});
