// The header the screens share: a bold title over a rule, with anything else on the right (e.g.
// battery and clock). Not in src/screens/, where every file is built as a screen.
import type { ComponentChildren } from "preact";
import { batteryText, type Telemetry } from "../telemetry.ts";
import { formatTime } from "../time.ts";

// The space around the screens' content: above and below, and left and right
export const PADDING_Y = 12;
export const PADDING_X = 28;

export const HEADER_HEIGHT = 55; // including its rule
// Between the rule and what's below it
export const HEADER_GAP = 4;
const RULE = 3;
/** How much room a header without its rule takes: what's below can start where the rule would be */
export const HEADER_HEIGHT_WITHOUT_RULE = HEADER_HEIGHT - RULE;

export const ellipsis = { overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" } as const;

/**
 * The title, cut off with "…" if long, leaving room for what's on the right; over a rule unless
 * `rule` is false. Without it, the header ends where the rule would start, with no gap: the title
 * stays where it is, and what's below (e.g. a map) moves up.
 */
export function Header(props: { title: string; titleSize?: number; rule?: boolean; children?: ComponentChildren }) {
  const { title, titleSize = 32, rule = true, children } = props;
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        height: rule ? HEADER_HEIGHT : HEADER_HEIGHT_WITHOUT_RULE,
        boxSizing: "border-box",
        paddingBottom: 8,
        ...(rule ? { borderBottom: `${RULE}px solid #000`, marginBottom: HEADER_GAP } : {}),
      }}
    >
      <div style={{ display: "flex", flex: 1, minWidth: 0, marginRight: children ? 16 : 0, fontSize: titleSize, fontWeight: 700, ...ellipsis }}>
        {title}
      </div>
      {children}
    </div>
  );
}

/** The battery and the time, for the right of the header. */
export function BatteryAndClock(props: { telemetry: Telemetry | undefined; now: Date; timeZone: string }) {
  const { telemetry, now, timeZone } = props;
  return (
    <div style={{ display: "flex", flexShrink: 0, alignItems: "baseline", fontSize: 20 }}>
      {`${batteryText(telemetry)} · `}
      <span style={{ fontWeight: 700, fontSize: 28, marginLeft: 6 }}>{formatTime(now, timeZone)}</span>
    </div>
  );
}
