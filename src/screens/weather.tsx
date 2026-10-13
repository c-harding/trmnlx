// The weather where the device is (its location in devices.yaml): now, the next 24 hours as a chart
// (temperature, rain and its chance, night shaded from sunset to sunrise), and the next days. From
// Open-Meteo (see sources/open-meteo.ts).
import type { ComponentChildren } from "preact";
import { Battery, Header, PADDING_X, PADDING_Y, RULE } from "../components/header.tsx";
import { type PixelSize, textSize } from "../components/type.ts";
import {
  RaindropIcon,
  SnowflakeIcon,
  SunEventIcon,
  WeatherIcon,
} from "../components/weather-icons.tsx";
import { defineScreen } from "../define-screen.ts";
import { WIDTH } from "../render.ts";
import {
  type Forecast,
  loadWeather,
  OPEN_METEO_CREDIT,
  weatherDescription,
} from "../sources/open-meteo.ts";
import { skyPixels, sunrisesAndSunsets } from "../daylight.ts";
import { encodePngGray } from "../png1bit.ts";
import { temperatureLines } from "../temperature-lines.ts";
import { formatTime } from "../time.ts";

const CONTENT_WIDTH = WIDTH - 2 * PADDING_X;
const HOUR_MS = 3_600_000;
const HOURS = 24;
// The chart: a margin on the left for its scale (the highest and lowest temperature, the 10° lines)
// and the rain rows' symbols; the hours above, the chance and amount of rain below
const MARGIN = 36;
const PLOT_WIDTH = CONTENT_WIDTH - MARGIN;
const HOURS_ROW = 20;
const PLOT_HEIGHT = 134;
const RAIN_ROW = 16;
// The hour ticks at the top of the plot, which the line stays below, as it stays above the bottom
const TICK_HEIGHT = 8;
const TOP_ROOM = TICK_HEIGHT + 6;
const BOTTOM_ROOM = 6;
// The scale's labels, centred on their temperature's height
const SCALE_LABEL_HEIGHT = 18;
// Days after today, in columns
const DAYS = 7;

// Shown in 4 grays (night light gray, rain dark gray), so not every minute: a 4-gray refresh
// flashes. Open-Meteo's current conditions change every 15 minutes
const TTL_SECONDS = 15 * 60;

const degrees = (value: number) => `${Math.round(value)}°`;

/** Where the wind comes from, as one of 8 compass points. */
const compass = (degrees: number) =>
  ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][
    Math.round((((degrees % 360) + 360) % 360) / 45) % 8
  ];

/** Rain or snow over a day, if any: "6 mm", "0.4 mm", "2 cm" (snow). */
function precipitationText(precipitation: number, snowfall: number) {
  if (snowfall >= 0.5) return `${Math.round(snowfall)} cm`;
  if (precipitation < 0.1) return "";
  return precipitation < 10 ? `${precipitation.toFixed(1)} mm` : `${Math.round(precipitation)} mm`;
}

const Text = (props: {
  size: PixelSize;
  bold?: boolean;
  gray?: boolean;
  children: ComponentChildren;
}) => (
  <span
    style={{
      ...textSize(props.size),
      fontWeight: props.bold ? 700 : 400,
      color: props.gray ? "#555" : "#000",
    }}
  >
    {props.children}
  </span>
);

/**
 * The weather now, today's range, the next sunrise and sunset, wind, and rain and snow to come
 * today.
 */
