// How light it is outside, from the sun's height: for the weather chart's background, white by day,
// light gray at night, and in between through twilight, dithered; and its sunrises and sunsets.
import { getPosition, getTimes } from "suncalc";

// The sun's centre at sunrise and sunset (its upper edge on the horizon, with refraction), and at
// civil dawn and dusk (as `dawn` and `dusk` in `when`), in degrees
const SUNRISE_ALTITUDE = -0.833;
const DUSK_ALTITUDE = -6;

/** How light it is at `time` (ms since the epoch): 1 while the sun is up, 0 from dusk to dawn. */
export function daylight(time: number, lat: number, lon: number) {
  const { altitude } = getPosition(new Date(time), lat, lon);
  return Math.min(1, Math.max(0, (altitude - DUSK_ALTITUDE) / (SUNRISE_ALTITUDE - DUSK_ALTITUDE)));
}

// A 4 × 4 ordered (Bayer) dither: a pixel is white where the daylight is above its threshold
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((value) => (value + 0.5) / 16));

/**
 * The sky from `start` to `end` across `width` × `height` pixels: white by day, light gray (170) at
 * night, and through twilight a regular pattern of the two, as much white as there's daylight. Only
 * those two grays, so the four grays leave it as it is: a smooth gradient there would be cut into
 * flat bands with dithered edges, which looks streaky where twilight is long.
 */
export function skyPixels(
  start: number,
  end: number,
  lat: number,
  lon: number,
  width: number,
  height: number,
) {
  const light = Array.from({ length: width }, (_, x) =>
    daylight(start + ((x + 0.5) / width) * (end - start), lat, lon),
  );
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels[y * width + x] = light[x] > BAYER[y % 4][x % 4] ? 255 : 170;
    }
  }
  return pixels;
}

/**
 * The sunrises and sunsets from `start` to `end` (ms since the epoch), in order: none where the sun
 * stays up or down (polar day or night).
 */
export function sunrisesAndSunsets(start: number, end: number, lat: number, lon: number) {
  const events = new Map<number, { rise: boolean; time: number }>();
  // Each day's, from the day before to the day after, so none at the ends is missed
  for (let day = start - 86_400_000; day <= end + 86_400_000; day += 86_400_000) {
    const { sunrise, sunset } = getTimes(new Date(day), lat, lon);
    for (const [rise, date] of [
      [true, sunrise],
      [false, sunset],
    ] as const) {
      const time = date?.getTime();
      // By the minute, as neighbouring days can give the same one
      if (time !== undefined && time >= start && time <= end)
        events.set(Math.round(time / 60_000), { rise, time });
    }
  }
  return [...events.values()].sort((a, b) => a.time - b.time);
}
