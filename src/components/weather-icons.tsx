// Weather icons for the weather screen, drawn as SVG in the display's grays: outlines in black,
// clouds filled white so they cover what's behind them, rain and snow in black. On a 48 × 48 grid,
// scaled to any size.

const STROKE = {
  stroke: "#000",
  strokeWidth: 3,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

// A cloud, its flat base from 12 to 37 at y 34
const CLOUD = "M12 34H37A7 7 0 0 0 37 20A10 10 0 0 0 18 17A8.5 8.5 0 0 0 12 34Z";

function Sun({ x = 24, y = 24, r = 8 }: { x?: number; y?: number; r?: number }) {
  const rays = Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4);
  return (
    <g>
      <circle cx={x} cy={y} r={r} fill="#fff" {...STROKE} />
      {rays.map((a, i) => (
        <line
          key={i}
          x1={x + Math.cos(a) * (r + 4)}
          y1={y + Math.sin(a) * (r + 4)}
          x2={x + Math.cos(a) * (r + 8)}
          y2={y + Math.sin(a) * (r + 8)}
          {...STROKE}
        />
      ))}
    </g>
  );
}

// A crescent, open to the lower right
const Moon = ({ x = 24, y = 24, r = 12 }: { x?: number; y?: number; r?: number }) => (
  <path
    d={`M${x + r * 0.35} ${y - r * 0.95}A${r} ${r} 0 1 0 ${x + r * 0.95} ${y + r * 0.35}A${r * 0.8} ${r * 0.8} 0 0 1 ${x + r * 0.35} ${y - r * 0.95}Z`}
    fill="#fff"
    {...STROKE}
  />
);

/** What an icon shows, from a WMO weather code. */
type Kind =
  "clear" | "partly" | "cloudy" | "fog" | "drizzle" | "rain" | "showers" | "snow" | "thunder";

export function iconKind(code: number): Kind {
  if (code <= 1) return "clear";
  if (code === 2) return "partly";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67) || code === 82) return "rain";
  if (code === 80 || code === 81) return "showers";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "thunder";
  return "cloudy";
}

/** The weather of a WMO code as an icon `size` px square; at night, a moon instead of the sun. */
export function WeatherIcon({
  code,
  size,
  night = false,
}: {
  code: number;
  size: number;
  night?: boolean;
}) {
  const kind = iconKind(code);
  // Called rather than used as components: Satori only takes plain SVG elements inside <svg>
  const sky = night ? Moon({}) : Sun({});
  // Behind a cloud: smaller, to the upper left
  const smallSky = night ? Moon({ x: 17, y: 15, r: 9 }) : Sun({ x: 17, y: 16, r: 6 });
  // The cloud, raised to leave room for what falls from it
  const cloud = (dy: number) => (
    <path d={CLOUD} transform={`translate(0 ${dy})`} fill="#fff" {...STROKE} />
  );
  const drops = (xs: number[], length: number) =>
    xs.map((x, i) => (
      <line
        key={i}
        x1={x}
        y1={33 + (i % 2) * 3}
        x2={x - 3}
        y2={33 + (i % 2) * 3 + length}
        {...STROKE}
      />
    ));
  const parts = {
    clear: [sky],
    partly: [smallSky, cloud(4)],
    cloudy: [cloud(2)],
    fog: [
      cloud(-4),
      ...[34, 41].map((y, i) => (
        <line key={i} x1={10 + i * 4} y1={y} x2={38 + i * 2} y2={y} {...STROKE} />
      )),
    ],
    drizzle: [cloud(-6), ...drops([18, 26, 34], 3)],
    rain: [cloud(-6), ...drops([16, 23, 30, 37], 8)],
    showers: [smallSky, cloud(-2), ...drops([22, 30], 7)],
    snow: [
      cloud(-6),
      ...[16, 24, 32, 40].map((x, i) => (
        <circle key={i} cx={x - 2} cy={36 + (i % 2) * 6} r={2.5} fill="#000" />
      )),
    ],
    thunder: [
      cloud(-6),
      <path
        d="M26 30L19 39H25L21 47L31 36H25L28 30Z"
        fill="#000"
        stroke="#000"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />,
    ],
  }[kind];
  return (
    <svg width={size} height={size} viewBox="0 0 48 48">
      {parts}
    </svg>
  );
}

/** Sunrise or sunset: the sun half below the horizon, with an arrow up or down. */
export function SunEventIcon({ rise, size }: { rise: boolean; size: number }) {
  const arrow = rise ? "M24 3V14M18 8L24 3L30 8" : "M24 3V14M18 9L24 14L30 9";
  return (
    <svg width={size} height={size} viewBox="0 0 48 48">
      <path d="M12 38A12 12 0 0 1 36 38Z" fill="#fff" {...STROKE} />
      <line x1={4} y1={39} x2={44} y2={39} {...STROKE} />
      <path d={arrow} fill="none" {...STROKE} />
    </svg>
  );
}

/** A raindrop, filled black: for the chance of rain. */
export function RaindropIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48">
      <path d="M24 3C24 3 9 22 9 31A15 15 0 0 0 39 31C39 22 24 3 24 3Z" fill="#000" />
    </svg>
  );
}

/** A snowflake, six black arms: for snow. */
export function SnowflakeIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48">
      {[0, 60, 120].map((angle) => (
        <line
          key={angle}
          x1={24 - 20 * Math.sin((angle * Math.PI) / 180)}
          y1={24 - 20 * Math.cos((angle * Math.PI) / 180)}
          x2={24 + 20 * Math.sin((angle * Math.PI) / 180)}
          y2={24 + 20 * Math.cos((angle * Math.PI) / 180)}
          stroke="#000"
          strokeWidth={7}
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}
