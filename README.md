# A server for an e-ink display

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
                     ├─ reset_firmware?  ─► wipe API key etc., re-run setup
                     ▼
               deep sleep for refresh_rate seconds
```

If something goes wrong, the device may also `POST /api/log`.

### `GET /api/setup`: registration

The device sends this once, when it has no stored API key. It is identified by its MAC address.

| Request header | Meaning                                         |
|----------------|-------------------------------------------------|
| `ID`           | MAC address, e.g. `AA:BB:CC:DD:EE:FF`           |
| `Model`        | Device model identifier from the firmware       |
| `Panel-Rev`    | Optional: identifier of the e-paper panel       |

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

| Request header    | Meaning                                                |
|-------------------|--------------------------------------------------------|
| `Access-Token`    | **Required.** The `api_key` from setup                 |
| `ID`              | MAC address                                            |
| `Refresh-Rate`    | The sleep interval the device currently uses (seconds) |
| `Battery-Voltage` | e.g. `4.1`                                             |
| `FW-Version`      | e.g. `1.6.2`                                           |
| `RSSI`            | Wi-Fi signal strength, e.g. `-69`                      |
| `Width`, `Height` | Screen size in pixels (`800` × `480` for the OG)       |
| `Model`           | Device model                                           |
| `Update-Source`   | What woke the device, e.g. the timer or the button     |
| `Temperature-Profile` | `true`: the device understands the `temperature_profile` response field |
| `special_function`| `true` if the user triggered the button's special function. Note the underscore: this is not `Special-Function` |

Newer firmware may send more telemetry headers (`Battery-Charging`, `USB-Connected`, `Image-Cached`, `Wake-Time`, `WiFi-Band`, …). All of them are optional, and a server can ignore any it doesn't care about.

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

| Response field     | Meaning |
|--------------------|---------|
| `status`           | `0` = OK. TRMNL uses `202` for "device not yet linked to a user" and `500` (with `error`) for an unknown token |
| `image_url`        | Absolute URL of the image to show. It can be hosted anywhere, but only images on this server receive the device's credentials (see below) |
| `filename`         | Cache key. If it equals the last one, the device skips the download and the redraw |
| `refresh_rate`     | Seconds to sleep before the next poll. **This is how the server controls the schedule.** Older examples send it as a string |
| `update_firmware`, `firmware_url` | Tell the device to OTA-update from `firmware_url` |
| `reset_firmware`   | Tell the device to forget its credentials and re-run setup |
| `special_function` | What the device should do when the button's special function is used (e.g. `identify`) |
| `temperature_profile` | How the panel drives grayscale: `default`, `a` (the panel's built-in fast and 4-gray modes) or `b` (darker grays) |

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
- Return a new `filename` only when the image actually changes. That saves the device a download and an e-ink refresh, which is where most of the battery goes.
- A short `refresh_rate` drains the battery quickly. One update cycle takes about 10 s of Wi-Fi time. At 15-minute intervals the stock 2500 mAh battery lasts about 3–4 months.
- The device can't be reached between polls. Any change you make on the server takes effect at the next wake, at most `refresh_rate` seconds later.

### Sources

- Firmware README, "Web Server Endpoints": <https://github.com/usetrmnl/trmnl-firmware/blob/main/README.md#web-server-endpoints>
- TRMNL OpenAPI spec: <https://trmnl.com/api-docs/openapi.yaml>
- TRMNL ImageMagick guide (image formats): <https://docs.trmnl.com/go/diy/imagemagick-guide>