// Which temperatures the weather chart draws a dashed line at: at least two, as round as possible.

const multiples = (step: number, from: number, to: number) => {
  const values: number[] = [];
  // + 0 turns -0 (from rounding e.g. -0.1) into 0, which would otherwise show as "-0°"
  for (let value = Math.ceil(from / step) * step; value <= to; value += step)
    values.push(value + 0);
  return values;
};

/** The multiples of `step` that some temperature from `lowest` to `highest` is closest to. */
const closest = (step: number, lowest: number, highest: number) =>
  multiples(step, Math.round(lowest / step) * step, Math.round(highest / step) * step);

/**
 * At least two lines for a temperature range, the first of these that gives two: every 10° within
 * it; the 5° lines some temperature in it is closest to; the 10° lines likewise. E.g. 21 to -1: 0,
 * 10, 20; 11 to 16: 10, 15; -4 to 4.4: -5, 0, 5 (-4 is closer to -5 than to 0); 14 to 16: 10, 20
 * (only 15 is closest among the 5° lines). An almost flat line gets the next 5° line on its side
 * as well, e.g. 10 and 15 for 12.
 */
export function temperatureLines(lowest: number, highest: number): number[] {
  const tens = multiples(10, lowest, highest);
  if (tens.length >= 2) return tens;
  const fives = closest(5, lowest, highest);
  if (fives.length >= 2) return fives;
  const roundTens = closest(10, lowest, highest);
  if (roundTens.length >= 2) return roundTens;
  const [line] = fives;
  return (lowest + highest) / 2 >= line ? [line, line + 5] : [line - 5, line];
}
