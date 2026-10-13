import assert from "node:assert/strict";
import { test } from "node:test";
import { creditsHtml } from "../src/credits.ts";
import { playlistChoice, screenPage, statusText } from "../src/pages.ts";

// journeys, the second of three entries that apply now; departures applies at other times
const status = {
  playlist: "default",
  choices: ["default"],
  screen: "journeys",
  index: 1,
  position: 2,
  count: 3,
  otherTimes: ["departures"],
  now: new Date("2026-10-12T10:00:00Z"),
  timeZone: "Europe/Berlin",
};
const caption = (checkIn: { shown: number | undefined; next: string } | undefined) =>
  statusText({
    ...status,
    checkIn: checkIn && { shown: checkIn.shown, next: new Date(checkIn.next) },
  }).caption;

test("the screen page says which entry is showing, among those that apply now", () => {
  const text = statusText({ ...status, checkIn: undefined });
  assert.equal(text.showing, "Showing journeys (2/3)");
  assert.equal(text.title, "Also in the playlist, at other times: departures");
  assert.equal(text.canMove, true);
  assert.equal(
    statusText({ ...status, count: 1, position: 1, otherTimes: [], checkIn: undefined }).showing,
    "Showing journeys",
  );
  assert.equal(
    statusText({ ...status, count: 1, position: 1, otherTimes: [], checkIn: undefined }).canMove,
    false,
  );
});

test("with nothing applying, it says the default screen is showing", () => {
  const text = statusText({
    ...status,
    screen: "placeholder",
    index: -1,
    position: 0,
    count: 0,
    otherTimes: ["journeys"],
    checkIn: undefined,
  });
  assert.equal(
    text.showing,
    "Showing placeholder, the default: nothing in the playlist applies now",
  );
  assert.equal(text.canMove, false);
});

test("the preview is live once the device got the entry", () => {
  assert.equal(caption({ shown: 1, next: "2026-10-12T10:05:00Z" }), "Live preview:");
  // Still live when the device is overdue: it keeps showing what it got
  assert.equal(caption({ shown: 1, next: "2026-10-12T09:58:00Z" }), "Live preview:");
});

test("otherwise it says when the device will pick it up", () => {
  assert.equal(
    caption({ shown: 0, next: "2026-10-12T10:05:00Z" }),
    "Preview (will be applied at 12:05):",
  );
  assert.equal(
    caption({ shown: 0, next: "2026-10-13T06:05:00Z" }),
    "Preview (will be applied at 13 Oct 2026, 08:05):",
  );
  // Overdue, or no check-in since the server started
  assert.equal(
    caption({ shown: 0, next: "2026-10-12T09:58:00Z" }),
    "Preview (will be applied when device comes online):",
  );
  assert.equal(caption(undefined), "Preview (will be applied when device comes online):");
});

test("a playlist can be chosen when there's another to switch to", () => {
  // Only its own playlist: nothing to choose
  assert.equal(playlistChoice({ playlist: "default", choices: ["default"] }), "");
  assert.equal(
    playlistChoice({ playlist: "travel", choices: ["default", "travel", "<maps>"] }),
    '<form method="post" action="/playlist"><p><label>Playlist <select name="name" id="playlist"><option value="default">default</option><option value="travel" selected>travel</option><option value="&#60;maps&#62;">&#60;maps&#62;</option></select></label> <noscript><button>Switch</button></noscript></p></form>\n',
  );
  // Without a playlist of its own, it shows the default screen until one is chosen, even if there's only one
  const before = playlistChoice({ playlist: "default", choices: ["travel"] });
  assert.match(
    before,
    /<option value="" selected disabled>none \(default screen\)<\/option><option value="travel">travel<\/option>/,
  );
  assert.equal(playlistChoice({ playlist: "travel", choices: ["travel"] }), "");
});

test("Prev and Next are on the page even when there's nothing to move to, for a switch from another tab", () => {
  const html = screenPage("kitchen", { ...status, count: 1, position: 1, checkIn: undefined });
  assert.match(html, /<span id="moves" hidden>/);
});

test("credits are linked under the preview, escaped", () => {
  const credits = [{ text: "© OpenStreetMap", url: "https://www.openstreetmap.org/copyright" }];
  assert.equal(
    creditsHtml(credits),
    '<p id="credits" style="min-height: 1lh"><a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a></p>',
  );
  // Without any, still there, keeping its line
  assert.equal(creditsHtml([]), '<p id="credits" style="min-height: 1lh"></p>');
  assert.equal(
    creditsHtml([{ text: "<b>", url: '"x' }]),
    '<p id="credits" style="min-height: 1lh"><a href="&#34;x">&#60;b&#62;</a></p>',
  );
});
