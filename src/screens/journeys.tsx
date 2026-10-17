// The next connections on one to four routes (see journey-routes.ts for how they're written): one
// route fills the screen; more go side by side in panels (see COLUMNS).
import type { ComponentChildren } from "preact";
import { BatteryAndClock, ellipsis, Header, PADDING_X, PADDING_Y } from "../components/header.tsx";
import { JourneyList } from "../components/journeys.tsx";
import { textSize } from "../components/type.ts";
import { defineScreen } from "../define-screen.ts";
import { parseRoute, parseRules, routeTitle, type Route, type Rule } from "../journey-routes.ts";
import { loadJourneys, TRANSITOUS_CREDITS, type JourneysResult } from "../sources/transitous.ts";
import { untilNextMinute } from "../time.ts";

/** The routes that parse, at most MAX_ROUTES of them (the rest are logged and ignored). */
function validRoutes(texts: string[]) {
  const routes = texts.map(parseRoute).filter((route) => route !== undefined);
  if (routes.length > MAX_ROUTES)
    console.error(`Showing only the first ${MAX_ROUTES} of ${routes.length} routes`);
  return routes.slice(0, MAX_ROUTES);
}

const RULE = "2px solid #000";

// Which routes go in which column, top to bottom, by the number of routes: two side by side;
// three as two stacked on the left and one on the right; four as two by two
const COLUMNS: Record<number, number[][]> = {
  2: [[0], [1]],
  3: [[0, 1], [2]],
  4: [
    [0, 1],
    [2, 3],
  ],
};
const MAX_ROUTES = 4;

function Panel(props: {
  title: string;
  route: Route;
  rules: Rule[];
  result: JourneysResult;
  now: Date;
  count: number;
  timeZone: string;
}) {
  const { title, route, rules, result, now, count, timeZone } = props;
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          ...textSize(21),
          fontWeight: 700,
          paddingBottom: 4,
          borderBottom: "1px solid #000",
          ...ellipsis,
        }}
      >
        {title}
      </div>
      <JourneyList
        route={route}
        rules={rules}
        result={result}
        now={now}
        count={count}
        timeZone={timeZone}
        size="small"
      />
    </div>
  );
}

export default defineScreen({
  inputs: {
    // One route per line (see journey-routes.ts), up to four, placed column by column (see COLUMNS)
    routes: {
      type: "list",
      default: ["München Hbf -> Berlin Ost"],
    },
    // Which transport counts on every route, before each stretch's own rules (see journey-routes.ts):
    // no long-distance trains or coaches, as with a Deutschlandticket
    rules: { type: "string", default: "deny:longdistance" },
    // At most this many per route, as many as fit
    count: { type: "int", default: 8 },
  },

  // Only black and white, as on the other screens that change every minute
  colors: 2,

  credits: TRANSITOUS_CREDITS,

  // In the browser's lists: the first route, and how many more, e.g. "Marienplatz → München Ost (+2)"
  label: ({ inputs }) => {
    const [first, ...more] = validRoutes(inputs.routes);
    return first && routeTitle(first.stops) + (more.length ? ` (+${more.length})` : "");
  },

  dependencies: {
    // One journey search per route
    journeys: [
      loadJourneys,
      ({ inputs }) =>
        validRoutes(inputs.routes).map(({ stops }) => ({
          from: stops[0].name,
          to: stops.at(-1)!.name,
          via: stops.slice(1, -1).map((stop) => stop.name),
        })),
    ],
  },

  prepare: ({ inputs, dependencies: { journeys } }) => ({
    // Each route with its journeys, in the order of the input
    routes: validRoutes(inputs.routes).map((route, i) => ({ route, result: journeys[i] })),
    rules: parseRules(inputs.rules, "the screen's rules"),
  }),

  /** Valid until the clock changes. */
  ttl: ({ now }) => untilNextMinute(now),

  view({ device, inputs, now, telemetry, data }) {
    const { timeZone } = device;
    const routes = data.routes;

    const page = (header: string, body: ComponentChildren) => (
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
          ...textSize(21),
        }}
      >
        <Header title={header}>
          <BatteryAndClock telemetry={telemetry} now={now} timeZone={timeZone} />
        </Header>
        {body}
      </div>
    );

    // One route: the route in the header, and full-size connections
    if (routes.length <= 1) {
      const only = routes[0];
      return page(
        only ? routeTitle(only.route.stops) : "Connections",
        only ? (
          <JourneyList
            route={only.route}
            rules={data.rules}
            result={only.result}
            now={now}
            count={inputs.count}
            timeZone={timeZone}
            size="large"
          />
        ) : (
          <div
            style={{
              display: "flex",
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              ...textSize(32),
            }}
          >
            No routes
          </div>
        ),
      );
    }

    // When all routes start at the same stop, it goes in the header and the panels name the rest
    const start = routes[0].route.stops[0].name;
    const sameStart = routes.every(({ route }) => route.stops[0].name === start);
    const panel = (i: number) => {
      const { route, result } = routes[i];
      const title = sameStart ? `→ ${routeTitle(route.stops.slice(1))}` : routeTitle(route.stops);
      return (
        <Panel
          title={title}
          route={route}
          rules={data.rules}
          result={result}
          now={now}
          count={inputs.count}
          timeZone={timeZone}
        />
      );
    };
    const column = (indexes: number[], last: boolean) => (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minWidth: 0,
          ...(last ? { paddingLeft: 14 } : { paddingRight: 14, borderRight: RULE }),
        }}
      >
        {indexes.flatMap((index, i) => [
          ...(i > 0
            ? [<div style={{ display: "flex", borderTop: RULE, marginTop: 6, paddingTop: 6 }} />]
            : []),
          panel(index),
        ])}
      </div>
    );

    return page(
      sameStart ? start : "Connections",
      <div style={{ display: "flex", flex: 1, minHeight: 0, marginTop: 4 }}>
        {COLUMNS[routes.length].map((indexes, i, columns) =>
          column(indexes, i === columns.length - 1),
        )}
      </div>,
    );
  },
});
