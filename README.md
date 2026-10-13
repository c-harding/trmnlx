# A server for an e-ink display

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the server is built and configured.

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

## Protocol

The TRMNL device does all the talking. It sleeps most of the time, wakes up on a timer (or on a button press), polls the server over HTTP(S), downloads one image, draws it, and goes back to deep sleep. The server never pushes anything to the device. It can only steer the device through the response to the next poll.

### Pointing the device at this server

On first boot (or after a long press of the reset button) the device opens a Wi-Fi access point with a captive portal. You enter your Wi-Fi credentials there. The portal's advanced settings also take a custom server URL, which replaces the default `https://trmnl.com`. All endpoints below are relative to that URL.

### Lifecycle

```
wake ─► Wi-Fi ─► have API key? ──no──► GET /api/setup ─► store api_key + friendly_id
                     │yes                                      │
                     ▼                                         ▼
               GET /api/display  ◄─────────────────────────────┘
                     │
                     ├─ filename unchanged? ─► skip download
                     ├─ otherwise GET image_url, draw it
                     ├─ update_firmware? ─► download firmware_url, flash, reboot
                     ├─ reset_firmware?  ─► wipe API key and Wi-Fi, back to captive portal
                     ▼
               deep sleep for refresh_rate seconds
```

If something goes wrong, the device may also `POST /api/log`.

### `GET /api/setup`: registration

The device sends this once, when it has no stored API key. It is identified by its MAC address.

| Request header | Meaning                                   |
| -------------- | ----------------------------------------- |
| `ID`           | MAC address, e.g. `AA:BB:CC:DD:EE:FF`     |
| `Model`        | Device model identifier from the firmware |
| `Panel-Rev`    | Optional: identifier of the e-paper panel |

```json
{
  "status": 200,
  "api_key": "2r--SahjsAKCFksVcped2Q",
  "friendly_id": "917F0B",
  "image_url": "https://example.com/setup.bmp",
  "filename": "empty_state",
  "message": "Register device 917F0B"
}
```

- The device stores `api_key` and uses it as `Access-Token` on every later request.
- `friendly_id` is a short code the device shows to the user, for pairing it in a UI.
- If the MAC is unknown or rejected, the body has `"status": 404` and null fields. The **body `status` can differ from the HTTP status code**: TRMNL's own server answers HTTP 200 here. A self-hosted server can simply register any MAC it sees.

### `GET /api/display`: the poll

This is the main endpoint, called on every wake.

