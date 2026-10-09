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
                                   └─ otherwise: screen.load() ─► screen.view(data)
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
| `GET /` | The logged-in user's device screen: a plain HTML page whose small script fetches `/screen.png` and fetches it again when its `X-TTL` runs out |
| `GET /screen.png` | The PNG shown on that page, rendered on each request, with the screen's `ttl` in an `X-TTL` header |
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

Each screen is a module with two functions:

```js
export async function load(config) { /* fetch data, return plain object */ }
export function view(data) { /* return JSX layout */ }
```

- `ttl(props)` returns how many seconds the screen stays valid, including a small safety margin; the placeholder's lasts until the next minute plus 2 seconds. The device gets `refresh_rate = min(refreshRate, max(ttl − wake time, 5))`, and the browser preview refetches the image when it runs out. The wake time comes from the firmware's `Wake-Time` header (how long its last cycle was awake, in ms): the firmware starts its sleep timer only after downloading and drawing the image, so without the correction each wake lands that much after the screen changed.
- Screens also get the device's latest telemetry (`telemetry`: battery voltage, `RSSI`, firmware version, charging/USB if reported, time seen), taken from the headers of its last `/api/display` and kept in memory per device (`src/telemetry.js`). `/api/display` records it before rendering, so the device's screen shows the readings from that same wake; the browser preview shows the latest ones, or none after a restart until the device polls. The DIY kit reports only a voltage; `batteryPercent` estimates a percentage from a typical lithium discharge curve (4.2 V full, 3.3 V empty), so it's only approximate.
- `load` does any fetching, filtering and calculation; this replaces TRMNL's polling and transform scripts.
- `view` returns a layout in JSX: flexbox only, inline styles, the four panel grays (`#000`, `#555`, `#aaa`, `#fff`). Shared pieces (tables, headers, charts as inline SVG) live in a `components/` module.
- Satori sizes boxes like CSS's default `content-box`, so a full-size container with `width: "100%"` and padding ends up wider than the screen. Give such containers `boxSizing: "border-box"`.
- Long text is cut off with `whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"` on one line, or `display: "block", overflow: "hidden", lineClamp: 2` for two lines (both tested). Text that isn't cut off can overflow its box.
- Screen-specific settings (coordinates, calendar URL, …) come from `devices.yaml`; secrets such as API keys come from environment variables.

### Rendering

1. `Frame` wraps the screen's layout and adds overlays that apply to every screen, such as a low-battery warning based on the `Battery-Voltage` header.
2. Satori turns the layout into an 800 × 480 SVG, with text drawn as paths, so no fonts need to be installed. Font files (TTF/OTF/WOFF) are loaded once at startup.
3. sharp converts the SVG to a PNG with a 4-colour palette, stored at 2 bits per pixel: `.grayscale().png({ palette: true, colours: 4, compressionLevel: 9 })`. It must stay under 90,000 bytes; a typical screen is around 4 KB. The firmware picks the display mode from the bit depth and converts palette colours to gray, so this is shown in 4-gray mode.
   - Grayscale screens always get a full refresh, which flashes. A screen that only uses black and white (2-bit with two colours, or 1-bit) gets a fast partial refresh instead, so screens that change often should avoid grays.
4. `filename` is a hash of the PNG, so the device skips the download and the e-ink refresh when nothing changed.

Rendering happens during `/api/display` itself, which is fast enough that no scheduler or job queue is needed. Each screen declares how long its data stays fresh; the rendered PNG is cached in memory until then.

### Playlists

Each device in `devices.yaml` lists the screens it rotates through, with an optional refresh rate per screen. The current position is kept in memory and restarts from the beginning after a restart.

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
| `refreshRate` | No     | The longest the device sleeps between polls, in seconds, at least 60. Default 900, the firmware's own default. It wakes sooner when the screen's `ttl` runs out first |
| `token`    | No       | The device's existing token, for a device paired with another server. If set, it is used instead of a derived token (see [Authentication](#authentication)) |

