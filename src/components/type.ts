// Text sizes for the screens: TRMNL's pixel fonts below 32 px, each at the one size it's drawn for,
// and Inter from 32 px (see render.ts).

/** Sizes of the pixel fonts TRMNL12, TRMNL16 and TRMNL21 */
export type PixelSize = 12 | 16 | 21;
/** Sizes in Inter, for headings, clocks and other large text */
export type LargeSize = 32 | 36 | 72 | 120;

/** The font for text of `size` px: a pixel font up to 21, Inter from 32. */
export const textSize = (size: PixelSize | LargeSize) =>
  ({ fontFamily: size < 32 ? `TRMNL${size}` : "Inter", fontSize: size }) as const;