function Now(props: {
  forecast: Forecast;
  now: Date;
  timeZone: string;
  location: { lat: number; lon: number };
}) {
  const { forecast, now, timeZone, location } = props;
  // The next sunrise and the next sunset, from the sun's position like the chart's night; none in
  // polar day or night
  const sunEvents = sunrisesAndSunsets(
    now.getTime(),
    now.getTime() + 2 * 24 * HOUR_MS,
    location.lat,
    location.lon,
  );
  const next = (rise: boolean) => sunEvents.find((event) => event.rise === rise)?.time;
  const { current, days } = forecast;
  const today = days[0];
  // Rain and snow from now until midnight in the place's time zone (the start of tomorrow): the
  // hours ending after now, the current one whole
  const midnight = days[1]?.date ?? Infinity;
  const coming = forecast.hours.filter(
    (hour) => hour.time > now.getTime() && hour.time <= midnight,
  );
  const rain = coming.reduce((sum, hour) => sum + hour.rain, 0);
  const snow = coming.reduce((sum, hour) => sum + hour.snowfall, 0);
  const untilMidnight = [
    rain >= 0.1 && `Rain today ${precipitationText(rain, 0)}`,
    snow >= 0.5 && `Snow today ${precipitationText(0, snow)}`,
  ].filter((line) => line !== false);
  return (
    <div style={{ display: "flex", alignItems: "center", height: 96 }}>
      <WeatherIcon code={current.code} night={!current.isDay} size={80} />
      <span style={{ ...textSize(72), fontWeight: 700, marginLeft: 8, lineHeight: 1 }}>
        {degrees(current.temperature)}
      </span>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, marginLeft: 20, gap: 4 }}>
        <Text size={21} bold>
          {weatherDescription(current.code)}
        </Text>
        <Text size={16}>{`Feels like ${degrees(current.apparentTemperature)}`}</Text>
        <Text size={16}>{`Today ${degrees(today.min)} – ${degrees(today.max)}`}</Text>
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginLeft: 20, gap: 2 }}>
        {([true, false] as const).map((rise) => {
          const time = next(rise);
          return (
            <div key={String(rise)} style={{ display: "flex", alignItems: "center" }}>
              <SunEventIcon rise={rise} size={28} />
              <span style={{ ...textSize(21), marginLeft: 6 }}>
                {time === undefined ? "–" : formatTime(new Date(time), timeZone)}
              </span>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginLeft: 28, gap: 4 }}>
        <Text
          size={16}
        >{`Wind ${Math.round(current.windSpeed)} km/h ${compass(current.windDirection)}`}</Text>
        {(untilMidnight.length > 0 ? untilMidnight : ["Dry today"]).map((line) => (
          <Text key={line} size={16}>
            {line}
          </Text>
        ))}
      </div>
    </div>
  );
}

/** A row of the chart: something in the margin, and what's right of it, `PLOT_WIDTH` wide. */
function Row(props: { height: number; margin?: ComponentChildren; children?: ComponentChildren }) {
  return (
    <div style={{ display: "flex", height: props.height }}>
      <div
        style={{
          display: "flex",
          position: "relative",
          width: MARGIN,
          justifyContent: "flex-end",
          alignItems: "center",
          paddingRight: 6,
          boxSizing: "border-box",
        }}
      >
        {props.margin}
      </div>
      <div style={{ display: "flex", position: "relative", width: PLOT_WIDTH }}>
        {props.children}
      </div>
    </div>
  );
}

/**
 * The next 24 hours from the start of this one: temperature as a black line over dashed lines at
 * round temperatures (see temperatureLines), their values in the margin; night shaded light gray
 * (white by day, dithered in between through twilight); every third hour above, and each hour's
 * chance and amount of rain or snow below.
 */