| Request header        | Meaning                                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Access-Token`        | **Required.** The `api_key` from setup                                                                                                                                                               |
| `ID`                  | MAC address                                                                                                                                                                                          |
| `Refresh-Rate`        | The sleep interval the device currently uses (seconds)                                                                                                                                               |
| `Battery-Voltage`     | e.g. `4.1`                                                                                                                                                                                           |
| `FW-Version`          | e.g. `1.6.2`                                                                                                                                                                                         |
| `RSSI`                | Wi-Fi signal strength, e.g. `-69`                                                                                                                                                                    |
| `Width`, `Height`     | Screen size in pixels (`800` × `480` for the OG)                                                                                                                                                     |
| `Model`               | Device model                                                                                                                                                                                         |
| `Update-Source`       | What woke the device: `timer`, `powercycle` (also after a restart or update), or the button as `EXT0`, `EXT1` or `button` depending on the chip; `unknown` otherwise                                 |
| `Temperature-Profile` | `true`: the device understands the `temperature_profile` response field                                                                                                                              |
| `special_function`    | `true` if the user triggered the button's special function (a double click or a 1–5 s hold; 5–15 s resets the Wi-Fi, 15 s or more all settings). Note the underscore: this is not `Special-Function` |

Newer firmware may send more telemetry headers (`Battery-Charging`, `USB-Connected`, `Image-Cached`, `Wake-Time`, `WiFi-Band`, …). All of them are optional, and a server can ignore any it doesn't care about. A failed `/api/display` (an HTTP error or a timeout) is retried up to 5 times, 2 s apart, with the same headers.

```json
{
  "status": 0,
  "image_url": "https://example.com/screens/abc123.png",
  "filename": "abc123",
  "refresh_rate": 900,
  "update_firmware": false,
  "firmware_url": null,
  "reset_firmware": false,
  "special_function": "identify"
}
```

| Response field                    | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status`                          | `0` = OK. `202` ("device not yet linked to a user") makes the device poll again every 5 seconds. `500` (TRMNL's answer to an unknown token) makes it clear all its settings, including Wi-Fi, like `reset_firmware`. An HTTP error status (e.g. 401) only shows an error screen and keeps the settings                                                                                                                   |
| `image_url`                       | Absolute URL of the image to show. It can be hosted anywhere, but only images on this server receive the device's credentials (see below)                                                                                                                                                                                                                                                                                |
| `filename`                        | Cache key. If it equals the last one, the device skips the download and the redraw                                                                                                                                                                                                                                                                                                                                       |
| `refresh_rate`                    | Seconds to sleep before the next poll. **This is how the server controls the schedule.** Older examples send it as a string                                                                                                                                                                                                                                                                                              |
| `update_firmware`, `firmware_url` | Tell the device to OTA-update from `firmware_url`                                                                                                                                                                                                                                                                                                                                                                        |
| `reset_firmware`                  | Tell the device to clear **all** its settings, including Wi-Fi, and restart into the captive portal                                                                                                                                                                                                                                                                                                                      |
| `special_function`                | What the device should do when the button's special function is used (e.g. `identify`), saved for its next press. In the response to a press, `action` must repeat it, or the firmware ignores the response. Each function behaves differently: `rewind` redraws the previous image from flash, while `identify`, `restart_playlist` and `guest_mode` download `image_url` (only `guest_mode` also takes `refresh_rate`) |
| `temperature_profile`             | How the panel drives grayscale: `default`, `a` (the panel's built-in fast and 4-gray modes) or `b` (darker grays)                                                                                                                                                                                                                                                                                                        |

### `GET <image_url>`: the image download

The device sends the same `ID` and `Access-Token` headers as on `/api/display`, but only if `image_url` starts with the exact server URL configured on the device. It's a plain string prefix check, so a different scheme, a `www.` or an explicit port counts as a different server and the image is fetched without credentials. Build image URLs from the same base URL the device uses.

This means image routes can require a valid `Access-Token` too, so screens aren't readable by anyone who knows the URL. It was added in firmware v1.8.10 ([bl.cpp](https://github.com/usetrmnl/trmnl-firmware/blob/main/src/bl.cpp)); older firmware fetches images without any headers.

The device sends no `Accept` header, but it checks the response:

- **`Content-Type` must be exactly `image/png`** (or `image/jpeg`). The firmware compares the whole header value, so `image/png; charset=binary` or `application/octet-stream` means the PNG isn't decoded as a PNG. BMPs are recognised by their first bytes, whatever the header says.
- **Send a `Content-Length`.** With it, the firmware streams the image into a buffer of that size. Without it, the firmware falls back to reading the whole response as a string.

### `POST /api/log`: diagnostics

The device sends this when something fails, e.g. a bad display response or an image download error. It authenticates with the `Access-Token` header and sends a JSON body:

```json
{
  "logs": [
    {
      "message": "...",
      "battery_voltage": 3.9,
      "refresh_rate": 900,
      ...
    }
  ]
}
```

Reply with `204 No Content`. Whatever the server returns, the device doesn't act on it.

### Image format

We use **4-shade grayscale**. Our device runs firmware 1.8.x, and grayscale needs 1.6.0 or later.

- **800 × 480 PNG, 2 bits per pixel**, with 4 shades: black, dark gray, light gray, white.
- The device detects grayscale from the PNG's bit depth. Nothing in the API response switches it on. A 2-bit PNG is drawn in 4 shades, and a 1-bit PNG or BMP3 is drawn in black and white.
- **Keep files under 90,000 bytes.** The firmware won't draw a larger image on the OG. Use maximum PNG compression. Dithering makes files bigger, so check the size when you dither.
- By default the device uses a fast, partial refresh. Send `"maximum_compatibility": true` in the `/api/display` response to force a full refresh instead (slower, with flashing, but it clears ghosting).

Example conversion with ImageMagick (drop the `-dither` option for flat UI graphics):

```sh
magick input.png -resize 800x480\! -colorspace Gray -dither FloydSteinberg \
  -posterize 4 -alpha off -depth 2 -define png:compression-level=9 -strip \
  png:output.png
```

`magick identify` reports this as `8-bit Grayscale Gray 4c`, but the file itself is stored at 2 bits per pixel, which is what the device checks.

For reference, black-and-white 1-bit images in BMP3 or PNG also still work.

### Notes for implementing a server

- Only `Access-Token` matters for authentication. The other headers are telemetry, so store whatever is useful (battery, RSSI) for a status page.
- Return a new `filename` only when the image actually changes. That saves the device a download and an e-ink refresh, though most of the battery goes on the wake itself (Wi-Fi and the request), so how often the device wakes matters more.
- A short `refresh_rate` drains the battery quickly. One update cycle takes about 10 s of Wi-Fi time. At 15-minute intervals the stock 2500 mAh battery lasts about 3–4 months.
- The device can't be reached between polls. Any change you make on the server takes effect at the next wake, at most `refresh_rate` seconds later.

### Sources

- Firmware README, "Web Server Endpoints": <https://github.com/usetrmnl/trmnl-firmware/blob/main/README.md#web-server-endpoints>
- TRMNL OpenAPI spec: <https://trmnl.com/api-docs/openapi.yaml>
- TRMNL ImageMagick guide (image formats): <https://docs.trmnl.com/go/diy/imagemagick-guide>

## TRMNL plugins

On TRMNL's hosted service, everything a screen shows comes from a plugin: calendar, weather, a custom dashboard. Plugins run entirely on the server. The device knows nothing about them; it only downloads the finished image through `/api/display`, as described above. A plugin is a recipe for producing that image from some data.

### What a plugin consists of

- **A data source** (the "strategy"), which supplies the variables.
- **Markup**: [Liquid](https://shopify.github.io/liquid/) templates (`{{ variable }}`, loops, filters) that turn the variables into HTML, styled with TRMNL's CSS framework.
- **Settings**: form fields that whoever installs the plugin fills in (e.g. a city or an API key), plus the fastest refresh rate the plugin allows.

### Data strategies

| Strategy     | How the data arrives                                                                                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Polling      | TRMNL fetches one or more URLs on each refresh (GET by default, POST possible, with custom headers). Responses can be JSON, RSS, XML, plain text or CSV. With several URLs, each response is available as `IDX_0`, `IDX_1`, … |
| Webhook      | Your own code POSTs the data to TRMNL. The stored variables are limited to 5 KB (10 KB with TRMNL+)                                                                                                                           |
| Plugin merge | The template gets the data of your other plugins                                                                                                                                                                              |

Form field values can be used in the markup and in polling URLs, headers and bodies, e.g. `{{ city }}`. TRMNL also provides globals such as `{{ trmnl.user.first_name }}`.

### Layouts

A plugin has one template per size, so it can share the screen with other plugins in a "mashup":

| Template          | Space on the screen |
| ----------------- | ------------------- |
| `full`            | The whole screen    |
| `half_horizontal` | Top or bottom half  |
| `half_vertical`   | Left or right half  |
| `quadrant`        | One quarter         |

The markup uses the framework's CSS classes (e.g. `view view--full`), which are designed for the e-ink panel's resolution and gray levels. A `shared` template holds markup used by all four.

### Rendering

TRMNL merges the variables into the template and renders the result as an image for the device. TRMNL's own documentation doesn't describe the pipeline, but the tools that reproduce it (trmnlp, LaraPaper) render the HTML in a headless browser, take a screenshot and convert it to a PNG for the device with ImageMagick. If the variables haven't changed since the last refresh, TRMNL doesn't render a new screen.

**Playlists** decide which plugin (or mashup) the device shows on each refresh. **Recipes** are plugins other people have published, which you can install as they are.

### Building plugins locally

[trmnlp](https://github.com/usetrmnl/trmnlp) is TRMNL's local development server for plugins. A plugin project looks like this:

```
src/
  full.liquid
  half_horizontal.liquid
  half_vertical.liquid
  quadrant.liquid
  shared.liquid
  settings.yml        # strategy, polling URLs, form fields; uploaded to TRMNL
.trmnlp.yml           # local settings, e.g. variable overrides; not uploaded
```

`trmnlp serve` previews the plugin as HTML or as PNG (PNG needs Firefox and ImageMagick 7), and `trmnlp push` uploads it to your TRMNL account.

### Relevance for this server

Our server has to produce the images itself, so it plays the role of TRMNL's plugin system. We can copy the same model: Liquid templates (e.g. with [LiquidJS](https://liquidjs.com/)) and the TRMNL framework CSS, rendered in a headless browser and converted to a 2-bit grayscale PNG. That would also let us develop screens with trmnlp. Of the existing self-hosted servers, Terminus, LaraPaper, Inker and BYOS Next.js support plugins; only Terminus supports recipes.

### Plugin sources

- Custom plugins (help article): <https://help.trmnl.com/en/articles/9510536-custom-plugins>
- Framework docs (views and mashups): <https://trmnl.com/framework/docs/3.4/view>
- trmnlp: <https://github.com/usetrmnl/trmnlp>
- BYOS overview and feature matrix: <https://docs.trmnl.com/go/diy/byos>
