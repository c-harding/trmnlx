// The order a playlist plays in, round by round. Entries keep their places, except those from an
// include with `shuffle: true` (see playlists.ts): each run of entries with the same `shuffle` gets
// a new random order every round. A round is a list of the entries' indices, each once.
import type { PlaylistEntry } from "./playlists.ts";

/** Whether any of a playlist's entries are shuffled. */
export const isShuffled = (playlist: PlaylistEntry[]) =>
  playlist.some((entry) => entry.shuffle !== undefined);

/** The positions each shuffled run covers: [start, end) */
function shuffledRuns(playlist: PlaylistEntry[]): [number, number][] {
  const runs: [number, number][] = [];
  for (let i = 0; i < playlist.length;) {
    const { shuffle } = playlist[i];
    let end = i + 1;
    while (end < playlist.length && shuffle !== undefined && playlist[end].shuffle === shuffle)
      end++;
    if (shuffle !== undefined && end - i > 1) runs.push([i, end]);
    i = end;
  }
  return runs;
}

/** The playlist's own order: the round of a playlist without shuffled entries. */
export const inOrder = (playlist: PlaylistEntry[]) => playlist.map((_entry, i) => i);

/**
 * A new round. `after` is the round it follows, whose last entry it doesn't start with, or
 * `before` the one it comes before (going back), whose first entry it doesn't end with: so no entry
 * shows twice in a row where rounds meet. That can only happen when one run is the whole playlist.
 */
export function newRound(
  playlist: PlaylistEntry[],
  { after, before }: { after?: number[]; before?: number[] } = {},
  random = Math.random,
): number[] {
  const round = inOrder(playlist);
  for (const [start, end] of shuffledRuns(playlist)) {
    // Fisher–Yates, within the run
    for (let i = end - 1; i > start; i--) {
      const j = start + Math.floor(random() * (i - start + 1));
      [round[i], round[j]] = [round[j], round[i]];
    }
  }
  const last = round.length - 1;
  if (after && last > 0 && round[0] === after.at(-1)) [round[0], round[1]] = [round[1], round[0]];
  if (before && last > 0 && round[last] === before[0])
    [round[last], round[last - 1]] = [round[last - 1], round[last]];
  return round;
}

/**
 * Whether a saved round still fits the playlist: each entry once, unshuffled entries in their
 * places, shuffled ones within their run.
 */
export function fitsRound(playlist: PlaylistEntry[], round: unknown): round is number[] {
  if (!Array.isArray(round) || round.length !== playlist.length) return false;
  if (new Set(round).size !== round.length) return false;
  const runs = shuffledRuns(playlist);
  const runOf = (i: number) => runs.find(([start, end]) => start <= i && i < end);
  return round.every((index, i) => {
    if (!Number.isInteger(index) || index < 0 || index >= playlist.length) return false;
    const run = runOf(i);
    return run ? run[0] <= index && index < run[1] : index === i;
  });
}