function Chart(props: {
  forecast: Forecast;
  now: Date;
  timeZone: string;
  location: { lat: number; lon: number };
}) {
  const { forecast, now, timeZone, location } = props;
  const start = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  const end = start + HOURS * HOUR_MS;
  const byTime = new Map(forecast.hours.map((hour) => [hour.time, hour]));
  const slot = PLOT_WIDTH / HOURS;
  const x = (time: number) => ((time - start) / (end - start)) * PLOT_WIDTH;

  // Each hour's rain is Open-Meteo's for the hour ending then
  const slots = Array.from({ length: HOURS }, (_, k) => byTime.get(start + (k + 1) * HOUR_MS));
  // Rain from 0.1 mm and snow from 0.1 cm in an hour count
  const rains = slots.some((hour) => (hour?.rain ?? 0) >= 0.1);
  const snows = slots.some((hour) => (hour?.snowfall ?? 0) >= 0.1);
  // If it's dry, there are no rain rows, and the plot takes their room. (A snow amount's unit,
  // under it, reaches below its row, into the space above the days' rule)
  const plotHeight = rains || snows ? PLOT_HEIGHT : PLOT_HEIGHT + 2 * RAIN_ROW;
  const points = Array.from({ length: HOURS + 1 }, (_, k) => byTime.get(start + k * HOUR_MS))
    .map((hour) => hour && { time: hour.time, temperature: hour.temperature })
    .filter((point) => point !== undefined && Number.isFinite(point.temperature)) as {
    time: number;
    temperature: number;
  }[];

  // The sky behind the chart, as an image: white by day, light gray (#aaa) at night, dithered
  // through twilight (see skyPixels)
  const sky = `data:image/png;base64,${encodePngGray(
    skyPixels(start, end, location.lat, location.lon, PLOT_WIDTH, plotHeight),
    PLOT_WIDTH,
    plotHeight,
  ).toString("base64")}`;

  const temperatures = points.map((point) => point.temperature);
  const lowest = Math.min(...temperatures);
  const highest = Math.max(...temperatures);
  // At least two dashed lines (see temperatureLines), the scale reaching them where they're
  // outside the temperatures
  const gridLines = temperatureLines(lowest, highest);
  const top = Math.max(highest, ...gridLines);
  const bottom = Math.min(lowest, ...gridLines);
  const y = (temperature: number) =>
    TOP_ROOM + ((top - temperature) / (top - bottom)) * (plotHeight - TOP_ROOM - BOTTOM_ROOM);
  // The scale in the margin: the lines' values, each centred on its line (at least 5° apart, so
  // they don't overlap)
  const scale = gridLines.map((value) => ({
    value,
    top: Math.min(
      Math.max(Math.round(y(value)) - SCALE_LABEL_HEIGHT / 2, 0),
      plotHeight - SCALE_LABEL_HEIGHT,
    ),
  }));

  const hourOf = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone });
  const ticks = Array.from({ length: HOURS - 1 }, (_, k) => start + (k + 1) * HOUR_MS).filter(
    (time) => Number(hourOf.format(time)) % 3 === 0,
  );

  // A label `width` wide centred on `left`, or at the edge it would cross
  const centred = (left: number, width: number) => ({
    position: "absolute" as const,
    left: Math.min(Math.max(left - width / 2, 0), PLOT_WIDTH - width),
    width,
    display: "flex",
    justifyContent:
      left < width / 2 ? "flex-start" : left > PLOT_WIDTH - width / 2 ? "flex-end" : "center",
  });

  // Rain in mm without its unit ("0.4"), snow in cm with it under the number, so the two can't be
  // mistaken
  const rainText = (mm: number) => (mm < 10 ? mm.toFixed(1) : String(Math.round(mm)));
  const snowText = (cm: number) => (cm < 1 ? cm.toFixed(1) : String(Math.round(cm)));

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <Row height={HOURS_ROW}>
        {ticks.map((time) => (
          <div
            key={time}
            style={{ ...centred(x(time), 48), top: 2, ...textSize(16), fontWeight: 700 }}
          >
            {formatTime(new Date(time), timeZone)}
          </div>
        ))}
      </Row>
      <Row
        height={plotHeight}
        margin={scale.map(({ value, top }) => (
          <div
            key={value}
            style={{
              position: "absolute",
              right: 6,
              top,
              height: SCALE_LABEL_HEIGHT,
              display: "flex",
              alignItems: "center",
              ...textSize(16),
              fontWeight: 700,
              // Light gray, like the lines' dashes
              color: "#aaa",
            }}
          >
            {degrees(value)}
          </div>
        ))}
      >
        <img
          src={sky}
          width={PLOT_WIDTH}
          height={plotHeight}
          style={{ position: "absolute", left: 0, top: 0 }}
        />
        {/* Positioned like the sky, so it's painted over it (positioned boxes go over the others) */}
        <svg
          width={PLOT_WIDTH}
          height={plotHeight}
          viewBox={`0 0 ${PLOT_WIDTH} ${plotHeight}`}
          style={{ position: "absolute", left: 0, top: 0 }}
        >
          {/* Dashed white and light gray, so it shows by day (the gray dashes) and at night (the
              white ones) */}
          {gridLines.flatMap((value) => [
            <line
              key={`${value}w`}
              x1={0}
              y1={Math.round(y(value))}
              x2={PLOT_WIDTH}
              y2={Math.round(y(value))}
              stroke="#fff"
              strokeWidth={2}
              shapeRendering="crispEdges"
            />,
            <line
              key={`${value}g`}
              x1={0}
              y1={Math.round(y(value))}
              x2={PLOT_WIDTH}
              y2={Math.round(y(value))}
              stroke="#aaa"
              strokeWidth={2}
              strokeDasharray="6 6"
              shapeRendering="crispEdges"
            />,
          ])}
          {/* The top and bottom edges; the hours' ticks hang from the top one */}
          {[1, plotHeight - 1].map((edge) => (
            <line
              key={edge}
              x1={0}
              y1={edge}
              x2={PLOT_WIDTH}
              y2={edge}
              stroke="#000"
              strokeWidth={2}
              shapeRendering="crispEdges"
            />
          ))}
          {ticks.map((time) => (
            <line
              key={time}
              x1={x(time)}
              y1={0}
              x2={x(time)}
              y2={TICK_HEIGHT}
              stroke="#000"
              strokeWidth={2}
              shapeRendering="crispEdges"
            />
          ))}
          <polyline
            points={points.map((point) => `${x(point.time)},${y(point.temperature)}`).join(" ")}
            fill="none"
            stroke="#000"
            strokeWidth={3}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      </Row>
      {/* Only if rain or snow is coming: otherwise the plot takes their room */}
      {(rains || snows) && (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {/* The chance of rain or snow in each hour (from 10%); in the margin a raindrop if rain is
          coming, a snowflake if snow is, neither if it's dry */}
          <Row
            height={RAIN_ROW}
            margin={
              <div style={{ display: "flex", gap: 2 }}>
                {rains && <RaindropIcon size={12} />}
                {snows && <SnowflakeIcon size={12} />}
              </div>
            }
          >
            {slots.map((hour, k) => (
              <div
                key={k}
                style={{ display: "flex", justifyContent: "center", width: slot, ...textSize(12) }}
              >
                {hour && hour.precipitationProbability >= 10
                  ? `${hour.precipitationProbability}%`
                  : ""}
              </div>
            ))}
          </Row>
          {/* How much rain (black) or snow (dark gray, in cm) in each hour; "mm" in the margin, or "cm"
          if there's only snow, nothing if it's dry. An hour with both shows its snow */}
          <Row
            height={RAIN_ROW}
            margin={(rains || snows) && <span style={textSize(12)}>{rains ? "mm" : "cm"}</span>}
          >
            {slots.map((hour, k) => (
              <div
                key={k}
                style={{
                  display: "flex",
                  justifyContent: "center",
                  width: slot,
                  ...textSize(12),
                  fontWeight: 700,
                }}
              >
                {hour && hour.snowfall >= 0.1 ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      color: "#555",
                      lineHeight: 1,
                    }}
                  >
                    <span>{snowText(hour.snowfall)}</span>
                    <span style={{ fontWeight: 400 }}>cm</span>
                  </div>
                ) : hour && hour.rain >= 0.1 ? (
                  rainText(hour.rain)
                ) : (
                  ""
                )}
              </div>
            ))}
          </Row>
        </div>
      )}
    </div>
  );
}

