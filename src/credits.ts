// A screen's credits (see Credit in define-screen.ts) as links under its preview in the browser: on
// the screen page and in the dev server. Both put `<p id="credits">` under the preview and call
// showCredits (from CREDITS_SCRIPT) with the credits of each image they show.
import type { Credit } from "./define-screen.ts";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The credits line for a page's first load: the links, separated by " · ". Always a line high, also
 * without any, so the page doesn't move when the screen shown changes.
 */
export const creditsHtml = (credits: Credit[]) =>
  `<p id="credits" style="min-height: 1lh">${credits
    .map(({ text, url }) => `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`)
    .join(" · ")}</p>`;

/**
 * For a page's script: showCredits(credits) replaces the line's links, built with DOM methods
 * (textContent, href) rather than HTML, so no text in them can become markup.
 */
export const CREDITS_SCRIPT = `
function showCredits(credits) {
  const line = document.getElementById("credits");
  line.replaceChildren(
    ...credits.flatMap(({ text, url }, i) => {
      const link = document.createElement("a");
      link.href = url;
      link.textContent = text;
      return i ? [" · ", link] : [link];
    }),
  );
}`;