The server checks the file at startup (required fields, unique usernames, valid time zones) and refuses to start if it's wrong. Still to be designed: the device's playlist (see [Playlists](#playlists)) and the settings for each screen.

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
| Rendered PNGs, cached data, playlist positions, device telemetry, recent log entries | Memory; rebuilt or cleared after a restart |

No database or Docker volume is needed. If a screen ever depends on data pushed to the server (the equivalent of a TRMNL webhook), that data needs a file on a volume, because a deploy recreates the container.

## Deployment

Modelled on heatmapper, onto a server set up with the [virtual server gist](https://gist.github.com/c-harding/59686990f42f4dddae01dffa56618ea4) (Docker and Caddy with `add-site`):

- `scripts/build` bundles `src/` with esbuild into `dist/server.js` and copies `package.json`, `package-lock.json` and `devices.yaml` into `dist/`. Only the deployment files in `dist/` are tracked: `Dockerfile` (`node:24-slim`, `npm ci --omit=dev`), `docker-compose.yml`, `.dockerignore`, `.rsyncignore` and `sample.env`.
- `scripts/deploy` rsyncs `dist/` to `DEPLOY_DIR` on the server (without `*.env`), copies `dist/.env` separately as `.env`, runs `docker compose up --build -d` and `docker system prune -f`, and registers `SERVER_DOMAIN` with Caddy on `SERVER_PORT` (`add-site`).
- `scripts/connect` runs a command on the server, e.g. `npm run connect -- 'docker compose -f trmnl/docker-compose.yml logs -f'`.
- The image (`trmnl-server`) is built with BuildKit's inline cache: the cache information for each step is stored in the image itself, and the next build reads it from there (`cache_from`). `docker system prune` empties the separate build cache on every deploy (ours and the other projects' on the same server), but as long as the running image exists, unchanged steps such as `npm ci` are still reused.
- The base image is never pulled again automatically (`up --build` keeps the local `node:24-slim`), so it doesn't receive Node or Debian updates. Pull it by hand when needed: `docker compose build --pull` in `DEPLOY_DIR` on the server.
- The container listens on 7777; `SERVER_PORT` only picks the host port, which is published on `127.0.0.1` only, so the server can only be reached through Caddy's HTTPS.
- `scripts/pair` restarts the container with `SETUP_ENABLED=1`, waits until Enter is pressed, then restarts it with setup off (also on Ctrl+C or an error). `scripts/deploy` always starts it with `SETUP_ENABLED=0`.

Footprint: a `node:slim` image with sharp's prebuilt binaries. Measured on a Mac (M2 Max), the process uses about 175 MB of RAM after rendering (a plain Node process: 45 MB), with sharp's cache off and one thread (about 240 MB with sharp's defaults); `docker stats` on the server gives the Linux figure. A screen takes about 26 ms to render there (Satori 2 ms, sharp 24 ms), so caching rendered PNGs isn't worth it; real screens should cache their data instead. The current server has about 800 MB of RAM available and 24 GB of disk.

## Dependencies

- `satori` for layout and SVG, `sharp` for PNG conversion
- Inter 4.1, as the static `Inter-Regular.ttf` and `Inter-Bold.ttf` from [Inter's release](https://github.com/rsms/inter/releases), committed in `assets/fonts` with its licence (SIL Open Font License) and copied into `dist/fonts` by `scripts/build`. Satori 0.47.1 fails on the variable `InterVariable.ttf`, and the Google Fonts subsets (e.g. `@fontsource/inter`) lack symbols such as ≈ and →
- `preact`, only for its JSX runtime (`jsxImportSource: "preact"`); JSX is bundled with esbuild. Our components (`Frame`, `Table`, …) are plain functions of their props, with no hooks or state, so nothing else from Preact is used. Tested: Satori 0.47.1 accepts Preact 11.0.1's elements, including function components
- `yaml` for `devices.yaml`
- Express 5 with `cookie-parser` (chosen over `node:http` and Fastify for its familiar routing, built-in body parsing and automatic handling of rejected async handlers)

## Alternatives considered

- **TRMNL plugins (Liquid templates, the TRMNL CSS framework and a headless browser)**: would allow reusing existing plugins and trmnlp, but the browser needs several hundred MB of RAM per render, and running other people's plugins means running their JavaScript and transform scripts on the server.
- **Random tokens stored in a database**: no advantage over derived tokens for a fixed set of devices, and losing the database would lock every device out.

## Open questions

- Which `temperature_profile` (`default`, `a`, `b`) gives the best grayscale on our panel?
- `npm audit` reports 2 moderate issues: Satori 0.47.1 pins `fflate` to exactly 0.7.3 (directly and through `@shuding/opentype.js`), which has an infinite loop in `unzipSync` on malformed ZIP64 archives ([GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98)). Probably not reachable here: Satori only uses `fflate` to decompress font files, and we only load our own fonts. `npm audit fix --force` would downgrade Satori to 0.32.0, a breaking change. Better: an `overrides` entry forcing `fflate` 0.8.x, checking that rendering still works, or waiting for a Satori release that updates it.
- Once there are playlists: give KEY3 presses a meaning. A short press arrives as a normal `/api/display` with `Update-Source: EXT0` on the DIY kit (`EXT1` on an ESP32, `button` on the C3-based OG); a 1–5 s press arrives with a `special_function: true` header and runs whichever special function the server last sent in `special_function` (e.g. `restart_playlist`, `identify`). Other keys on the board would need a firmware change (the S3 build wakes on one pin via `ext0`).
- Consider the browser page's behaviour when redeploying: while the container is replaced, image fetches fail (Caddy answers 502) and the script retries after 30 s; the page itself is never reloaded, so after a deploy that changes the page or its script, an open tab keeps running the old version until reloaded by hand (e.g. the server could send a version with each image and the page reload when it changes).