/** The next days: the day, its weather, its highest and lowest temperature, and rain or snow. */
function Days({ forecast }: { forecast: Forecast }) {
  const weekday = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    timeZone: forecast.timeZone,
  });
  return (
    // Under a rule like the header's, apart from the hours above
    <div
      style={{ display: "flex", borderTop: `${RULE}px solid #000`, marginTop: 8, paddingTop: 8 }}
    >
      {forecast.days.slice(1, 1 + DAYS).map((day, i) => (
        <div
          key={day.date}
          style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}
        >
          {/* The first "Tomorrow"; the others by name, from noon, so a day starting at a time
              change is still that day */}
          <Text size={16} bold>
            {i === 0 ? "Tomorrow" : weekday.format(day.date + 12 * HOUR_MS)}
          </Text>
          <WeatherIcon code={day.code} size={44} />
          <div style={{ display: "flex", gap: 8 }}>
            <Text size={21} bold>
              {degrees(day.max)}
            </Text>
            <Text size={21} gray>
              {degrees(day.min)}
            </Text>
          </div>
          <Text size={16}>{precipitationText(day.precipitation, day.snowfall)}</Text>
        </div>
      ))}
    </div>
  );
}

export default defineScreen({
  inputs: {
    // Shown above the weather, e.g. the place's name; empty: "Weather"
    title: { type: "string", default: "" },
  },

  // In the browser's lists, e.g. "weather: München"
  label: ({ inputs }) => inputs.title,

  dependencies: {
    // None without the device's coordinates (an empty list: no call), see `view`
    weather: [
      loadWeather,
      ({ device }) =>
        device.location
          ? [{ lat: device.location.lat, lon: device.location.lon }]
          : ([] as { lat: number; lon: number }[]),
    ],
  },

  prepare: ({ device, dependencies: { weather } }) =>
    device.location ? (weather[0] ?? { error: "no forecast" }) : undefined,

  credits: ({ data }) => (data?.forecast ? [OPEN_METEO_CREDIT] : []),

  ttl: () => TTL_SECONDS,

  view({ device, inputs, now, telemetry, data }) {
    const message = !data
      ? "No location for the weather: add lat and lon to the device's location (or the top-level one) in devices.yaml"
      : !data.forecast
        ? `Weather unavailable: ${data.error}`
        : undefined;
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          boxSizing: "border-box",
          padding: `${PADDING_Y}px ${PADDING_X}px`,
          background: "#fff",
          color: "#000",
          fontFamily: "Noto Sans",
        }}
      >
        <Header title={inputs.title || "Weather"}>
          {/* The data's source, as the credits say in the browser, left of the battery */}
          <div style={{ display: "flex", alignItems: "center" }}>
            {data?.forecast && (
              <span style={{ ...textSize(16), marginRight: 16 }}>{OPEN_METEO_CREDIT.text}</span>
            )}
            <Battery telemetry={telemetry} />
          </div>
        </Header>
        {message || !data?.forecast ? (
          <div
            style={{
              display: "flex",
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
              padding: 40,
              ...textSize(21),
            }}
          >
            {message}
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              justifyContent: "space-between",
            }}
          >
            <Now
              forecast={data.forecast}
              now={now}
              timeZone={device.timeZone}
              location={device.location!}
            />
            <Chart
              forecast={data.forecast}
              now={now}
              timeZone={device.timeZone}
              location={device.location!}
            />
            <Days forecast={data.forecast} />
          </div>
        )}
      </div>
    );
  },
});
