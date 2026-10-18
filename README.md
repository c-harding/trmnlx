# TRMNLx

A server for [TRMNL](https://trmnl.com) e-ink displays, in place of TRMNL's own service: for a small, fixed set of devices, each showing screens written for this server, on a schedule. It runs on a small server in Docker, renders the screens itself (no headless browser, no database) and talks to the devices with TRMNL's firmware as it is.

- How it's built: [ARCHITECTURE.md](ARCHITECTURE.md)
- What a TRMNL device expects from a server: [TRMNL.md](TRMNL.md)

## What it does

**Screens**, each with its own settings (see [Screens](#screens)):

| Screen           | Shows                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `mvg-departures` | Departures from a station in Munich, from MVG, with notes, delays and cancellations, and pinned connections to chosen stations     |
| `departures`     | Departures from a stop anywhere Transitous has data                                                                                |
| `journeys`       | The next connections on one to four routes, with via stops and rules for which transport counts (e.g. a Deutschlandticket)         |
| `map`            | A street map, like a printed one, from OpenStreetMap data                                                                          |
| `contours`       | A contour map of the land, with its interval chosen by how steep it is                                                             |
| `weather`        | The weather for the next 24 hours where the device is: temperature, rain and snow, daylight, sunrise and sunset                    |
| `strava`         | One of your latest Strava activities: its route on a map, its stats, its elevation profile with named summits, and a QR code to it |
| `placeholder`    | The default, for a device with nothing else to show                                                                                |

**Playlists**: a device shows its screens in turn, each for a `duration` and only `when` it applies (e.g. departures on weekday mornings, in OpenStreetMap's [opening-hours syntax](https://wiki.openstreetmap.org/wiki/Key:opening_hours/specification), with holidays and sunrise). The device's button moves on or back. A device can have several playlists to switch between.

**A page in the browser** for each device, behind a login: what it shows now, as it looks on the display, with buttons to move its playlist on or back and to switch playlists, its live logs (what it reports after a failure, and each check-in), and connecting its Strava account.

**A development server** that renders any screen with any settings, and a device's or a playlist's screens all at once, from `devices.yaml`.

## Running

Locally:

```sh
npm install
cp sample.env .env                    # then set TOKEN_SECRET (openssl rand -base64 32)
cp devices.yaml.sample devices.yaml   # then add your devices
npm run build && npm start            # http://localhost:7777
```

Developing screens:

```sh
npm run dev                           # http://localhost:7778: render any screen with device data from a form
```

No `devices.yaml` or `.env` needed. Saving a file rebuilds and restarts it; reload the page (or click Load) to see the change. It doesn't check types: `npm run check` does (and so does `npm run build`).

Tests: `npm test` runs `test/*.test.ts` with Node's test runner (bundled by esbuild first, like the server).

Deploying:

```sh
cp dist/sample.env dist/.env          # once: fill in the deploy settings and TOKEN_SECRET
npm run build-deploy
npm run connect -- 'docker compose -f trmnl/docker-compose.yml logs -f'   # follow the server's logs
```

Pairing a new device (after adding it to `devices.yaml` and deploying):

```sh
npm run pair    # turns /api/setup on until you press Enter, then off again
```

## Configuration

The server works with a fixed set of devices, configured in `devices.yaml`. The file is deployed with the code, so changes take effect on the next deploy. It contains passwords, so it is gitignored: copy [devices.yaml.sample](devices.yaml.sample) to `devices.yaml` and edit it.

```yaml
devices:
  - mac: "AA:BB:CC:DD:EE:FF"
    username: kitchen
    password: change-me
    timezone: Europe/Berlin
```

| Field                | Required | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mac`                | Yes      | The device's MAC address, as sent in the `ID` header. Always quote it: some YAML parsers read an unquoted all-digit MAC such as `12:34:56:12:34:56` as a number                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `username`           | Yes      | User name for the browser login; it selects which device's screen is shown                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `password`           | Yes      | Password for the browser login                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `timezone`           | No       | IANA time zone for the device's screens, e.g. `Europe/Berlin`. Defaults to `TZ`, then UTC                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `screen`             | No       | Which screen the device shows, e.g. `mvg-departures`, with its default inputs: a playlist of one entry. Without it or `playlist`, `defaultScreen` (see below)                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `playlist`           | No       | What the device shows, with inputs: a list of entries, or the name of a named playlist (see below). Not together with `screen`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `playlists`          | No       | Other playlists the screen page can switch the device to (see [Playlists](ARCHITECTURE.md#playlists)): a mapping of names to playlists, each like `playlist` (a list of entries, or a named playlist's name) or an include's fields alone (`maps: { duration: 10m, shuffle: true }`: the named playlist of the same name, or the one `playlist:` gives) or nothing (`maps:`, that named playlist as it is), or a list of named playlists' names (`[travel, maps]`), each offered under its own name. Offered in this order, after `default`, the name of `playlist` or `screen`, which therefore can't name one of these |
| `refreshRate`        | No       | The longest the device sleeps between polls, in seconds, at least 60. Default 900, the firmware's own default. It wakes sooner when the screen's `ttl` runs out first                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `fullRefresh`        | No       | Default `true`: sends `maximum_compatibility: true`, so the firmware does a full refresh (with a flash) on every update. `false` lets it use partial refreshes for black-and-white screens, which don't flash but currently leave traces of earlier screens on the DIY kit                                                                                                                                                                                                                                                                                                                                               |
| `temperatureProfile` | No       | Sent to the device as `temperature_profile`: how the firmware drives the panel. For the 7.5" panel, `default` uses the `EP75_800x480` driver, `a` the panel's built-in fast mode (`EP75_800x480_GEN2`), `b` darker grays. Takes effect from the device's next wake; leaving it out means `default`. With `default`, the firmware doesn't rewrite the previous image before a partial refresh, which may leave traces of earlier screens                                                                                                                                                                                  |
| `location`           | No       | Where the device is, overriding the top-level `location` (see below), e.g. for holidays in another state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `token`              | No       | The device's existing token, for a device paired with another server. If set, it is used instead of a derived token (see [Authentication](ARCHITECTURE.md#authentication))                                                                                                                                                                                                                                                                                                                                                                                                                                               |

At the top level:

- `defaultScreen` is the screen for devices with neither `screen` nor `playlist`: a screen's name (`defaultScreen: placeholder`), or `screen` and `inputs` like a playlist entry. Without it, the server uses `placeholder` if that screen exists, otherwise the first screen found (alphabetically).
- `location` is where the devices are: `country` and `state` for public and school holidays in `when` (see [Playlists](ARCHITECTURE.md#playlists)), and `lat` and `lon` for sunrise and sunset in `when` and the `weather` screen. A device's own `location` overrides it.
- `playlists` names playlists, which devices can use (`playlist: kitchen`) and playlists can include.
- `tokens` holds other services' credentials: `strava` with the Strava app's `client_id` and `client_secret`, for the `strava` screen. Never sent to a browser.

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

An include can also be just the playlist's name (`- travel`). A name where a playlist is expected that is only a screen's name gets a message saying to write `screen: …`. Includes are expanded when the file is read, so each device has one flat list. A device starts at its playlist's first entry; the screen page's Prev and Next buttons and KEY3 move it (see [Playlists](ARCHITECTURE.md#playlists)). Inputs are checked against the screen's definitions: an unknown input or a value of the wrong type (e.g. `routes` written as one string instead of a list) stops the server with a message saying where. Write lists as block lists (`- …` per line): routes and hide rules then need no quotes.

The server checks the file at startup (required fields, unique usernames and MACs, valid time zones, existing playlists and `defaultScreen`, playlists that don't include each other, inputs, `location`, `duration`, and `when`: a syntax error, `PH`/`SH` without a `location`, or sunrise and the like without its `lat` and `lon`) and refuses to start if it's wrong. A playlist entry with an unknown screen is left out with a warning instead (see [Playlists](ARCHITECTURE.md#playlists)), which `scripts/deploy` shows with its config check.

Everything else comes from environment variables: `dist/.env` when deployed (copied to the server by `scripts/deploy`, see [Deployment](ARCHITECTURE.md#deployment)), `.env` for `npm start` locally. Both are gitignored; `sample.env` and `dist/sample.env` document them.

| Variable                                      | Required | Meaning                                                                                                                                                                                                          |
| --------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TOKEN_SECRET`                                | Yes      | At least 32 characters. Derives the devices' tokens and signs login sessions (see [Authentication](ARCHITECTURE.md#authentication))                                                                              |
| `SERVER_PORT`                                 | No       | Locally: the port to listen on. Deployed: the host port Caddy forwards to (inside the container it's always 7777). Default `7777`                                                                                |
| `SERVER_DOMAIN`                               | Deploy   | The public address, e.g. `https://trmnl.charding.dev`; registered with Caddy on deploy                                                                                                                           |
| `TZ`                                          | No       | Default time zone for devices without `timezone`                                                                                                                                                                 |
| `DEPLOY_HOST`                                 | Deploy   | The server `scripts/deploy` and `scripts/connect` connect to                                                                                                                                                     |
| `DEPLOY_USER`, `DEPLOY_KEYPAIR`, `DEPLOY_DIR` | No       | Who to connect as, with which key, and the directory there (`.` by default; `dist/sample.env` sets `trmnl`, which the logs command under [Running](#running) assumes)                                            |
| `SETUP_ENABLED`                               | No       | `1` to answer `/api/setup` while pairing a device. Default `0`. Deployed, only `npm run pair` sets it (Docker's settings override a value in `.env`); locally, `SETUP_ENABLED=1 npm start`, or a value in `.env` |

## Screens

Each screen's inputs, set per playlist entry under `inputs` (see [Configuration](#configuration)); missing ones take their defaults. How the screens work: [Screens](ARCHITECTURE.md#screens).

### `mvg-departures`

Departures from a station in Munich, from MVG, as many as fit, in order of their actual departure, each with the next two on its line.

| Input     | Type   | Default       | Meaning                                                                                                             |
| --------- | ------ | ------------- | ------------------------------------------------------------------------------------------------------------------- |
| `station` | string | `München Hbf` | The station, as MVG spells it                                                                                       |
| `pinned`  | list   | none          | Connections always shown: in their place if they fit, otherwise at the bottom under a thicker line (see pins below) |
| `hide`    | list   | none          | Departures left out (see hide rules below); they don't take up rows, and apply to pinned connections too            |

MVG's transport types: `UBAHN`, `SBAHN`, `TRAM`, `BUS`, `REGIONAL_BUS`, `BAHN`.

**Pins**, one per line, as `<types> -> <station>`: the next direct connection of those types to that station, including trains ending there (which never appear in its own departures).

- `UBAHN -> Hauptbahnhof`: the next U-Bahn there
- `SBAHN|UBAHN -> Ostbahnhof`: either
- `-> Ostbahnhof`: any type

A pin without the arrow is ignored, with an error in the log.

**Hide rules**, one per line, as `<types> [line] [-> <destination>]`; the last rule matching a departure decides, and without one it's shown. Lines and destinations are compared ignoring case.

- `BUS|REGIONAL_BUS`: all buses
- `BUS 54`: one bus line
- `TRAM -> Amalienburgstraße`: trams going there
- `-> Messestadt Ost`: anything going there
- `show BUS 54`: an exception, showing matching departures again after a rule that hid them (also `!BUS 54`, but only quoted in YAML: `- '!BUS 54'`, as an unquoted `!` starts a YAML tag)

The types come first: `show 54` would mean a transport type "54", which matches nothing.

### `departures`

Departures from a stop anywhere Transitous has data, with the same rows as `mvg-departures`.

| Input     | Type   | Default              | Meaning                                                                                                   |
| --------- | ------ | -------------------- | --------------------------------------------------------------------------------------------------------- |
| `station` | string | `Innsbruck Hbf`      | The stop, as Transitous names it (it searches, so "Innsbruck Hbf" finds Innsbruck Hauptbahnhof)           |
| `hide`    | list   | `BUS\|COACH`, `TRAM` | Departures left out, as for `mvg-departures`; by default only trains, and buses replacing them, are shown |

Transitous' modes: `BUS`, `COACH`, `TRAM`, `METRO` (the S-Bahn), `SUBWAY`, `REGIONAL_RAIL`, `HIGHSPEED_RAIL`, …, and `RAIL_REPLACEMENT` for buses replacing trains.

### `journeys`

The next connections on one to four routes, from Transitous: one route fills the screen, two are side by side, three are two on the left and one on the right, four are two by two.

| Input    | Type   | Default                     | Meaning                                                                                                                             |
| -------- | ------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `routes` | list   | `München Hbf -> Berlin Ost` | One route per line, up to four (see routes below)                                                                                   |
| `rules`  | string | `deny:longdistance`         | Which transport counts on every route (see rules below): by default no long-distance trains or coaches, as with a Deutschlandticket |
| `count`  | int    | `8`                         | At most this many connections per route, as many as fit                                                                             |

**Routes**: stops separated by `->`, from, any via stops in order, to, as Transitous names them: `Marienplatz -> München Hbf`. A stop in brackets is searched but left out of titles: `Marienplatz -> (Raubling) -> Innsbruck Hbf` shows "Marienplatz → Innsbruck Hbf".

**Rules**: `allow:<mode>` and `deny:<mode>`, separated by commas or spaces, with a Transitous mode (`bus`, `tram`, `subway` for the U-Bahn, `metro` for the S-Bahn, `regional_rail`, `highspeed_rail`, …) or a group (`longdistance`: high-speed, long-distance and night trains and coaches; `regional`; `local`). The `rules` input applies everywhere; a stretch written `-[rules]>` instead of `->` adds its own, and the last rule mentioning a mode decides (without one, it's allowed). E.g. `Marienplatz -> (Raubling) -> (Kufstein) -[allow:longdistance]> Innsbruck Hbf` allows Railjets from Kufstein, but not from Munich. A via stop can matter: see [`journeys`](ARCHITECTURE.md#screens) for why `(Raubling)` is there.

### `map`

A street map like a printed one: roads black, railways and airports dark gray, water light gray.

| Input        | Type   | Default              | Meaning                                                                                                 |
| ------------ | ------ | -------------------- | ------------------------------------------------------------------------------------------------------- |
| `title`      | string | `München`            | Shown above the map                                                                                     |
| `lat`, `lon` | number | `48.1374`, `11.5755` | The map's centre                                                                                        |
| `zoom`       | number | `12.1`               | As on web maps, fractions allowed: 14 shows about 5 km across in Munich, each step one more halves that |

### `contours`

A contour map: the land's shape in contour lines, and the water over them.

| Input        | Type   | Default             | Meaning                                                                 |
| ------------ | ------ | ------------------- | ----------------------------------------------------------------------- |
| `title`      | string | `Chamonix`          | Shown above the map                                                     |
| `lat`, `lon` | number | `45.9237`, `6.8694` | The map's centre                                                        |
| `zoom`       | number | `12.5`              | As for `map`                                                            |
| `contours`   | number | `0`                 | Metres between contour lines, at least 5; `0`: by how steep the land is |

### `weather`

The weather where the device is (its `location`'s `lat` and `lon`): now, the next 24 hours as a chart, and the next days.

| Input   | Type   | Default | Meaning                                                          |
| ------- | ------ | ------- | ---------------------------------------------------------------- |
| `title` | string | empty   | Shown above the weather, e.g. the place's name; empty: "Weather" |

### `strava`

One of the latest Strava activities that aren't private, of the account connected on the screen page (see [Configuration](#configuration) for the app's credentials).

| Input    | Type | Default | Meaning                                                       |
| -------- | ---- | ------- | ------------------------------------------------------------- |
| `offset` | int  | `0`     | Which activity: `0` the latest, `1` the one before, and so on |

### `placeholder`

The device's name, battery, and the time and date. No inputs.
