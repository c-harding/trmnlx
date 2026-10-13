// Text sizes for the screens: TRMNL's pixel fonts below 32 px, each at the one size it's drawn for,
// and Noto Sans from 32 px (see render.ts).

/** Sizes of the pixel fonts TRMNL12, TRMNL16 and TRMNL21 */
export type PixelSize = 12 | 16 | 21;
/** Sizes in Noto Sans, for headings, clocks and other large text */
export type LargeSize = 32 | 36 | 72 | 120;

/** The font for text of `size` px: a pixel font up to 21, Noto Sans from 32. */
export const textSize = (size: PixelSize | LargeSize) =>
  ({ fontFamily: size < 32 ? `TRMNL${size}` : "Noto Sans", fontSize: size }) as const;

/**
 * Text with its emoji reduced to what Noto Emoji draws on its own: without variation selectors
 * (U+FE0E, U+FE0F), skin tones, and joiners with what they join on (a gender sign: "🏃‍♂️" → "🏃";
 * other joined emoji are drawn side by side). Satori doesn't combine these as the font would, and
 * draws each as a wide gap or a separate swatch.
 */
export const plainEmoji = (text: string) =>
  text
    .replace(/\u200d[\u2640\u2642]/gu, "")
    .replace(/[\ufe0e\ufe0f\u200d\u{1f3fb}-\u{1f3ff}]/gu, "");
