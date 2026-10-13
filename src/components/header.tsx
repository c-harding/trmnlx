// The header the screens share: a bold title over a rule, with anything else on the right (e.g.
// battery and clock). Not in src/screens/, where every file is built as a screen.
import type { ComponentChildren } from "preact";
import { batteryLines, type Telemetry } from "../telemetry.ts";
import { formatTime } from "../time.ts";
import { type LargeSize, plainEmoji, textSize } from "./type.ts";

// The space around the screens' content: above and below, and left and right
export const PADDING_Y = 6;
export const PADDING_X = 14;

export const HEADER_HEIGHT = 55; // including its rule
// Between the rule and what's below it
export const HEADER_GAP = 4;
export const RULE = 3;
/** How much room a header without its rule takes: what's below can start where the rule would be */
export const HEADER_HEIGHT_WITHOUT_RULE = HEADER_HEIGHT - RULE;

export const ellipsis = {
  overflow: "hidden",
  whiteSpace: "nowrap",
  textOverflow: "ellipsis",
} as const;

/**
 * The title, cut off with "…" if long, leaving room for what's on the right; over a rule unless
 * `rule` is false. Without it, the header ends where the rule would start, with no gap: the title
 * stays where it is, and what's below (e.g. a map) moves up.
 */
// The title's line height: "normal" would take the tallest font in the line, e.g. Noto Sans Symbols'
// for an arrow, and push the title onto the rule. 1.4, as Noto Sans reaches 1.36 em, which the
// overflow (for the "…") would otherwise cut off
const TITLE_LINE_HEIGHT = 1.4;

export function Header(props: {
  title: string;
  titleSize?: LargeSize;
  rule?: boolean;
  children?: ComponentChildren;
}) {
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
      <div
        style={{
          display: "flex",
          flex: 1,
          minWidth: 0,
          marginRight: children ? 16 : 0,
          ...textSize(titleSize),
          lineHeight: TITLE_LINE_HEIGHT,
          fontWeight: 700,
          ...ellipsis,
        }}
      >
        {plainEmoji(title)}
      </div>
      {/* What's on the right, centred in a box as high as the title's line: the title's capitals sit
          in its middle, so they line up */}
      {children && (
        <div
          style={{
            display: "flex",
            alignSelf: "flex-start",
            alignItems: "center",
            flexShrink: 0,
            height: titleSize * TITLE_LINE_HEIGHT,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** The battery, small: the voltage above the charge. */
export function Battery(props: { telemetry: Telemetry | undefined }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        ...textSize(16),
        lineHeight: 1,
      }}
    >
      {batteryLines(props.telemetry).map((line, i) => (
        <span key={i}>{line}</span>
      ))}
    </div>
  );
}

/** The battery and the time, for the right of the header. */
export function BatteryAndClock(props: {
  telemetry: Telemetry | undefined;
  now: Date;
  timeZone: string;
}) {
  const { telemetry, now, timeZone } = props;
  return (
    // Centred in the header's height (not on the title's baseline), the battery beside the clock
    <div
      style={{
        display: "flex",
        alignSelf: "center",
        flexShrink: 0,
        alignItems: "center",
        ...textSize(21),
      }}
    >
      <div style={{ display: "flex", marginRight: 10 }}>
        <Battery telemetry={telemetry} />
      </div>
      <span style={{ fontWeight: 700 }}>{formatTime(now, timeZone)}</span>
    </div>
  );
}
