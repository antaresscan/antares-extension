// The round marks in front of the flags of the token page (cross, "!", tick): one 16 x 16 drawing each, circle and symbol together, so that on a screen scaled to 125 % or
// 150 % every circle is the same size and every symbol is on the centre of its circle. A circle of 14px is 17.5 device pixels at 125 % and comes out 17 or 18 from one row to
// the next; a character in it is placed on the pixel grid on its own and sits off centre. Twin of contents/modules/round-marks.ts of the extension (same geometry: every symbol
// is laid out around (8, 8)); this one builds a string because the page writes its markup with template strings. The strings are constants: nothing from the API goes in.
const SYMBOLS = {
  r: '<path class="mark-ink" d="M5.2 5.2L10.8 10.8M10.8 5.2L5.2 10.8"/>',
  g: '<path class="mark-ink" d="M4.5 8.15L7 10.55L11.5 5.45"/>',
  y: '<path class="mark-ink" d="M8 4.65L8 8.45"/><circle class="mark-dot" cx="8" cy="11.2" r="0.95"/>',
};

/** The drawing of a mark: "r" (cross, critical), "y" ("!", warning) or "g" (tick). Anything else draws nothing. */
export function markSvg(key) {
  const symbol = Object.prototype.hasOwnProperty.call(SYMBOLS, key) ? SYMBOLS[key] : "";
  if (!symbol) return "";
  return '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><circle class="mark-bg" cx="8" cy="8" r="8"/>' + symbol + "</svg>";
}
