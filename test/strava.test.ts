import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { projection } from "../src/map-drawing.ts";
import {
  configureStrava,
  decodePolyline,
  depthFor,
  loadStravaActivity,
  onContours,
  routeView,
  readStravaApp,
  savedTokenStore,
  type StravaTokens,
} from "../src/sources/strava.ts";

test("devices.yaml's tokens.strava: the app's client ID and secret", () => {
  assert.equal(readStravaApp(undefined), undefined);
  assert.equal(readStravaApp({}), undefined);
  // An unquoted ID is a number in YAML
  assert.deepEqual(readStravaApp({ strava: { client_id: 12345, client_secret: "s" } }), {
    clientId: "12345",
    clientSecret: "s",
  });
  assert.throws(() => readStravaApp({ strava: { client_id: "1" } }), /client_secret/);
  assert.throws(() => readStravaApp("strava"), /tokens must be a mapping/);
});

test("saved tokens: only complete ones count, and changes are written", () => {
  const written: unknown[] = [];
  const store = savedTokenStore(
    (account) =>
      account === "kitchen"
        ? { accessToken: "a", refreshToken: "r", expiresAt: 1 }
        : { accessToken: "a" },
    (_account, tokens) => written.push(tokens),
  );
  assert.deepEqual(store.get("kitchen"), { accessToken: "a", refreshToken: "r", expiresAt: 1 });
  assert.equal(store.get("hallway"), undefined);
  store.set("kitchen", undefined);
  assert.equal(store.get("kitchen"), undefined);
  assert.deepEqual(written, [null]);
});

test("an expired access token is renewed, the new refresh token kept; private activities are skipped", async () => {
  const tokens = new Map<string, StravaTokens | undefined>([
    ["kitchen", { accessToken: "old", refreshToken: "refresh-1", expiresAt: Date.now() - 1000 }],
  ]);
  configureStrava(
    { clientId: "1", clientSecret: "s" },
    { get: (account) => tokens.get(account), set: (account, value) => tokens.set(account, value) },
  );
  const requests: string[] = [];
  const fetchMock = mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    requests.push(String(url));
    if (String(url).includes("/oauth/token")) {
      assert.equal(new URLSearchParams(String(init?.body)).get("refresh_token"), "refresh-1");
      return Response.json({
        access_token: "new",
        refresh_token: "refresh-2",
        expires_at: Date.now() / 1000 + 21600,
      });
    }
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer new");
    return Response.json([
      {
        name: "Secret",
        sport_type: "Run",
        start_date: "2026-10-13T06:00:00Z",
        distance: 1,
        moving_time: 1,
        total_elevation_gain: 0,
        kudos_count: 0,
        private: true,
      },
      {
        name: "Morning run",
        sport_type: "Run",
        start_date: "2026-10-12T06:00:00Z",
        distance: 10_000,
        moving_time: 3000,
        total_elevation_gain: 80,
        kudos_count: 4,
        private: false,
        visibility: "everyone",
        map: { summary_polyline: "abc" },
      },
    ]);
  });
  try {
    const result = await loadStravaActivity({
      account: "kitchen",
      depth: depthFor(0),
      connection: 0,
    });
    assert.ok(result.connected);
    assert.deepEqual(
      result.activities.map((a) => [a.name, a.polyline]),
      [["Morning run", "abc"]],
    );
    assert.equal(tokens.get("kitchen")?.refreshToken, "refresh-2");
    // Twice the default depth (16), as private ones are left out
    assert.match(requests[1], /per_page=32$/);
    assert.equal(requests.length, 2);
    // Not connected: no request at all
    assert.deepEqual(
      await loadStravaActivity({ account: "hallway", depth: depthFor(0), connection: 0 }),
      {
        connected: false,
      },
    );
    assert.equal(requests.length, 2);
  } finally {
    fetchMock.mock.restore();
  }
});

test("a Google encoded polyline decodes to its points (Google's own example)", () => {
  assert.deepEqual(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@"), [
    [38.5, -120.2],
    [40.7, -120.95],
    [43.252, -126.453],
  ]);
});

test("a route's view: centred on it, as far in as it fits with room around it", () => {
  const route: [number, number][] = [
    [48.12, 11.56],
    [48.13, 11.58],
  ];
  const view = routeView(route, 380, 360, 16);
  assert.ok(Math.abs(view.lat - 48.125) < 0.001 && Math.abs(view.lon - 11.57) < 0.001);
  const { toPixel } = projection(view);
  for (const [lat, lon] of route) {
    const { x, y } = toPixel(lat, lon);
    assert.ok(x >= 15 && x <= 365 && y >= 15 && y <= 345, `${x}, ${y}`);
  }
  // Tight in one direction: the width (two points 0.02° of longitude apart, the same latitude)
  const across = projection(
    routeView(
      [
        [48.12, 11.56],
        [48.12, 11.58],
      ],
      380,
      360,
      16,
    ),
  );
  assert.ok(Math.abs(across.toPixel(48.12, 11.56).x - 16) < 1);
  // A short route stops at zoom 16
  assert.equal(
    routeView(
      [
        [48.12, 11.56],
        [48.12001, 11.56001],
      ],
      380,
      360,
      16,
    ).zoom,
    16,
  );
});

test("an activity up to 15 back shares the default request; further back asks for more", () => {
  assert.equal(depthFor(0), 16);
  assert.equal(depthFor(15), 16);
  assert.equal(depthFor(20), 21);
});

test("a contour map for hikes, trail runs and alpine sports with 150 m of relief, or above 1000 m", () => {
  assert.equal(onContours({ sportType: "Hike", relief: 873, highest: 1731 }), true);
  // A city walk: its roofs would show more than its hills
  assert.equal(onContours({ sportType: "Hike", relief: 100, highest: 105 }), false);
  // A short walk on a ridge (Hafelekar): little relief, but in the mountains
  assert.equal(onContours({ sportType: "Hike", relief: 120, highest: 2330 }), true);
  assert.equal(onContours({ sportType: "AlpineSki", relief: 150, highest: 900 }), true);
  // No heights: the sport decides
  assert.equal(onContours({ sportType: "TrailRun", relief: undefined, highest: undefined }), true);
  assert.equal(onContours({ sportType: "Run", relief: 900, highest: 2000 }), false);
});
