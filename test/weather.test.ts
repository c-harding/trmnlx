import assert from "node:assert/strict";
import { test } from "node:test";
import { daylight, skyPixels, sunrisesAndSunsets } from "../src/daylight.ts";
import { temperatureLines } from "../src/temperature-lines.ts";
import { parseForecast, weatherDescription } from "../src/sources/open-meteo.ts";

const H = 3_600_000;
test("daylight: 1 by day, 0 at night, in between through twilight; the sky dithered from it", () => {
  // Munich on 14 October 2026: sunrise about 07:30 and sunset about 18:25 local (UTC+2)
  const at = (utc: string) => Date.parse(`2026-10-14T${utc}Z`);
  assert.equal(daylight(at("10:00"), 48.14, 11.58), 1);
  assert.equal(daylight(at("22:00"), 48.14, 11.58), 0);
  const dusk = daylight(at("16:40"), 48.14, 11.58);
  assert.ok(dusk > 0 && dusk < 1, `${dusk}`);
  // Across a day: white columns by day, light gray ones at night, both in twilight
  const width = 288;
  const sky = skyPixels(at("12:00"), at("12:00") + 24 * H, 48.14, 11.58, width, 4);
  const column = (x: number) => new Set([0, 1, 2, 3].map((y) => sky[y * width + x]));
  assert.deepEqual(column(0), new Set([255]));
  assert.deepEqual(column(width / 2), new Set([170]));
  assert.ok(Array.from({ length: width }, (_, x) => column(x).size).some((size) => size === 2));
  assert.ok(sky.every((value) => value === 170 || value === 255));
  // Polar day in Longyearbyen at midsummer: white all day
  const midsummer = Date.parse("2026-06-21T00:00Z");
  assert.ok(
    skyPixels(midsummer, midsummer + 24 * H, 78.22, 15.65, 24, 4).every((value) => value === 255),
  );
});

test("sunrises and sunsets in order, none in polar day or night", () => {
  const day = 24 * H;
  const munich = sunrisesAndSunsets(
    Date.parse("2026-10-14T00:00Z"),
    Date.parse("2026-10-14T00:00Z") + day,
    48.14,
    11.58,
  );
  assert.deepEqual(
    munich.map((event) => event.rise),
    [true, false],
  );
  // About 07:31 and 18:27 local (UTC+2)
  assert.equal(new Date(munich[0].time).toISOString().slice(11, 13), "05");
  assert.equal(new Date(munich[1].time).toISOString().slice(11, 13), "16");
  const polarDay = Date.parse("2026-06-21T00:00Z");
  assert.deepEqual(sunrisesAndSunsets(polarDay, polarDay + day, 78.22, 15.65), []);
  const polarNight = Date.parse("2026-12-21T00:00Z");
  assert.deepEqual(sunrisesAndSunsets(polarNight, polarNight + day, 78.22, 15.65), []);
});

test("an Open-Meteo answer becomes a forecast, with times in ms", () => {
  const forecast = parseForecast({
    timezone: "Europe/Berlin",
    current: {
      time: 1000,
      temperature_2m: 15.8,
      apparent_temperature: 14.3,
      weather_code: 2,
      is_day: 1,
      wind_speed_10m: 10,
      wind_direction_10m: 291,
      precipitation: 0,
    },
    hourly: {
      time: [3600],
      temperature_2m: [12.4],
      precipitation_probability: [null],
      rain: [0.5],
      showers: [0.25],
      snowfall: [null],
    },
    daily: {
      time: [0],
      weather_code: [80],
      temperature_2m_min: [10.2],
      temperature_2m_max: [17],
      precipitation_sum: [1.1],
      snowfall_sum: [0],
    },
  });
  assert.equal(forecast.current.time, 1_000_000);
  assert.equal(forecast.current.isDay, true);
  assert.deepEqual(forecast.hours, [
    // Rain and showers together
    { time: 3_600_000, temperature: 12.4, precipitationProbability: 0, rain: 0.75, snowfall: 0 },
  ]);
  assert.equal(weatherDescription(forecast.current.code), "Partly cloudy");
});

test("temperature lines: at least two, every 10°, else the 5° or 10° lines the temperatures are closest to", () => {
  assert.deepEqual(temperatureLines(-1, 21), [0, 10, 20]);
  // 14 is closer to 15 than to 10
  assert.deepEqual(temperatureLines(3, 14), [5, 10, 15]);
  assert.deepEqual(temperatureLines(11, 16), [10, 15]);
  // -4 is closer to -5 than to 0, 4.4 to 5
  assert.deepEqual(temperatureLines(-4, 4.4), [-5, 0, 5]);
  // Only 15 among the 5° lines: 10 and 20
  assert.deepEqual(temperatureLines(14, 16), [10, 20]);
  assert.deepEqual(temperatureLines(16, 19), [15, 20]);
  assert.deepEqual(temperatureLines(-7, -3), [-10, 0]);
  assert.deepEqual(temperatureLines(-8, -3), [-10, -5]);
  // Almost flat: the next 5° line on the nearer side
  assert.deepEqual(temperatureLines(12, 12), [10, 15]);
  // Around 15: 14.9 is closest to 10, 15.1 to 20
  assert.deepEqual(temperatureLines(14.9, 15.1), [10, 20]);
  assert.deepEqual(temperatureLines(-12, -12), [-15, -10]);
});
