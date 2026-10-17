// A QR code, e.g. for a link to what a screen shows: black modules on white, each a whole number of
// pixels and without anti-aliasing, so it scans from the display. Encoded by qrcode-generator.
import qrcode from "qrcode-generator";

// Medium error correction: some damage (or e-ink ghosting) is fine
const encode = (text: string) => {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  return code;
};

/** How wide (and high) QrCode draws `text`, e.g. to make what's beside it as high. */
export const qrSize = (text: string, module: number, margin = 2) =>
  (encode(text).getModuleCount() + 2 * margin) * module;

/**
 * `text` as a QR code `module` px per module, with a quiet zone of `margin` modules around it
 * (scanners want some white around a code; 2 is usually enough on a white screen).
 */
export function QrCode({
  text,
  module,
  margin = 2,
}: {
  text: string;
  module: number;
  margin?: number;
}) {
  const code = encode(text);
  const count = code.getModuleCount();
  const size = (count + 2 * margin) * module;
  // One path for all dark modules, a square each
  let d = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (code.isDark(row, col))
        d += `M${(col + margin) * module} ${(row + margin) * module}h${module}v${module}h-${module}Z`;
    }
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" shapeRendering="crispEdges" />
    </svg>
  );
}
