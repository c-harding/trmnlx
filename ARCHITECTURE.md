# Architecture

A rough plan for the server. The device protocol it implements is described in [README.md](README.md).

## Goals

- Serve a small, fixed set of TRMNL devices, configured in `devices.yaml`.
- Show screens we write ourselves. TRMNL plugins and recipes are out of scope.
- Stay small enough to run next to other sites on a 2 GB server: no headless browser, no database.

## Overview

One Node process, running in Docker behind Caddy, which provides HTTPS:

```
device ──► GET /api/display ──► pick next screen from the device's playlist
                                   │
                                   ├─ cached PNG still fresh? ─► reuse it
                                   └─ otherwise: sources ─► screen.prepare() ─► screen.view(data)
                                                   ─► Frame ─► Satori (SVG) ─► sharp (2-bit PNG)
                                   │
                                   ◄── { image_url, filename: hash of PNG, refresh_rate }
device ──► GET <image_url> (with Access-Token) ──► cached PNG
```

## Components

### HTTP API

| Route | Purpose |
|-------|---------|
| `GET /api/setup` | Registers a device from `devices.yaml` by MAC: returns its token, a `friendly_id` (6 hex digits derived from the MAC) and the URL of `/setup.png`. Only while setup is enabled; otherwise HTTP 200 with a body `status` of 404 and a message, which the device shows before trying again in 15 minutes (see [Authentication](#authentication)) |
| `GET /setup.png` | A fixed "Paired" image, downloaded by the firmware right after setup without its token, so it's public |
| `GET /api/display` | Checks the token, renders or reuses the next screen, returns its URL, `filename` and `refresh_rate` |
| `GET /images/<filename>.png` | Serves one of the device's last 3 rendered PNGs (cached in memory). Requires the same `ID` and `Access-Token` headers as `/api/display`, which also identify the device. Sends `Content-Type: image/png` exactly, and a `Content-Length` |
| `POST /api/log` | Checks the token and answers `204`. For now the entries are dropped; later they go to the device's log stream (see [Logs](#logs)) |
| `GET /login`, `POST /login`, `POST /logout` | Browser login with the username and password from `devices.yaml` (see [Browser login](#browser-login)) |
| `GET /` | The logged-in user's device screen: a plain HTML page whose small script fetches `/screen.png` and fetches it again when its `X-TTL` runs out. It says which playlist entry is showing ("journeys (2/3)"), has Prev and Next buttons while more than one entry applies, and captions the preview: "Live preview" if the device got that entry at its last check-in (by entry: the preview is rendered fresh, so its data can be newer than the device's image), otherwise when it will be applied: at the device's next check-in (its last `/api/display` plus the `refresh_rate` it was sent), or "when device comes online" if it has never checked in or is overdue. `/screen.png` sends that text again (`X-Status`), and the script also fetches it shortly after the expected check-in (`X-Check-In`), so the page keeps up. The page is a column as high as the window: the preview shrinks to the height the other lines leave (never enlarged), a click on it toggles its actual size, and the footer (the version deployed, "Logged in as", Log out) sits at the bottom. The version is the commit `scripts/build` built from, with a `*` if files other than Markdown had changes not committed |
| `POST /next`, `POST /previous` | Moves the logged-in user's device to its next or previous playlist entry (wrapping around), then back to `/` |
| `GET /screen.png` | The PNG shown on that page, rendered on each request, with the screen's `ttl` in an `X-TTL` header and the page's playlist text in `X-Status` |
| `GET /logs` | Streams the logged-in user's device logs to the browser as Server-Sent Events |

Image URLs are built from the same base URL the device is configured with, so the firmware sends its credentials with the image request.

### Browser login

- A plain HTML form (no CSS, no JavaScript), so password managers fill it in every browser. The username identifies the device.
- On success the server sets a `session` cookie: a base64url payload `{ u: username, exp }` (30 days) and an HMAC-SHA256 signature over it, keyed with `TOKEN_SECRET` and labelled `session`, so it can't collide with device tokens. A hash of the user's password is part of the signature, so changing a password in `devices.yaml` ends that user's sessions; changing `TOKEN_SECRET` ends all of them (and also breaks every device).
- The cookie is `HttpOnly` and `SameSite=Lax`, and `Secure` when the request came through Caddy's HTTPS (`X-Forwarded-Proto`). `SameSite=Lax` covers CSRF for the only state-changing browser route, logout.
- Passwords are compared in constant time; unknown users take as long as wrong passwords.

### Authentication

- **Tokens are derived, not stored**: `api_key` is the first 22 characters of base64url(HMAC-SHA256(`TOKEN_SECRET`, `"device-token\n" + MAC`)), compared in constant time. The label keeps device tokens apart from session signatures made with the same secret. Deleting a device from `devices.yaml` revokes it, changing `TOKEN_SECRET` revokes all of them.
- **Except for adopted devices**: a device that was paired with another server keeps the token it already has, since the firmware can't be given a new one without a reset. Its `token` field in `devices.yaml` is then used instead of a derived one, both for checking requests and in `/api/setup` answers. Changing a derived token means re-pairing; changing a stored one means editing `devices.yaml` and re-pairing.
- **Rejected tokens get HTTP 401.** The firmware treats any HTTP status other than 200, 301 or 429 as an error: it retries 5 times, shows an error screen and sleeps for its last refresh rate, keeping its token and Wi-Fi settings. Re-adding the device (or restoring the secret) makes it work again on its next wake.
- **Never answer with a body `status` of 500, and only send `reset_firmware: true` deliberately.** Both make the firmware clear all its preferences, including the Wi-Fi credentials, and restart into the captive portal, so someone has to set up Wi-Fi again with a phone.
- **Rotating tokens means re-pairing.** The firmware only calls `/api/setup` when it has no stored token, and the only way to clear it remotely also clears Wi-Fi. A new `TOKEN_SECRET` therefore means setting up each device again by hand.
- **Setup is off by default.** `/api/setup` identifies the device only by its MAC, which isn't secret, so it only answers while `SETUP_ENABLED=1`. `npm run pair` turns it on while a device is being set up and off again afterwards (even on Ctrl+C), and `npm run deploy` forces it off, whatever `dist/.env` says. Rejected requests (wrong token, unknown MAC) get HTTP 401 and are logged with their MAC.
- The server logs a warning at startup while setup is enabled.

### Screens

Every file in `src/screens/` is a screen, named after the file (helpers belong elsewhere). `scripts/build` builds each one as its own entry point with esbuild's code splitting, into `dist/screens/<name>.js` (shared code goes into chunk files next to `server.js`, so it exists once), and `src/screen.ts` imports whatever it finds there at startup. Adding a screen means adding a file; no list to maintain.

A screen module default-exports `defineScreen({ ... })` (`src/define-screen.ts`):

```tsx
export default defineScreen({
  inputs: { station: { type: "string", default: "Marienplatz" } }, // optional: its settings
  colors: 2,                                       // optional: 2 (black and white) or 4 (default)
  dependencies: {                                  // optional: sources, with params from the props
    departures: [loadDepartures, { station: ({ inputs }) => inputs.station, time: ({ now }) => now }],
  },
  prepare({ dependencies }) { /* their results → props.data (synchronous) */ },
  view(props) { /* return JSX layout */ },
  ttl(props) { /* seconds the screen stays valid */ },
});
```

Every function gets the same `props`: `device` (with its `username` and `timeZone`), `now`, `telemetry` and `inputs`. The params functions of `dependencies` get them too; `prepare` also gets the dependencies' results as `dependencies`; `view` and `ttl` get what `prepare` returned as `data` (undefined for screens without `prepare`), not the dependencies themselves.

- `defineScreen` ties the types together: the values in `props.inputs` follow from the definitions (`"list"` gives `string[]`, and every input needs a `default` of its type), each dependency's params are checked against its source, `props.data` has the type `prepare` returns, and `view` and `ttl` are checked against both. Write `dependencies` before `prepare` (and, in a source, before `load`): TypeScript infers the dependencies' types from top to bottom. The other way round shows up as type errors, not as unchecked code. At startup, `src/screen.ts` refuses to start if a screen file's default export didn't come from `defineScreen`.
- Other exports from a screen file are allowed (e.g. `paired`'s layout, which the device API also renders for `/setup.png`), but shared helpers belong outside `src/screens/`: each file there is built as a screen.

- `ttl(props)` returns how many seconds the screen stays valid, including a small safety margin, or `Infinity` if it never changes (the device then wakes at its `refreshRate`, and the browser page doesn't fetch it again); the placeholder's lasts until the next minute plus 2 seconds. The framework caps it by the screen's data (`dataTtl` in `src/define-screen.ts`): no longer than until the earliest of its sources' results expires, so a screen with a long `ttl` still shows new data once its sources would load it; but this cap is never less than a minute plus the same 2 s margin (minute screens' departures last 55 s, which would otherwise mean two wakes a minute), so a minute screen keeps its own `ttl`. A render with data shown stale (see [Sources](#sources)) gets at most 15 seconds, to come back for the new data loading in the background. The device gets `refresh_rate = min(refreshRate, max(ttl − wake time, 5))`, and the browser preview refetches the image when it runs out. The wake time comes from the firmware's `Wake-Time` header (how long its last cycle was awake, in ms): the firmware starts its sleep timer only after downloading and drawing the image, so without the correction each wake lands that much after the screen changed.
- Screens also get the device's latest telemetry (`telemetry`: battery voltage, `RSSI`, firmware version, charging/USB if reported, time seen), taken from the headers of its last `/api/display` and kept per device, saved across restarts (`src/telemetry.ts`, which also has the `batteryText` line used by screens). `/api/display` records it before rendering, so the device's screen shows the readings from that same wake; the browser preview shows the latest ones. The DIY kit reports only a voltage; `batteryPercent` estimates a percentage from a typical lithium discharge curve (4.2 V full, 3.3 V empty), so it's only approximate.
- Screens so far: `placeholder` (name, time, date, battery), `mvg-departures`, `departures`, `journeys` (see below) and `paired` (the image shown after pairing; never changes).
- `mvg-departures` shows as many departures from its `station` input (in Munich, from MVG) as fit, in order of their actual departure. Each row has:
  - the line: a black badge for U-Bahn, S-Bahn (with fully rounded ends) and trains, "Bus 54" or "Tram 18" written out; trains show their type ("REX") rather than their number; labels over 7 characters are set smaller and wrap within 180 px, but only those too long for one line there (over 14 characters) make the row taller;
  - the destination, with MVG's notes for that departure underneath; struck through if cancelled;
  - the time: the actual departure, with the scheduled one struck through before it if they differ; only the scheduled one, struck through, if cancelled;
  - the next two actual departures on the same line in the same direction, small and stacked. MVG's `lineId` includes the direction (`…:H:…`/`…:R:…`) and groups trains that turn back early with the full runs (S3 to Maisach with Mammendorf).

  Times use tabular figures (`fontVariantNumeric: "tabular-nums"`) so they line up. Its `pinned` input lists connections that are always shown, as `<transport types> <station>`, e.g. `UBAHN Hauptbahnhof` or `SBAHN|UBAHN Ostbahnhof` (any of the types): the next direct connection there, in its place in the list if it fits, otherwise at the bottom under a thicker line. These come from MVG's route search, since a train ending at a station never appears in that station's departures; where the connection is also in the departures list, the list's real-time data takes precedence. Its `hide` input lists departures left out of the list, one rule per line as `<transport types> [line] [-> <destination>]`, with `show` in front for an exception (`show BUS 54`; `!BUS 54` works too, but in YAML only quoted, since an unquoted `!` starts a YAML tag); the last matching rule decides. The default hides all buses except the 54, and trams to Amalienburgstraße: `BUS|REGIONAL_BUS`, `show BUS 54`, `TRAM -> Amalienburgstraße`. Hidden departures don't take up rows, and the rules apply to pinned connections too: a pin shows its next connection that isn't hidden (e.g. the next S-Bahn for `SBAHN|UBAHN Ostbahnhof` with `UBAHN` hidden). Invalid rules are logged and ignored. If the station is unknown or MVG can't be reached, it shows "Departures unavailable" rather than "No departures"; a failed fetch isn't cached, so the next request (e.g. the next wake) tries again. Long-distance trains are missing: MVG's data only covers local and regional services (plus night trains); the `journeys` screen has them.
- `departures` shows departures from a stop anywhere Transitous has data (its `station` input, default Innsbruck Hbf), with the same rows as `mvg-departures` (both use `src/components/departures.tsx`, and the shared `Departure` type in `src/departure.ts`): the line as a badge or written out (`BUS`/`COACH` and `TRAM` written out, `METRO`, MOTIS' name for the S-Bahn, with rounded ends), destination, time and the next two times on the same line and direction. Regional trains show their type only ("REX", "CJX", "R", as MVG does), since ÖBB's data names them by train number ("REX 5323"); long-distance trains keep their number ("RJX 19960"). ÖBB's data files some REX trains as `METRO` although their route type is regional rail (106); those count as `REGIONAL_RAIL`. "Same line" is a line code where there is one: ÖBB's data gives every train its own route ID, which starts with what looks like a line code (`…_2-RX2-T-j26-118.TA.…` → `2-RX2-T`, whatever follows left out), so trains with the same code and direction count as one line; trains without one (Railjets) go by type and destination, buses, trams and other datasets by route ID and direction. Its `hide` rules work as in `mvg-departures`, but with Transitous' modes (`BUS`, `TRAM`, `METRO`, `REGIONAL_RAIL`, `HIGHSPEED_RAIL`, …), and `RAIL_REPLACEMENT` for buses replacing trains; by default it hides `BUS|COACH` and `TRAM`, so it shows trains and replacement buses. A replacement bus is one with GTFS route type 714, a name with "SEV", "Ersatz…" or "Schienenersatz…", an ÖBB line name like "SV524", or run by ÖBB's rail company (ÖBB-Personenverkehr; ÖBB's ordinary buses are Postbus'); tested with SV524 at Wiener Neustadt Hbf. Transitous has no notes, and there are no pinned connections. The source is `loadDepartures` in `src/sources/transitous.ts` (`stoptimes`): Transitous merges the datasets serving stops of the same name, e.g. Innsbruck Hbf's trains from ÖBB's data and its trams and buses from Tyrol's; the same train can come from two of them ("RJ 83" from ÖBB's, "89" with train number 83 from DB's), so departures with the same scheduled time and train number are merged, keeping the more telling name. Cached for 55 s, with the previous departures on errors and the same back-off as journey searches.
- `mvg-departures` and `departures` use `colors: 2`: black and white only, rendered at 1 bit per pixel with anti-aliasing thresholded away, so the firmware can use its fast partial refresh instead of a flashing 4-gray refresh every minute (only with `fullRefresh: false`; see the open questions).
- `journeys` shows the next connections on one to four routes, from Transitous. Its `routes` input has one route per line (`src/journey-routes.ts`):
  - stops separated by `->`: from, any via stops in order, to, as Transitous names them, e.g. `Marienplatz -> München Hbf`;
  - a stop in brackets is searched but left out of titles: `Marienplatz -> (Raubling) -> Innsbruck Hbf` shows "Marienplatz → Innsbruck Hbf" (only a stop wholly in brackets: "Hauptbahnhof (U-Bahn/Tram)" is a name);
  - which transport counts is set by rules, `allow:<modes>` and `deny:<modes>`, with a Transitous mode (`bus`, `tram`, `subway` for the U-Bahn, `metro` for the S-Bahn, `regional_rail`, `highspeed_rail`, …) or a group (`longdistance`: high-speed, long-distance and night trains and coaches; `regional`; `local`). The screen's `rules` input (default `deny:longdistance`, as with a Deutschlandticket) applies everywhere; a stretch written `-[rules]>` or `-[rules]->` instead of `->` adds its own after it, and the last rule mentioning a mode decides (without one, it's allowed). The default `Marienplatz -> (Raubling) -> (Kufstein) -[allow:longdistance]> Innsbruck Hbf` allows Railjets, WESTbahn etc. from Kufstein (the Klimaticket Österreich covers them), but not from Munich; `-[allow:longdistance, deny:coach]>` or `-[deny:bus]>` work the same way. WESTbahn and FlixTrain count as `long_distance` and FlixBus as `coach`, although DB's data files them as regional rail or buses. A ride must be allowed on every stretch it covers: rides are placed on the stretches by where they pass the via stops (their boarding, intermediate and alighting stops, matched to the via stops by location within 300 m, since the same station has different IDs in different datasets). If a stop can't be looked up, a ride must be allowed on every stretch of the route.

  Transitous doesn't know these rules: it returns only connections no other one beats, and the filter removes those the rules don't allow afterwards. So a fast through train that is then rejected can keep a regional connection from being returned at all: on `München Ost -> (Kufstein) -[allow:longdistance]> Innsbruck`, the Railjet straight from München Ost (11:33 → 13:18) beats the RE5 + RB54 (10:52 → 13:18), so only the Railjet comes back, and is rejected. A via stop where the rejected trains don't stop avoids this: with `(Raubling)`, only the RB54 qualifies, and the regional connections are returned.

  Of the connections the rules allow, those that another beats (leaving no earlier, arriving no later, with no more changes) are left out; the rules come first, so a train that may not be used never hides one that may.

  Layout by the number of routes: one fills the screen (the route as the title); two side by side; three as two stacked on the left and one at full height on the right; four as two by two (filled column by column). Further routes are logged and ignored. The default is three: Marienplatz to München Ost and to München Hbf on the left, to Innsbruck Hbf (via Raubling and Kufstein) on the right. When all routes start at the same stop, the header shows it and the panels name the rest. `count` (default 5) is the most per route, as many as fit.

  Each connection has its departure and arrival (a delayed time after the planned one struck through), duration and changes, and its rides: line, departure, where to change and arrival. A direct connection takes one line instead: the line in bold, departure → arrival and the duration ("**Bus 54** 09:47 → 09:57 · 10 mins"). If delays (struck-through planned times) leave no room for the duration, it moves to the next line, still on the right. Panels use a smaller type than a single route, since they're half as wide, and their departure → arrival line leaves out struck-through planned times (the rides still show them). Black and white, like the departures screens. Connections differ in height, so each list is a column that wraps (`flexWrap: "wrap"`, `overflow: "hidden"`, each connection full width and `flexShrink: 0`): one that doesn't fit below the others moves to a second column off the right edge, so only whole connections are shown. The parts live in `src/components/journeys.tsx`, since files in `src/screens/` are all built as screens.
- Fetched data is cached per source (see [Sources](#sources)), not as rendered PNGs: `src/sources/mvg.ts` (sources `lookupStation`, `loadDepartures`, `loadConnections`) looks up a station's ID once (kept until restart; failed lookups retried after 30 s), fetches its next 100 departures once per minute (all transport types: MVG leaves out regional trains and buses unless asked), and the route search for each pinned connection (station, target and transport types) once per minute, however many devices and browsers show them. If a fetch fails, the previous list (or connections) is kept, with `error` set. Data is always for the current time: the dev server's time setting only changes the clock and which departures count as gone. MVG's interface is unofficial (the one behind mvg.de) and may change without notice.
- Sources do the fetching and `prepare` the combining; with `view`, this replaces TRMNL's polling and transform scripts.
- `view` returns a layout in JSX: flexbox only, inline styles, the four panel grays (`#000`, `#555`, `#aaa`, `#fff`). Shared pieces (tables, headers, charts as inline SVG) live in a `components/` module.
- Satori sizes boxes like CSS's default `content-box`, so a full-size container with `width: "100%"` and padding ends up wider than the screen. Give such containers `boxSizing: "border-box"`.
- Long text is cut off with `whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"` on one line, or `display: "block", overflow: "hidden", lineClamp: 2` for two lines (both tested). Text that isn't cut off can overflow its box.
- `inputs` declares a screen's settings, each with a type (`string`, `number`, `int` for whole numbers, `boolean` or `list` of strings) and a default. In the dev server a number is a field taking any number (`step="any"`), an `int` one taking whole numbers, a list is a text area with one entry per line (an emptied list stays empty), and the dev server converts the form's text to each input's type. `resolveInputs` takes values that already have their type and fills in the defaults; a value of the wrong type is logged and replaced by the default. The result is `props.inputs`. On the server they come from the device's playlist entry in `devices.yaml` (see [Configuration](#configuration)), checked against these definitions at startup.
- Which screen a device shows: its current `playlist` entry in `devices.yaml`, or `defaultScreen` while none applies (at first the first entry, moved with the screen page's Prev and Next buttons or KEY3, and saved across restarts), or its `screen`, otherwise `defaultScreen` (see [Configuration](#configuration)).

### Sources

A source fetches data, e.g. MVG's departures (`src/sources/*.ts`, `src/define-source.ts`):

```ts
export const loadDepartures = defineSource({
  name: "mvg.departures",
  params: paramsOf<{ station: string }>(),                    // its params type, needed first
  dependencies: {
    station: [lookupStation, { name: ({ params }) => params.station }],
  },
  async load({ station: name }, { station }, previous) { /* fetch, return the result */ },
  maxAge: (result) => (result.error ? 0 : 55_000),             // ms, or a function of the result
});
```

- A source is called like an async function with one params object, and has a `sourceName` (for logs).
- Screens and sources declare what they depend on as `name: [source, params]`: one function per param field, or one function returning the whole params object. If that function returns an array, the source is called once per entry and the result is an array (`mvg-departures`' pinned connections). Dependencies are resolved in parallel before `prepare` or `load` runs.
- A source that throws fails the whole render (HTTP 500). Failures a screen should show are returned as values instead: `lookupStation` returns `null` for an unknown station, and the departures source then returns an `error`, which the screen shows as "Departures unavailable".
- The framework caches each source's results by cache key: the params, or what the optional `cacheKey` makes of them (the pins sort their transport types), compared deeply (object keys sorted, Dates as ISO strings; keys must be plain JSON data or Dates). A result lasts for `maxAge` ms: a number, or a function of the result written after `load` (`lookupStation`: a found station until restart, `null` for 30 s; the departures and route search: 55 s, or not at all if the fetch failed, so the next request tries again). `Infinity` or `NaN` means until restart. Concurrent requests for the same key share one load; on a cache hit, the source's dependencies aren't resolved at all. A load that throws isn't cached, and the next request tries again.
- A source can declare `refreshAhead` (ms, or a function of the result, written after `load`): a request within that time before its result expires is answered from the cache, and starts loading the next result in the background. So no request waits for a slow source, as long as one comes in that window. A background load that fails leaves the cached result as it was; one that throws is logged.
- A slow source can declare `staleUntil` (a function of the result, giving a time in ms since the epoch): until then, an expired result is still answered straight away while the next one loads in the background, instead of the request waiting. Journey searches (about 8 s with via stops, against 0.2 s for the rest) use the departure halfway through their list: departed journeys are hidden anyway, and at least half of the search's journeys are still to come; a search without journeys isn't shown stale.
- Every source has a built-in `warm(params)`, and every screen a `warm(props)` that warms the sources its dependencies would call, without rendering. For a source with `staleUntil`, it starts loading in the background if there's no result that can be shown (none yet, or one both expired and past `staleUntil`); for the others it does nothing, as they're fast enough to load when needed. At startup, at each check-in and each render for the browser, and after each move (Prev, Next, KEY3), the server warms the device's current entry and those one press away (`warmDeviceScreens` in `src/screen.ts`; with `when`, the entries one press away among those that apply), and again whenever a `when` window starts or ends (`warmAtWindowChanges`: a timer per device for the next change). Warming is best-effort: an error in it is logged and changes nothing else. So switching to the journeys screen takes 0.3 s instead of 8 s, and warming only searches again once a search is both expired and past its `staleUntil`, while rendering the screen still refreshes it after `maxAge` as before.
- An expired result stays in the cache: the next load for the same key gets it as `previous`, to fall back to when a fetch fails (the MVG and Transitous sources then return it with `error` set; screens keep showing it, minus what has left, and say "unavailable" only when nothing is left). So entries are kept until restart, one per key: params must be few and stable (a station, a route), never e.g. the current time, which would never hit the cache either.
- `src/sources/transitous.ts` uses Transitous (`api.transitous.org`), a community-run journey planner for Europe on MOTIS, with timetables and live data from many operators (DB, ÖBB, MVG, …) and no API key: `lookupStop` (a name to a stop, kept until restart; `null` retried after 30 s; the first stop in Transitous' ranking, which weighs how important a stop is, rather than an exact name match, which can be a minor stop: the only stop named exactly "Innsbruck Hbf" is a Dutch dataset's, with night trains only, while ÖBB's is "Innsbruck Hauptbahnhof") and `loadJourneys` (from, to, any number of via stops in order, sent comma-separated). Run by volunteers, so journey searches are cached for five minutes; since one takes seconds (up to about 12 with via stops), the next starts in the background 90 s before that (`refreshAhead`, not for failures), and journeys screens are requested every minute, so none waits; a failed search is kept too, so not every request retries: after a 429 (too many requests) for as long as Transitous' `Retry-After` says (seconds or a date), otherwise a minute, and after other errors for 30 s, while the previous journeys are shown; it asks for 12 journeys per search, more than a screen shows (screens leave some out, see below), and the screens leave out those that have left. The number is the same for every screen, so screens showing the same route share one search. Stop IDs depend on the data source (e.g. Innsbruck Hbf comes from ÖBB's data), and live data mostly covers trips in the next hour or so.

### Screen development server

`npm run dev` starts a separate server on http://localhost:7778 (`DEV_PORT`) for developing screens, without `devices.yaml`, `TOKEN_SECRET` or a device (`src/dev-server.ts`). It doesn't check types: run `npm run check`, or rely on the editor. Its page has a screen dropdown (kept in the URL as `?screen=`), the screen's settings (the time, and a field for each of its `inputs`), the device's settings (name, time zone) and what a device sends (battery, charging, USB, `RSSI`, firmware version). Load renders the screen with the same code as the server and shows the PNG with its ttl, colours, size and render time. Like the server's screen page, it renders the screen again when its ttl runs out (not with `Infinity`, and not when the time is set, which would give the same image); if the dev server can't be reached, e.g. while it restarts after a change, it tries again every 2 seconds. An error answer (e.g. an invalid input) stops it until Load is clicked.

`scripts/dev` builds into `.dev/` and watches the code: every save rebuilds (esbuild `--watch`) and restarts the server (`node --watch`). A new file in `src/screens/` needs a restart, since the watcher only knows the entry points it started with.

### Rendering

1. `Frame` wraps the screen's layout and adds overlays that apply to every screen, such as a low-battery warning based on the `Battery-Voltage` header.
2. Satori turns the layout into an 800 × 480 SVG, with text drawn as paths, so no fonts need to be installed. Font files (TTF/OTF/WOFF) are loaded once at startup.
3. sharp converts the SVG to a PNG with a 4-colour palette, stored at 2 bits per pixel: `.grayscale().png({ palette: true, colours: 4, compressionLevel: 9 })`. It must stay under 90,000 bytes; a typical screen is around 4 KB. The firmware picks the display mode from the bit depth and converts palette colours to gray, so this is shown in 4-gray mode.
   - Grayscale screens always get a full refresh, which flashes. A screen that only uses black and white (2-bit with two colours, or 1-bit) gets a fast partial refresh instead, so screens that change often should avoid grays.
4. `filename` is a hash of the PNG, so the device skips the download and the e-ink refresh when nothing changed.

Rendering happens during `/api/display` itself, which is fast enough that no scheduler or job queue is needed. Each screen declares how long its data stays fresh; the rendered PNG is cached in memory until then.

### Playlists

Built as described here (`src/playlists.ts` reads them, `src/conditions.ts` evaluates `when`, `src/device-state.ts` moves through them); each device's position and when its entry started are saved across restarts (see [Storage](#storage)). A device shows a playlist: entries it moves through, each a screen with its inputs. Playlists can be named at the top level of `devices.yaml`, shared by devices and included in each other:

```yaml
playlists:
  morning:
    - screen: mvg-departures
      inputs:
        station: Marienplatz
        hide:
          - BUS|REGIONAL_BUS
          - show BUS 54
  travel:
    - screen: journeys
      duration: 10m
      inputs:
        routes:
          - Marienplatz -> München Ost
          - Marienplatz -> (Raubling) -> (Kufstein) -[allow:longdistance]-> Innsbruck Hbf

location:  # For public and school holidays (PH, SH in `when`); a device can have its own
  country: de
  state: Bayern

devices:
  - username: kitchen
    playlist:
      - playlist: morning
        when: Mo-Fr 06:30-09:00; PH off
      - travel
      - screen: placeholder
        duration: 5m
        when: otherwise
  - username: innsbruck
    location: { country: at, state: Tirol }
    playlist: travel
```

| Field | Meaning |
|-------|---------|
| `screen` | The screen to show |
| `inputs` | Its inputs, typed as the screen defines them (string, number, boolean, list); missing ones take the defaults. So the same screen can appear more than once (e.g. two stations) |
| `duration` | How long the entry stays before the playlist moves on: `90s`, `10m`, `1h`, `1h30m`, at least `10s` (a device wakes at most every 5 s). Without it, the entry stays while its `when` applies |
| `when` | When the entry applies, in the device's time zone, in OpenStreetMap's [`opening_hours`](https://wiki.openstreetmap.org/wiki/Key:opening_hours/specification) syntax: `Mo-Fr 06:30-09:00`, `Sa,Su` (whole days), `22:00-02:00` (over midnight, counting for the day it starts), `Mo-Fr 06:30-09:00; We off` (a later rule replaces earlier ones for its days), `Dec 24 14:00-24:00`, `Mo[1]` (the first Monday of the month), `PH off` (not on public holidays), `SH` (school holidays). Or `otherwise` (see below). Without it, always |
| `playlist` | Instead of `screen`: includes a named playlist's entries here. It can have a `when`, which applies to all of them on top of their own (both must apply), and a `duration`, which applies to those without their own |

`when: otherwise` applies when no other entry of the same playlist applies: the playlist it is written in, not the ones including it, which may have entries of their own (an included playlist counts as applying if any of its entries does). So a playlist covers all times without writing out the gaps, as `placeholder` above does.

A named playlist is a list of entries, whose entries can have their own `when` and `duration` like any other; the playlist itself has none. A device's `playlist` is a list of entries, or the name of a named playlist (`playlist: travel`).

- **Shorthand**: a device's `screen: x` is a playlist of one entry, so existing configurations keep working.
- **Covering all times**: a playlist is meant to cover all times with its entries' `when`s, e.g. departures on weekday mornings and the clock `otherwise`; an entry without `when` applies always. Gaps are allowed: when no entry applies, the device shows `defaultScreen` (a screen's name, or `screen` and `inputs` like an entry).
- **Includes** are written `- playlist: travel`, or just `- travel` when they need nothing else (no `when` or `duration`). They are expanded when `devices.yaml` is read, so a device's playlist is one flat list of entries; an include's `when` and `duration` are applied to its entries then (both its `when` and theirs must apply). `otherwise` is resolved then too, into "none of my siblings applies", with the siblings' full conditions. So each entry ends up with one condition: `opening_hours` expressions combined with `all`, `any` and `not`. (A `duration` for the whole included playlist, rotating within it, would need a position inside it, and isn't planned.)
- **Evaluating conditions**: with the [opening_hours](https://github.com/opening-hours/opening_hours.js) library (npm `opening_hours`, about 1.2 MB loaded, LGPL-3.0), which answers the two questions the playlist needs: does it apply at a time (`getState`), and when does that next change (`getNextChange`, for the device's wake-up time). For `all`, `any` and `not`, the next change is the earliest of the parts' (sometimes a little early: the device then wakes once for nothing). Each expression is parsed once, at startup, where a syntax error stops the server like any other mistake in `devices.yaml`.
- **Time zones**: the library always works in the process's local time zone and takes none as a parameter. So the server sets `process.env.TZ` to the device's time zone around each evaluation (an `inTimeZone(zone, fn)` helper, restoring it in `finally`), for all of a device's entries at once: about 0.4 ms each time, a few times per request (rendering, warming, the page's status), so at most a couple of milliseconds. Playlists without any `when` skip it. Nothing else can run in between, as the switch, the evaluation and the switch back are one synchronous block, and the server's own date formatting always passes an explicit `timeZone`. Tested across the summer/winter time change and over midnight.
- **Holidays**: `PH` and `SH` need a location: `location` at the top level of `devices.yaml` (`country` as a code such as `de` or `at`, and `state` as OpenStreetMap names it, e.g. `Bayern`, `Tirol`), or per device, overriding it. A `when` with `PH` or `SH` and no location stops the server, and `SH` also needs the `state`. `sunrise`, `sunset`, `dawn` and `dusk` are rejected: the library would need real coordinates, and would otherwise silently use fixed times. Public holidays are computed from rules for any year; school holidays come from a snapshot of the [OpenHolidays API](https://openholidaysapi.org) included in the library (from 2020 on, a few years ahead), so the library needs updating every few years to keep them current: past its data (e.g. Tirol's from 2029), the library throws for `SH`. Any error while evaluating a `when` (also for some windows in the hour repeated when summer time ends) is logged, and that entry doesn't apply until it's checked again 5 minutes later, rather than the request failing. The library treats holidays of parts of a state as holidays of the whole state: in Bavaria, the Augsburger Hohes Friedensfest (8 August) counts as a holiday in Munich too, and Mariä Himmelfahrt (15 August) also in mostly Protestant towns. Accepted for Munich; a later rule turns a day back on if it matters: `Mo-Fr 06:30-09:00; PH off; Aug 08 Mo-Fr 06:30-09:00`.
- **Checked at startup**, like the rest of `devices.yaml`: playlist names, input names and types, `duration` and `when` formats, and that includes don't form a cycle. A mistake stops the server rather than showing the wrong thing. An unknown screen is the exception: the entry is left out with a warning (once, however many devices use it), so a renamed or removed screen doesn't take a device offline; a device left with no entries shows `defaultScreen`. `defaultScreen` itself must exist.
- **Inputs in YAML**: lists are best written as block lists (`- …` per line). Routes and hide rules need no quotes there; on one line (`[…]`), the brackets in `-[…]>` confuse YAML. Quote anything starting with `!` (a YAML tag) or containing `: ` (a key), which is why hide exceptions are written `show BUS 54`.
- **Current entry**: kept per device and saved across restarts (see [Storage](#storage)); with `duration`, also the time it started. The playlist moves on when the entry's `duration` has run out, when its own `when` no longer applies, or on a button press (below), and only then works out which entry is next: the next one after the current that applies at that moment, wrapping around. A window that starts doesn't interrupt the current entry: it is only considered at the next move (but an entry that was the only one applying, and whose `duration` is already up, moves on once another starts applying, see below). With nothing applicable, the device shows `defaultScreen`. A device whose saved entry is gone (the playlist changed) starts at the first entry that applies. The entry moved to gets its full `duration` from that moment (one step, however late it's noticed, e.g. after the device was offline), also after a press or the screen page's buttons, including a short press that shows an entry the device hadn't picked up yet. An entry without `duration`, or the only one that applies, stays until a press or the end of its `when`; once another entry starts applying, its `duration` counts again (from when it started). While nothing applies, presses do nothing.
- **Two timings**: the screen's `ttl` says when to render it again (the clock, departure times); the entry's `duration` and `when` say when to move on. The device is told to sleep until the earliest of the screen's `ttl`, the end of the entry's `duration`, the end of its `when` window, and `refreshRate` (minus the wake time, as now). While `defaultScreen` shows, the device wakes when an entry may start applying; while an entry is the only one that applies, its `duration` ends no earlier than another may start applying. `renderDeviceScreen` caps the screen's `ttl` at that moment, plus the same 2 s margin as minute screens, so a device waking slightly early doesn't arrive just before the move; the browser preview's `X-TTL` gets the same cap. The next change of a `when` is looked for up to a day ahead (the device wakes at `refreshRate` anyway).
- **Data**: sources and their caches are shared as before, so entries (or devices) with the same inputs share fetched data.
- **Warming** (see [Sources](#sources)): the current entry and the applicable entries one press away are warmed as now, at check-ins, browser renders and moves, and also whenever a `when` window starts or ends, since that changes which entries are one press away.
- **KEY3** (KEY1 on the 4.26" kit): a short press arrives straight away as a normal `/api/display` with `Update-Source: EXT0` on the DIY kit (`EXT1` on an ESP32, `button` on the C3-based OG) and moves to the next applicable entry, which then gets its full `duration`. The button's special function (a double click, or a 1–5 s hold; 5–15 s resets the Wi-Fi, 15 s or more all settings) arrives with a `special_function: true` header and goes back to the previous applicable entry (wrapping around), which then gets its full `duration`. The firmware runs whichever special function the server last sent in `special_function`, and the response to a press must name it again in `action`. The server sends `guest_mode`: it downloads `image_url` and takes `refresh_rate` like a normal check-in, whereas `rewind` only redraws the device's previous image from flash. A press moves from the entry the device shows: if the screen page's buttons changed the entry since its last check-in, a short press shows the entry chosen there (rather than the one after it), and going back is from the entry on the device. A press moves the playlist once, though the firmware retries a failed request: retries carry the same `Wake-Time` header, and a repeat within 2 minutes is ignored. Edge cases: until a device has had one normal response from this server, its saved special function may be another one (e.g. from TRMNL's cloud), and its first press then moves back without showing it; and setting up Wi-Fi again after a 5–15 s hold counts as a short press. Other keys on the board would need a firmware change (the S3 build wakes on one pin via `ext0`).
- **Browser**: the screen page shows the device's current entry and has "Prev" and "Next" buttons (`POST /previous`, `POST /next`) that move the device's playlist back or on, like KEY3, through the entries that apply. Its position counts those too: "journeys (2/3)" is the second of the three entries that apply now, so the total can change during the day; entries that apply at other times are named in a tooltip on the count. When nothing applies, it says so ("placeholder, the default: nothing in the playlist applies now"), without Prev and Next. The device only picks this up when it next checks in, so the page shows when that is expected: the time of its last `/api/display` plus the `refresh_rate` it was sent. A check-in with an unchanged `filename` costs only the wake (no download, no redraw), so capping `refresh_rate` (e.g. at 5 minutes) shortens this delay for screens that rarely change, at the cost of more wakes.
- **Out of scope for now**: the dev server (it still renders one screen with inputs from its form), and previewing every entry in the browser (an open question).
- **Battery**: the cost is mostly in the wake itself (Wi-Fi and an HTTPS request, around 5–10 s at roughly 100 mA or more), much less in the download and e-ink refresh (a few seconds at tens of mA). At 15-minute intervals the stock 2500 mAh battery lasts about 3–4 months, so roughly 10,000 wakes per charge (the DIY kit's battery and sleep current may differ). Rough estimates:

  | Pattern | Wakes per day | Battery lasts |
  |---------|---------------|---------------|
  | Departures all day, every minute | 1,440 | About 1 week |
  | Departures 06:30–09:00 every minute, otherwise every 15 minutes | About 235 | About 6 weeks |
  | Every 5 minutes | 288 | About 5 weeks |
  | Every 15 minutes | 96 | 3–4 months |

  So the number of wakes matters far more than the number of redraws, and a `when` window around a screen that updates every minute saves the most.

### Logs

Logs are only visible live in a browser; nothing is written to disk.

- **Sources**: entries the device sends to `/api/log`, plus the server's own events for that device: renders, render errors, rejected tokens and setup attempts (a second setup for a device that is already paired is worth noticing).
- **Buffer**: the last ~100 entries per device are kept in memory and sent as soon as a browser connects. The device only sends logs after a failure, often on its next wake, so without the buffer nothing would be visible unless a browser happened to be open at that moment. The buffer is cleared on restart.
- **Streaming**: `/logs` keeps open Server-Sent Events connections in a map from device to connections. Each new entry is sent to every open connection for its device, then added to the buffer. With no connections, it only goes to the buffer.
- **Browser**: the screen page opens an `EventSource`, which reconnects by itself. It sends the session cookie like any same-origin request, so the stream is covered by the same login.
- **Keepalive**: the server sends an SSE comment (`: ping`) every ~30 seconds, because Cloudflare closes connections that stay silent for about 100 seconds.
- **Not on stdout**: device logs aren't printed to stdout, because Docker's default logging driver keeps everything written there, with no rotation.

## Configuration

The server works with a fixed set of devices, configured in `devices.yaml`. The file is deployed with the code, so changes take effect on the next deploy. It contains passwords, so it is gitignored: copy [devices.yaml.sample](devices.yaml.sample) to `devices.yaml` and edit it.

```yaml
devices:
  - mac: "AA:BB:CC:DD:EE:FF"
    username: kitchen
    password: change-me
    timezone: Europe/Berlin
```

| Field      | Required | Meaning |
|------------|----------|---------|
| `mac`      | Yes      | The device's MAC address, as sent in the `ID` header. Always quote it: some YAML parsers read an unquoted all-digit MAC such as `12:34:56:12:34:56` as a number |
| `username` | Yes      | User name for the browser login; it selects which device's screen is shown |
| `password` | Yes      | Password for the browser login |
| `timezone` | No       | IANA time zone for the device's screens, e.g. `Europe/Berlin`. Defaults to `TZ`, then UTC |
| `screen` | No | Which screen the device shows, e.g. `mvg-departures`, with its default inputs: a playlist of one entry. Without it or `playlist`, `defaultScreen` (see below) |
| `playlist` | No | What the device shows, with inputs: a list of entries, or the name of a named playlist (see below). Not together with `screen` |
| `refreshRate` | No     | The longest the device sleeps between polls, in seconds, at least 60. Default 900, the firmware's own default. It wakes sooner when the screen's `ttl` runs out first |
| `fullRefresh` | No | Default `true`: sends `maximum_compatibility: true`, so the firmware does a full refresh (with a flash) on every update. `false` lets it use partial refreshes for black-and-white screens, which don't flash but currently leave traces of earlier screens on the DIY kit |
| `temperatureProfile` | No | Sent to the device as `temperature_profile`: how the firmware drives the panel. For the 7.5" panel, `default` uses the `EP75_800x480` driver, `a` the panel's built-in fast mode (`EP75_800x480_GEN2`), `b` darker grays. Takes effect from the device's next wake; leaving it out means `default`. With `default`, the firmware doesn't rewrite the previous image before a partial refresh, which may leave traces of earlier screens |
| `token`    | No       | The device's existing token, for a device paired with another server. If set, it is used instead of a derived token (see [Authentication](#authentication)) |

At the top level:

- `defaultScreen` is the screen for devices with neither `screen` nor `playlist`: a screen's name (`defaultScreen: placeholder`), or `screen` and `inputs` like a playlist entry. Without it, the server uses `placeholder` if that screen exists, otherwise the first screen found (alphabetically).
- `playlists` names playlists, which devices can use (`playlist: kitchen`) and playlists can include.

A playlist is a list of entries, each either a screen with its inputs, or an include of a named playlist:

```yaml
playlists:
  travel:
    - screen: journeys
      inputs:
        routes:
          - Marienplatz -> München Ost
          - Marienplatz -> (Raubling) -> (Kufstein) -[allow:longdistance]-> Innsbruck Hbf

devices:
  - mac: "AA:BB:CC:DD:EE:FF"
    username: kitchen
    password: change-me
    playlist:
      - screen: mvg-departures
        inputs:
          station: Marienplatz
          hide:
            - BUS|REGIONAL_BUS
            - show BUS 54
      - playlist: travel
```

An include can also be just the playlist's name (`- travel`). A name where a playlist is expected that is only a screen's name gets a message saying to write `screen: …`. Includes are expanded when the file is read, so each device has one flat list. A device starts at its playlist's first entry; the screen page's Prev and Next buttons and KEY3 move it (see [Playlists](#playlists)). Inputs are checked against the screen's definitions: an unknown input or a value of the wrong type (e.g. `routes` written as one string instead of a list) stops the server with a message saying where. Write lists as block lists (`- …` per line): routes and hide rules then need no quotes.

The server checks the file at startup (required fields, unique usernames, valid time zones, existing playlists and `defaultScreen`, playlists that don't include each other, and inputs) and refuses to start if it's wrong; a playlist entry with an unknown screen is left out with a warning instead (see [Playlists](#playlists)), which `scripts/deploy` shows with its config check. That includes `when` (a syntax error, or `PH`/`SH` without a `location`), `location` and `duration` (see [Playlists](#playlists)).

Everything else comes from environment variables: `dist/.env` when deployed (copied to the server by `scripts/deploy`, see [Deployment](#deployment)), `.env` for `npm start` locally. Both are gitignored; `sample.env` and `dist/sample.env` document them.

| Variable        | Required | Meaning |
|-----------------|----------|---------|
| `TOKEN_SECRET`  | Yes      | At least 32 characters. Derives the devices' tokens and signs login sessions (see [Authentication](#authentication)) |
| `SERVER_PORT`   | No       | Locally: the port to listen on. Deployed: the host port Caddy forwards to (inside the container it's always 7777). Default `7777` |
| `SERVER_DOMAIN` | Deploy   | The public address, e.g. `https://trmnl.charding.dev`; registered with Caddy on deploy |
| `TZ`            | No       | Default time zone for devices without `timezone` |
| `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KEYPAIR`, `DEPLOY_DIR` | Deploy | Where `scripts/deploy` and `scripts/connect` connect to |
| `SETUP_ENABLED` | No       | `1` to answer `/api/setup` while pairing a device. Set only from the shell by `npm run pair`; a value in `.env` is ignored. Default `0` |

API keys for data sources will be added here as screens need them.

## Storage

| Data | Where |
|------|-------|
| Devices, playlists, screen settings | `devices.yaml`, deployed with the code, gitignored |
| `TOKEN_SECRET`, API keys for data sources | `dist/.env`, gitignored, copied to the server on deploy |
| Each device's playlist position, last check-in and telemetry | `state/<username>.json` next to `server.js` (e.g. `state/kitchen.json`), on the Docker volume `state` on the server |
| Rendered PNGs, cached data, recent log entries | Memory; rebuilt or cleared after a restart |

The state files (`src/state-file.ts`) have one file per device, so a write only touches that device. Each is named after the device's username, encoded as in a URL if needed, so renaming a device in `devices.yaml` starts it afresh (its first entry; its telemetry and check-in come back at its next check-in). It holds the device's MAC, to show which hardware it belongs to, and a section per module (`playlist` from `src/device-state.ts`, `telemetry`). A device's file is read once, on first need, and written after changes, at most once a second, to a temporary file renamed over the old one; when the server stops (`docker stop` sends SIGTERM), it ends open requests and writes pending changes. A file that exists but can't be read is left alone, and a failed write is tried again a minute later. A missing file means a fresh start, and a broken one is logged and replaced. Entries are saved with their screen and inputs (compared whatever order the inputs are written in), so after a deploy that changed the playlist, a device is found at the same entry wherever it moved, or starts at the first entry if it's gone (and which entry the device shows is then unknown until it checks in). Only the server saves state: in tests and the dev server it stays in memory. Local state files are kept out of the image (`.dockerignore`, as Docker would copy them into a new volume) and out of the upload (`.rsyncignore`).

No database is needed. If a screen ever depends on data pushed to the server (the equivalent of a TRMNL webhook), that data belongs on the same volume, because a deploy recreates the container.

## Deployment

Modelled on heatmapper, onto a server set up with the [virtual server gist](https://gist.github.com/c-harding/59686990f42f4dddae01dffa56618ea4) (Docker and Caddy with `add-site`):

- `scripts/build` first checks the types (`tsc`, see [Dependencies](#dependencies)), then bundles (with the commit's short hash as `BUILD_VERSION`, plus `*` for changes not committed except in Markdown files) `src/` with esbuild into `dist/server.js`, `dist/screens/*.js` (one per screen, see [Screens](#screens)) and shared chunk files, and copies `package.json`, `package-lock.json` and `devices.yaml` into `dist/`. Only the deployment files in `dist/` are tracked: `Dockerfile` (`node:24-slim`, `npm ci --omit=dev`), `docker-compose.yml`, `.dockerignore`, `.rsyncignore` and `sample.env`.
- `scripts/deploy` rsyncs `dist/` to `DEPLOY_DIR` on the server (without `*.env`), copies `dist/.env` separately as `.env`, runs `docker compose up --build -d` and `docker system prune -f`, and registers `SERVER_DOMAIN` with Caddy on `SERVER_PORT` (`add-site`).
- `scripts/connect` runs a command on the server, e.g. `npm run connect -- 'docker compose -f trmnl/docker-compose.yml logs -f'`.
- The image (`trmnl-server`) is built with BuildKit's inline cache: the cache information for each step is stored in the image itself, and the next build reads it from there (`cache_from`). `docker system prune` empties the separate build cache on every deploy (ours and the other projects' on the same server), but as long as the running image exists, unchanged steps such as `npm ci` are still reused.
- The base image is never pulled again automatically (`up --build` keeps the local `node:24-slim`), so it doesn't receive Node or Debian updates. Pull it by hand when needed: `docker compose build --pull` in `DEPLOY_DIR` on the server.
- The image build runs `node server.js --check-config`, which loads the config (`devices.yaml`, the screens, and `.env`'s `TOKEN_SECRET` and `TZ`) with the same checks as at startup and exits. A broken config fails the build, so `docker compose up --build` stops before replacing the running container, and `scripts/deploy` fails with the message. `.env` isn't part of the image: the build mounts it for that step only, as a BuildKit build secret, so its values aren't stored in the image. Docker doesn't notice a changed secret, so `scripts/deploy` passes a hash of `.env` as the build argument `ENV_HASH`, which reruns the check when `.env` changes.
- The container listens on 7777; `SERVER_PORT` only picks the host port, which is published on `127.0.0.1` only, so the server can only be reached through Caddy's HTTPS.
- `scripts/pair` restarts the container with `SETUP_ENABLED=1`, waits until Enter is pressed, then restarts it with setup off (also on Ctrl+C or an error). `scripts/deploy` always starts it with `SETUP_ENABLED=0`.

Footprint: a `node:slim` image with sharp's prebuilt binaries. Measured on a Mac (M2 Max), the process uses about 175 MB of RAM after rendering (a plain Node process: 45 MB), with sharp's cache off and one thread (about 240 MB with sharp's defaults); `docker stats` on the server gives the Linux figure. A screen takes about 26 ms to render there (Satori 2 ms, sharp 24 ms), so caching rendered PNGs isn't worth it; real screens should cache their data instead. The current server has about 800 MB of RAM available and 24 GB of disk.

## Dependencies

- `satori` for layout and SVG, `sharp` for PNG conversion
- Inter 4.1, as the static `Inter-Regular.ttf` and `Inter-Bold.ttf` from [Inter's release](https://github.com/rsms/inter/releases), committed in `assets/fonts` with its licence (SIL Open Font License) and copied into `dist/fonts` by `scripts/build`. Satori 0.47.1 fails on the variable `InterVariable.ttf`, and the Google Fonts subsets (e.g. `@fontsource/inter`) lack symbols such as ≈ and →
- `preact`, only for its JSX runtime (`jsxImportSource: "preact"`); JSX is bundled with esbuild. Our components (`Frame`, `Table`, …) are plain functions of their props, with no hooks or state, so nothing else from Preact is used. Tested: Satori 0.47.1 accepts Preact 11.0.1's elements, including function components
- `yaml` for `devices.yaml`
- TypeScript, for type checking only (`npm run check`, and the first step of `scripts/build`): esbuild strips the types when building and doesn't check them. `tsconfig.json` is strict; imports name the `.ts`/`.tsx` files themselves. Express, cookie-parser and Node have their types from `@types/*`; Satori's types refer to React's, which aren't installed, so `skipLibCheck` is on and Satori accepts any element
- Tests: `npm test` (`scripts/test`) bundles `test/*.test.ts` with esbuild into `.test/` (gitignored) and runs them with Node's built-in test runner (`node:test`, no dependency). They cover logic that has edge cases, such as the source cache and the journeys' route rules; `npm run check` type-checks them along with `src/`.
- Express 5 with `cookie-parser` (chosen over `node:http` and Fastify for its familiar routing, built-in body parsing and automatic handling of rejected async handlers)

## Alternatives considered

- **TRMNL plugins (Liquid templates, the TRMNL CSS framework and a headless browser)**: would allow reusing existing plugins and trmnlp, but the browser needs several hundred MB of RAM per render, and running other people's plugins means running their JavaScript and transform scripts on the server.
- **Random tokens stored in a database**: no advantage over derived tokens for a fixed set of devices, and losing the database would lock every device out.

## Open questions

- Which `temperature_profile` (`default`, `a`, `b`) works best on our panel? With `default`, partial refreshes leave earlier clock digits visible; trying `a`.
- `npm audit` reports 2 moderate issues: Satori 0.47.1 pins `fflate` to exactly 0.7.3 (directly and through `@shuding/opentype.js`), which has an infinite loop in `unzipSync` on malformed ZIP64 archives ([GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98)). Probably not reachable here: Satori only uses `fflate` to decompress font files, and we only load our own fonts. `npm audit fix --force` would downgrade Satori to 0.32.0, a breaking change. Better: an `overrides` entry forcing `fflate` 0.8.x, checking that rendering still works, or waiting for a Satori release that updates it.
- Once there are playlists: preview every entry of a device's playlist in the browser, not just the one the device is showing.
- Once there are playlists: let the dev server load a playlist entry's screen and inputs from `devices.yaml` into its form, to try changes to it.
- Measure battery use instead of estimating it (see [Playlists](#playlists)): log the `Battery-Voltage` from every `/api/display` for a few days and compare wake patterns.
- Partial refreshes leave traces of earlier screens on the DIY kit (e.g. superimposed clock digits), with `temperatureProfile` `default` and `a` alike; until then every device gets full refreshes (`fullRefresh`, default `true`), which flash every minute. Likely cause: the firmware assumes the panel controller still holds the previous image after deep sleep (`bCanDoPartial` survives in RTC memory), which may not be true on this board. To investigate: build the firmware with `-D DEV_FIRMWARE` for `TRMNL_7inch5_OG_DIY_Kit` (only development builds log over USB), flash it over USB, and read the serial log at 115200 baud for lines like "Have valid previous image in EPD memory, doing partial refresh". While full refreshes are used, black and white no longer avoids flashing, so `colors = 2` on the screens could be revisited.
- Load data ahead for devices that wake rarely: `refreshAhead` only helps when requests come often (journeys screens every minute), and warming (see [Sources](#sources)) happens at check-ins and moves. For a screen whose device wakes, say, every 15 minutes, a scheduler could warm what it depends on shortly before its next wake (its last `/api/display` plus the `refresh_rate` sent), which would also shorten the wake and save battery.
