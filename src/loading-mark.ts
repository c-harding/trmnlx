// TRMNL's mark as a loading indicator for previews in the browser (the screen page and the dev
// server), as the firmware's loading screen shows it in its corner (src/loading.h there): seven bars
// around a circle, each tilted 45° against its radius. Redrawn from the bitmap's measurements rather
// than copied, matching it to within 1.3% of its pixels. While loading, one bar at a time is black
// and the rest gray, going round clockwise (each bar's animation is started part of the way through,
// by a negative delay).

const BARS = 7;
const CYCLE_S = 1.4;

/** The mark, to put in the preview after the image (a class, so a page can have several previews). */
export const LOADING_MARK = `<svg class="loading-mark" viewBox="0 0 86 86" aria-label="Loading"><g transform="translate(42.6 43)">${Array.from(
  { length: BARS },
  (_bar, k) =>
    `<rect x="-12.3" y="-6.2" width="24.6" height="12.4" transform="rotate(${(-165.6 + (k * 360) / BARS).toFixed(2)}) translate(29.5 0) rotate(-45.3)"` +
    ` style="animation-delay: ${(((k - BARS) * CYCLE_S) / BARS).toFixed(2)}s"/>`,
).join("")}</g></svg>`;

/**
 * The CSS for a preview with the mark. `preview` selects it: a one-cell grid (display: grid;
 * grid-template: 1fr / 1fr) holding the image and the mark, with the class "loading" while the next
 * image loads. From 0.3 s on (so quick loads don't flicker), the image is hidden, leaving white like
 * the device's loading screen, and the mark shows where that has it: 43 px, 25 px from the right
 * and 23 px from the bottom, scaled with the preview (margins in % are of the width). When the
 * preview is larger than what's visible of it (zoomed in) and that corner is scrolled out of view,
 * the mark sticks to the visible part's corner instead: sticky works for an element in the flow,
 * hence the grid rather than absolute positioning.
 */
export const loadingMarkCss = (preview: string) => `
${preview} img { grid-area: 1 / 1; }
${preview}.loading img { visibility: hidden; transition: visibility 0s 0.3s; }
${preview} .loading-mark { grid-area: 1 / 1; align-self: end; justify-self: end; position: sticky; right: 8px; bottom: 8px; margin: 0 3.125% 2.875% 0; width: 5.375%; aspect-ratio: 1; opacity: 0; }
${preview} .loading-mark rect { fill: #aaa; }
${preview}.loading .loading-mark { opacity: 1; transition: opacity 0s 0.3s; }
${preview}.loading .loading-mark rect { animation: ${CYCLE_S}s step-end infinite going-round; }
@keyframes going-round { 0% { fill: #000; } ${(100 / BARS).toFixed(2)}% { fill: #aaa; } }
`;
