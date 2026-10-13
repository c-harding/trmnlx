// Weather forecasts from Open-Meteo (open-meteo.com): free for non-commercial use, without an API
// key, combining national weather services' models (for Germany DWD's ICON) by location. One request
// gives the current weather and the next days by hour and by day (sunrise and sunset come from the
// sun's position instead, see daylight.ts, like the chart's night).
import { defineSource, paramsOf } from "../define-source.ts";
import { USER_AGENT } from "../version.ts";

const BASE_URL = "https://api.open-meteo.com/v1/forecast";
export const OPEN_METEO_CREDIT = { text: "© Open-Meteo", url: "https://open-meteo.com/" };
const TIMEOUT_MS = 10_000;
// Its current conditions are updated every 15 minutes, the forecasts hourly
const MAX_AGE_MS = 15 * 60_000;
const RETRY_MS = 5 * 60_000;
// Today and the next 7 days
const FORECAST_DAYS = 8;

/** The weather now. */
export interface CurrentWeather {
  /** When it was measured or modelled (ms since the epoch) */
  time: number;
  /** °C */
  temperature: number;
  apparentTemperature: number;
  /** WMO weather code (see weatherDescription) */
  code: number;
  isDay: boolean;
  /** km/h, and the direction it comes from in degrees */
  windSpeed: number;
  windDirection: number;
  /** mm in the last 15 minutes */
  precipitation: number;
}

/** One hour of the forecast, ending at `time` (ms since the epoch), as Open-Meteo sums them. */
export interface Hour {
  time: number;
  temperature: number;
  /** % chance of precipitation in the hour before `time` */
  precipitationProbability: number;
  /** In the hour before `time`: rain (and showers) in mm, and fresh snow in cm */
  rain: number;
  snowfall: number;
}

/** One day of the forecast, in the place's time zone. */
export interface Day {
  /** Its start (ms since the epoch) */
  date: number;
  code: number;
  min: number;
  max: number;
  /** mm (rain and snow as water), and snow in cm */
  precipitation: number;
  snowfall: number;
}

export interface Forecast {
  /** The place's time zone, e.g. "Europe/Berlin" */
  timeZone: string;
  current: CurrentWeather;
  hours: Hour[];
  days: Day[];
}

/** A forecast, or why there's none: on a failed refresh, the previous forecast with `error` set. */
export interface WeatherResult {
  forecast?: Forecast;
  error?: string;
}

const HOURLY = [
  "temperature_2m",
  "precipitation_probability",
  "rain",
  "showers",
  "snowfall",
] as const;
const DAILY = [
  "weather_code",
  "temperature_2m_min",
  "temperature_2m_max",
  "precipitation_sum",
  "snowfall_sum",
] as const;
const CURRENT = [
  "temperature_2m",
  "apparent_temperature",
  "weather_code",
  "is_day",
  "wind_speed_10m",
  "wind_direction_10m",
  "precipitation",
] as const;

export interface OpenMeteoResponse {
  timezone: string;
  current: Record<(typeof CURRENT)[number] | "time", number>;
  hourly: Record<(typeof HOURLY)[number] | "time", (number | null)[]>;
  daily: Record<(typeof DAILY)[number] | "time", (number | null)[]>;
}

/** Open-Meteo's answer as a forecast; times are Unix seconds (timeformat=unixtime). */
export function parseForecast(response: OpenMeteoResponse): Forecast {
  const { current, hourly, daily } = response;
  return {
    timeZone: response.timezone,
    current: {
      time: current.time * 1000,
      temperature: current.temperature_2m,
      apparentTemperature: current.apparent_temperature,
      code: current.weather_code,
      isDay: current.is_day === 1,
      windSpeed: current.wind_speed_10m,
      windDirection: current.wind_direction_10m,
      precipitation: current.precipitation,
    },
    hours: hourly.time.map((time, i) => ({
      time: time! * 1000,
      temperature: hourly.temperature_2m[i] ?? NaN,
      precipitationProbability: hourly.precipitation_probability[i] ?? 0,
      rain: (hourly.rain[i] ?? 0) + (hourly.showers[i] ?? 0),
      snowfall: hourly.snowfall[i] ?? 0,
    })),
    days: daily.time.map((time, i) => ({
      date: time! * 1000,
      code: daily.weather_code[i] ?? 0,
      min: daily.temperature_2m_min[i] ?? NaN,
      max: daily.temperature_2m_max[i] ?? NaN,
      precipitation: daily.precipitation_sum[i] ?? 0,
      snowfall: daily.snowfall_sum[i] ?? 0,
    })),
  };
}

/**
 * The forecast for a place (`lat`, `lon` in degrees), in its own time zone: `{ forecast }`, or
 * `{ error }` (with the previous forecast, if any) if it couldn't be fetched.
 */
export const loadWeather = defineSource({
  name: "open-meteo.forecast",
  params: paramsOf<{ lat: number; lon: number }>(),
  async load({ lat, lon }, _dependencies, previous): Promise<WeatherResult> {
    const query = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      current: CURRENT.join(","),
      hourly: HOURLY.join(","),
      daily: DAILY.join(","),
      timezone: "auto",
      forecast_days: String(FORECAST_DAYS),
      timeformat: "unixtime",
    });
    try {
      const res = await fetch(`${BASE_URL}?${query}`, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`);
      return { forecast: parseForecast((await res.json()) as OpenMeteoResponse) };
    } catch (error) {
      const message =
        error instanceof Error && error.name === "TimeoutError"
          ? "Open-Meteo didn't answer in time"
          : error instanceof Error
            ? error.message
            : String(error);
      console.error(`Fetching the weather for ${lat}, ${lon} failed: ${message}`);
      return { forecast: previous?.forecast, error: message };
    }
  },
  maxAge: (result) => (result.error ? RETRY_MS : MAX_AGE_MS),
  // A screen asking just before it expires gets the next forecast without waiting
  refreshAhead: (result) => (result.error ? 0 : 60_000),
});

/** The WMO weather code in words, as Open-Meteo documents them. */
export function weatherDescription(code: number) {
  if (code === 0) return "Clear";
  if (code === 1) return "Mainly clear";
  if (code === 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Fog";
  if (code === 51) return "Light drizzle";
  if (code === 53) return "Drizzle";
  if (code === 55) return "Heavy drizzle";
  if (code === 56 || code === 57) return "Freezing drizzle";
  if (code === 61) return "Light rain";
  if (code === 63) return "Rain";
  if (code === 65) return "Heavy rain";
  if (code === 66 || code === 67) return "Freezing rain";
  if (code === 71) return "Light snow";
  if (code === 73) return "Snow";
  if (code === 75) return "Heavy snow";
  if (code === 77) return "Snow grains";
  if (code === 80) return "Light showers";
  if (code === 81) return "Showers";
  if (code === 82) return "Heavy showers";
  if (code === 85 || code === 86) return "Snow showers";
  if (code === 95) return "Thunderstorm";
  if (code === 96 || code === 99) return "Thunderstorm, hail";
  return "Unknown";
}
