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

You need Node 24 (as in the Docker image).

Locally:

```sh
npm install
cp sample.env .env                    # then set TOKEN_SECRET (openssl rand -base64 32)
cp devices.yaml.sample devices.yaml   # then add your devices
npm run build && npm start            # http://localhost:7777
```

The build copies `devices.yaml` into `dist/`, where the server reads it, so after editing it, run `npm run build` again (and restart).

Developing screens:

```sh
npm run dev                           # http://localhost:7778: render any screen with device data from a form
```

No `devices.yaml` or `.env` needed. Saving a file rebuilds and restarts it; reload the page (or click Load) to see the change. It doesn't check types: `npm run check` does (and so does `npm run build`).

Tests: `npm test` runs `test/*.test.ts` with Node's test runner (bundled by esbuild first, like the server). Formatting: `npm run format` rewrites the files with Prettier, `npm run format:check` only reports them.

Deploying needs a server set up as in the [virtual server gist](https://gist.github.com/c-harding/59686990f42f4dddae01dffa56618ea4) (Docker, and Caddy with `add-site`), ssh access to it, and DNS for `SERVER_DOMAIN` pointing at it (see [Deployment](ARCHITECTURE.md#deployment)):

```sh
cp dist/sample.env dist/.env          # once: fill in the deploy settings and TOKEN_SECRET
npm run build-deploy
npm run connect -- 'docker compose -f trmnl/docker-compose.yml logs -f'   # follow the server's logs
```

Setting up a device:

1. Add it to `devices.yaml` (at least its `mac`, `username` and `password`) and deploy.
2. Put the device into its setup mode: a new one starts there; otherwise a long press of the reset button clears its settings, Wi-Fi included. It opens a Wi-Fi access point with a setup page.
3. On that page, enter your Wi-Fi, and under the advanced settings this server's `SERVER_DOMAIN` as the custom server URL, exactly as written there (see [TRMNL.md](TRMNL.md#pointing-the-device-at-this-server) for why it must match).
4. Run `npm run pair`: it lets the server hand out the device's token until you press Enter, then turns that off again. Wake the device with a short press of its button; it fetches its token, shows "Paired", and then its screens. The server's log, and the device's page under Logs, say "Paired".

A device that was set up with TRMNL's own service still has that token: reset it as above, or put its old token in its `token` field instead of pairing.

## Using the screen page

Each device has a page at the server's address (http://localhost:7777 locally), behind a login with the device's `username` and `password` from `devices.yaml`.

- **The preview**: what the device shows now, rendered as it looks on the display, and rendered again when the screen changes. Its caption says whether the device has it: "Live preview" if it got that entry at its last check-in, otherwise when it will (its next check-in, or "when device comes online"). A click on the preview toggles its actual size.
- **Prev and Next** move the device's playlist back or on, through the entries that apply now, as its button does. Above them, which entry shows and where it is: "journeys (2/3)" is the second of three entries that apply now; a tooltip on the count names those that apply at other times. The device shows the change at its next check-in.
- **Playlist**: a dropdown, when the device has other playlists (its `playlists`, see [Configuration](#configuration)), switches to another one straight away, starting at its first entry that applies.
- **Links under the preview**: the attributions the current screen asks for (e.g. a map's data), and any other links it provides, e.g. to connect an account a screen needs.
- **Logs** (in the footer): the device's logs, live, at `/logs`: what the device reports after a failure, and each check-in, rejected request and render error. Nothing is kept: the page shows what happens while it's open. A coloured dot shows the connection (green live, amber reconnecting, red disconnected), and a row in the list marks any gap.

## Configuration

The server works with a fixed set of devices, configured in `devices.yaml`. The file is deployed with the code, so changes take effect on the next deploy. It contains passwords, so it is gitignored: copy [devices.yaml.sample](devices.yaml.sample) to `devices.yaml` and edit it.

```yaml
devices:
  - mac: "AA:BB:CC:DD:EE:FF"
    username: kitchen
    password: change-me
    timezone: Europe/Berlin
```

| Field                | Required | Meaning                                                                                                                                                                                                                                                   |
| -------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mac`                | Yes      | The device's MAC address, as sent in the `ID` header. Always quote it: some YAML parsers read an unquoted all-digit MAC such as `12:34:56:12:34:56` as a number                                                                                           |
| `username`           | Yes      | User name for the browser login; it selects which device's screen is shown                                                                                                                                                                                |
| `password`           | Yes      | Password for the browser login                                                                                                                                                                                                                            |
| `timezone`           | No       | IANA time zone for the device's screens, e.g. `Europe/Berlin`. Defaults to `TZ`, then UTC                                                                                                                                                                 |
| `screen`             | No       | Which screen the device shows, e.g. `mvg-departures`, with its default inputs: a playlist of one entry. Without it or `playlist`, `defaultScreen` (see below)                                                                                             |
| `playlist`           | No       | What the device shows, with inputs: a list of entries, or the name of a named playlist (see below). Not together with `screen`                                                                                                                            |
| `playlists`          | No       | Other playlists the screen page can switch the device to (see the forms below)                                                                                                                                                                            |
| `refreshRate`        | No       | The longest the device sleeps between polls, in seconds, at least 60. Default 900, the firmware's own default. It wakes sooner when the screen's `ttl` runs out first                                                                                     |
| `fullRefresh`        | No       | Default `true`: a full refresh (with a flash) on every update. `false` allows fast partial refreshes for black-and-white screens, which currently leave traces of earlier screens on the DIY kit (see [Open questions](ARCHITECTURE.md#open-questions))   |
| `temperatureProfile` | No       | How the firmware drives the panel: `default`, `a` (the panel's built-in fast and 4-gray modes) or `b` (darker grays), from the device's next wake (see [TRMNL.md](TRMNL.md#get-apidisplay-the-poll) and [Open questions](ARCHITECTURE.md#open-questions)) |
| `location`           | No       | Where the device is, overriding the top-level `location` (see below), e.g. for holidays in another state                                                                                                                                                  |
| `token`              | No       | The device's existing token, for a device paired with another server. If set, it is used instead of a derived token (see [Authentication](ARCHITECTURE.md#authentication))                                                                                |

A device's `playlists` can be written in several ways. They're offered in the order written, after `default` (the device's own `playlist` or `screen`), so `default` can't be used as a name:

```yaml
playlists:
  evening: # a list of entries, like `playlist`
    - screen: weather
  travel: travel # a named playlist, by name
  maps: # nothing: the named playlist of the same name, as it is
  shuffled: { playlist: maps, shuffle: true } # an include's fields: that named playlist, shuffled
```

or a list of named playlists' names, each offered under its own name: `playlists: [travel, maps]`.

At the top level:

- `defaultScreen` is the screen for devices with neither `screen` nor `playlist`: a screen's name (`defaultScreen: placeholder`), or `screen` and `inputs` like a playlist entry. Without it, the server uses `placeholder` if that screen exists, otherwise the first screen found (alphabetically).
- `location` is where the devices are: `country` and `state` for public and school holidays in `when` (see [Playlists](ARCHITECTURE.md#playlists)), and `lat` and `lon` for sunrise and sunset in `when` and the `weather` screen. A device's own `location` overrides it.
- `playlists` names playlists, which devices can use (`playlist: kitchen`) and playlists can include.
- `tokens` holds other services' credentials: `strava` with the Strava app's `client_id` and `client_secret`, for the `strava` screen. Never sent to a browser.

### Playlists

A device shows a playlist: entries it moves through, each a screen with its inputs. Playlists can be named at the top level, shared by devices and included in other playlists:

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

location: # For public and school holidays (PH, SH in `when`), sunrise and sunset, and the weather screen; a device can have its own
  country: de
  state: Bayern
  lat: 48.14
  lon: 11.58

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

Each entry has these fields:

| Field      | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `screen`   | The screen to show                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `inputs`   | Its inputs, typed as the screen defines them (string, number, int, boolean, list); missing ones take the defaults. So the same screen can appear more than once (e.g. two stations)                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `duration` | How long the entry stays before the playlist moves on: `90s`, `10m`, `1h`, `1h30m`, at least `10s` (a device wakes at most every 5 s). Without it, the entry stays while its `when` applies                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `when`     | When the entry applies, in the device's time zone, in OpenStreetMap's [`opening_hours`](https://wiki.openstreetmap.org/wiki/Key:opening_hours/specification) syntax: `Mo-Fr 06:30-09:00`, `Sa,Su` (whole days), `22:00-02:00` (over midnight, counting for the day it starts), `Mo-Fr 06:30-09:00; We off` (a later rule replaces earlier ones for its days), `Dec 24 14:00-24:00`, `Mo[1]` (the first Monday of the month), `PH off` (not on public holidays), `SH` (school holidays), `(sunrise-01:00)-sunset` (from an hour before sunrise; needs `lat` and `lon` in `location`). Or `otherwise` (see below). Without it, always |
| `playlist` | Instead of `screen`: includes a named playlist's entries here. It can have a `when`, which applies to all of them on top of their own (both must apply), and a `duration`, which applies to those without their own                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `shuffle`  | Only with `playlist`: `true` plays the included entries in a random order, new each round (see below). Default `false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

`when: otherwise` applies when no other entry of the same playlist applies: the playlist it is written in, not the ones including it, which may have entries of their own (an included playlist counts as applying if any of its entries does). So a playlist covers all times without writing out the gaps, as `placeholder` above does.

- **Covering all times**: an entry without `when` applies always. Gaps are allowed: when no entry applies, the device shows `defaultScreen`.
- **Named playlists** are lists of entries, whose entries can have their own `when` and `duration`; the playlist itself has none. A device's `playlist` is a list of entries, or a named playlist's name (`playlist: travel`), and a device's `screen: x` is a playlist of one entry.
- **Includes** are written `- playlist: travel`, or just `- travel` when they need nothing else. An include's `when` applies to all its entries on top of their own (both must apply), and its `duration` to those without their own. A screen's name where a playlist is expected gets a message saying to write `screen: …`.
- **Shuffling**: `shuffle: true` on an include plays its entries in a random order, new each round (each entry once per round); the rest of the playlist keeps its order.
- **Holidays**: `PH` (public holidays) and `SH` (school holidays) need a `location`, at the top level or per device: `country` as a code such as `de` or `at`, and for `SH` the `state` as OpenStreetMap names it (`Bayern`, `Tirol`). Holidays of part of a state count for all of it: in Bavaria, the Augsburger Hohes Friedensfest (8 August) counts in Munich too; a later rule turns a day back on: `Mo-Fr 06:30-09:00; PH off; Aug 08 Mo-Fr 06:30-09:00`. School holidays are known a few years ahead (e.g. Tirol's until 2029); past that, an entry with `SH` doesn't apply, and the error is logged.
- **The sun**: `sunrise`, `sunset`, `dawn` and `dusk` (civil twilight), also with offsets such as `(sunrise-01:00)-sunrise` or `sunset-(sunset+00:30)`, need the location's `lat` and `lon`.
- **Moving through it**: a device starts at its playlist's first entry, and moves on when the entry's `duration` runs out or its `when` stops applying, to the next entry that applies. The screen page's Prev and Next move it too, and so does the device's button: a short press goes on, a double click or a 1–5 s hold goes back. Either way the entry shown gets its full `duration`.
- **Inputs** are checked against the screen's definitions (see [Screens](#screens)): an unknown input or a value of the wrong type (e.g. `routes` written as one string instead of a list) stops the server with a message saying where. Write lists as block lists (`- …` per line): routes and hide rules then need no quotes, while on one line (`[…]`) the brackets in `-[…]>` confuse YAML. Quote anything starting with `!` (a YAML tag) or containing `: ` (a key).

### Battery

Most of a device's battery goes on waking up (Wi-Fi and an HTTPS request, around 5–10 s at roughly 100 mA or more), much less on the download and the e-ink refresh. At 15-minute intervals the stock 2500 mAh battery lasts about 3–4 months, roughly 10,000 wakes per charge (the DIY kit's battery and sleep current may differ). Rough estimates:

| Pattern                                                         | Wakes per day | Battery lasts |
| --------------------------------------------------------------- | ------------- | ------------- |
| Departures all day, every minute                                | 1,440         | About 1 week  |
| Departures 06:30–09:00 every minute, otherwise every 15 minutes | About 235     | About 6 weeks |
| Every 5 minutes                                                 | 288           | About 5 weeks |
| Every 15 minutes                                                | 96            | 3–4 months    |

So the number of wakes matters far more than the number of redraws, and a `when` window around a screen that updates every minute saves the most.

A device wakes when its screen changes (every minute for departures), so a `when` window around a screen that updates every minute saves the most.

### Checks

The server checks the file at startup (required fields, unique usernames and MACs, valid time zones, existing playlists and `defaultScreen`, playlists that don't include each other, inputs, `location`, `duration`, and `when`: a syntax error, `PH`/`SH` without a `location`, or sunrise and the like without its `lat` and `lon`) and refuses to start if it's wrong. A playlist entry with an unknown screen is left out with a warning instead (see [Playlists](ARCHITECTURE.md#playlists)), which `scripts/deploy` shows with its config check.

### Environment variables

Everything else comes from environment variables: `dist/.env` when deployed (copied to the server by `scripts/deploy`, see [Deployment](ARCHITECTURE.md#deployment)), `.env` for `npm start` locally. Both are gitignored; `sample.env` and `dist/sample.env` document them.

| Variable                                      | Required | Meaning                                                                                                                                                                                                                             |
| --------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TOKEN_SECRET`                                | Yes      | At least 32 characters. Derives the devices' tokens and signs login sessions (see [Authentication](ARCHITECTURE.md#authentication)). Changing it logs everyone out and gives every device a new token, so each must be paired again |
| `SERVER_PORT`                                 | No       | Locally: the port to listen on. Deployed: the host port Caddy forwards to (inside the container it's always 7777). Default `7777`                                                                                                   |
| `SERVER_DOMAIN`                               | Deploy   | The public address, e.g. `https://trmnl.example.com`; registered with Caddy on deploy                                                                                                                                               |
| `TZ`                                          | No       | Default time zone for devices without `timezone`                                                                                                                                                                                    |
| `CONTACT`                                     | No       | How the services this server fetches from (Transitous, MVG, OpenFreeMap, …) can reach whoever runs it, e.g. an email address, sent in its User-Agent. Transitous' usage policy asks for one                                         |
| `DEV_PORT`                                    | No       | The dev server's port (`npm run dev`). Default `7778`                                                                                                                                                                               |
| `DEPLOY_HOST`                                 | Deploy   | The server `scripts/deploy` and `scripts/connect` connect to                                                                                                                                                                        |
| `DEPLOY_USER`, `DEPLOY_KEYPAIR`, `DEPLOY_DIR` | No       | Who to connect as, with which key, and the directory there (`.` by default; `dist/sample.env` sets `trmnl`, which the logs command under [Running](#running) assumes)                                                               |
| `SETUP_ENABLED`                               | No       | `1` to answer `/api/setup` while pairing a device. Default `0`. Deployed, only `npm run pair` sets it (Docker's settings override a value in `.env`); locally, `SETUP_ENABLED=1 npm start`, or a value in `.env`                    |

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

One of the latest Strava activities that aren't private, of the account connected for the device.

To connect one, the server needs a Strava app: register it at [strava.com/settings/api](https://www.strava.com/settings/api), with this server's domain as its callback domain, and put its `client_id` and `client_secret` under `tokens.strava` in `devices.yaml`. Then, while the device shows this screen, its page has a "Connect Strava" link under the preview: it logs in to Strava, which asks to allow access to the account's activities, and comes back to the page connected. "Disconnect Strava" there forgets the connection again (Strava still lists the app under the account's settings, where it can be revoked).

| Input    | Type | Default | Meaning                                                       |
| -------- | ---- | ------- | ------------------------------------------------------------- |
| `offset` | int  | `0`     | Which activity: `0` the latest, `1` the one before, and so on |

### `placeholder`

The device's name, battery, and the time and date. No inputs.

## Licence

The code is under the [MIT licence](LICENSE). It doesn't cover:

- the fonts in `assets/fonts/` (TRMNL's pixel fonts and Noto), each under the SIL Open Font License, as their licence files there say;
- Strava's "Powered by Strava" logo (`src/components/strava-logo.ts`), Strava's trademark, used unmodified as its [brand guidelines](https://developers.strava.com/guidelines/) allow;
- the dependencies, each under its own licence (see [Dependencies](ARCHITECTURE.md#dependencies)).
