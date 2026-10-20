// The round marks of the Critical Flags panel: the cross, "!", "i" and tick in front of a flag, and the number in front of a section.
//
// Each one is ONE small drawing, circle and symbol together, built with the DOM API (no innerHTML). It used to be a CSS circle with a font character (or a shape
// drawn by two pseudo-elements) on top, and on a screen scaled to 125 % or 150 % that fell apart: a 14px circle is 17.5 device pixels, which the browser rounds to
// 17 or 18 depending on where the row happens to sit, so two circles side by side were not the same size and a cross was not square; the character and the circle
// were snapped on their own, so the symbol was off centre by a pixel one way in one row and the other way in the next. In a drawing the circle and the symbol are
// painted from the same origin, so they cannot drift apart, and the circle is 16px: a whole number of device pixels (20 at 125 %, 24 at 150 %, 28 at 175 %, 32 at 200 %).
// scripts/overlay-alignment.mjs measures them in a real Chromium at those scalings.

const NS = "http://www.w3.org/2000/svg"

function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(NS, tag)
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value)
  return el
}

function drawing(width: number): SVGElement {
  // The size is in the attributes: the drawing never depends on the page's CSS to know how big it is.
  return svgEl("svg", { viewBox: `0 0 ${width} 16`, width: String(width), height: "16", "aria-hidden": "true", focusable: "false" })
}

export type MarkKey = "r" | "y" | "b" | "g"

// Every symbol is drawn so that the middle of its ink is the middle of the 16 x 16 circle (8, 8): the same length on each side of the centre.
const SYMBOLS: Record<MarkKey, () => SVGElement[]> = {
  // cross: two strokes crossed at the centre
  r: () => [svgEl("path", { class: "cf-mark-ink", d: "M5.2 5.2L10.8 10.8M10.8 5.2L5.2 10.8" })],
  // tick
  g: () => [svgEl("path", { class: "cf-mark-ink", d: "M4.5 8.15L7 10.55L11.5 5.45" })],
  // "!": a bar over a dot
  y: () => [svgEl("path", { class: "cf-mark-ink", d: "M8 4.65L8 8.45" }), svgEl("circle", { class: "cf-mark-dot", cx: "8", cy: "11.2", r: "0.95" })],
  // "i": a dot over a bar
  b: () => [svgEl("circle", { class: "cf-mark-dot", cx: "8", cy: "4.75", r: "0.95" }), svgEl("path", { class: "cf-mark-ink", d: "M8 7.35L8 11.45" })],
}

/** The mark of a flag: the circle of its severity with the symbol drawn in it. The symbol's character stays in the element (hidden by the CSS) for screen readers. */
export function drawMark(host: HTMLElement, key: MarkKey): void {
  const root = drawing(16)
  root.appendChild(svgEl("circle", { class: "cf-mark-bg", cx: "8", cy: "8", r: "8" }))
  for (const part of SYMBOLS[key]()) root.appendChild(part)
  host.appendChild(root)
}

// Outlines of the digits 0-9 of Bebas Neue at 12px, taken from the font the overlay bundles (styles.ts): [advance, left and right edge of the ink, path]. The origin of a path is
// the baseline at the left of the advance box, and y grows downward. A digit is drawn, not typed, for the same reason as the rest of the mark: a character is placed on the
// device pixel grid on its own (its height and its baseline snap to whole pixels), the circle behind it is not, so the digit sat up to 0.7 device pixel off centre on one
// row and on the other on the next one at a 125 % screen.
export const DIGITS: Record<string, [number, number, number, string]> = {
  "0": [4.8, 0.4, 4.4, "M0.4 -1.99V-6.41Q0.4 -7.42 0.91 -7.97Q1.43 -8.52 2.4 -8.52Q3.37 -8.52 3.89 -7.97Q4.4 -7.42 4.4 -6.41V-1.99Q4.4 -0.98 3.89 -0.43Q3.37 0.12 2.4 0.12Q1.43 0.12 0.91 -0.43Q0.4 -0.98 0.4 -1.99ZM3.08 -1.91V-6.49Q3.08 -7.32 2.4 -7.32Q1.72 -7.32 1.72 -6.49V-1.91Q1.72 -1.08 2.4 -1.08Q3.08 -1.08 3.08 -1.91Z"],
  "1": [4.8, 0.96, 3.66, "M2.34 -6.41H0.96V-7.34Q1.52 -7.34 1.87 -7.44Q2.21 -7.54 2.41 -7.76Q2.62 -7.98 2.77 -8.4H3.66V0H2.34Z"],
  "2": [4.8, 0.47, 4.4, "M0.47 -0.91Q0.47 -1.81 0.76 -2.45Q1.04 -3.1 1.79 -3.88Q2.52 -4.66 2.8 -5.21Q3.08 -5.76 3.08 -6.36Q3.08 -6.9 2.91 -7.11Q2.74 -7.32 2.4 -7.32Q1.72 -7.32 1.72 -6.49V-5.59H0.47V-6.41Q0.47 -7.43 0.97 -7.97Q1.48 -8.52 2.44 -8.52Q3.4 -8.52 3.9 -7.97Q4.4 -7.43 4.4 -6.41Q4.4 -5.64 4.04 -4.91Q3.67 -4.18 2.77 -3.23Q2.18 -2.6 1.98 -2.21Q1.78 -1.82 1.78 -1.38V-1.2H4.28V0H0.47Z"],
  "3": [4.8, 0.4, 4.33, "M0.4 -1.97V-2.65H1.64V-1.91Q1.64 -1.08 2.33 -1.08Q2.66 -1.08 2.84 -1.29Q3.01 -1.5 3.01 -2.03V-2.71Q3.01 -3.29 2.81 -3.53Q2.6 -3.78 2.15 -3.78H1.7V-4.98H2.18Q2.58 -4.98 2.78 -5.18Q2.98 -5.39 2.98 -5.87V-6.48Q2.98 -6.91 2.8 -7.12Q2.62 -7.32 2.32 -7.32Q1.68 -7.32 1.68 -6.54V-5.99H0.43V-6.43Q0.43 -7.44 0.93 -7.98Q1.43 -8.52 2.36 -8.52Q3.31 -8.52 3.8 -7.99Q4.3 -7.45 4.3 -6.44V-6.14Q4.3 -5.46 4.07 -5.05Q3.84 -4.63 3.36 -4.45V-4.43Q3.88 -4.24 4.1 -3.8Q4.33 -3.37 4.33 -2.7V-1.96Q4.33 -0.95 3.83 -0.41Q3.34 0.12 2.36 0.12Q1.39 0.12 0.89 -0.42Q0.4 -0.96 0.4 -1.97Z"],
  "4": [4.8, 0.18, 4.64, "M2.7 -1.52H0.18V-2.72L2.58 -8.4H4.02V-2.72H4.64V-1.52H4.02V0H2.7ZM2.7 -2.72V-6H2.68L1.38 -2.72Z"],
  "5": [4.8, 0.46, 4.39, "M0.46 -1.99V-2.65H1.7V-1.9Q1.7 -1.08 2.39 -1.08Q3.07 -1.08 3.07 -1.9V-3.78Q3.07 -4.61 2.39 -4.61Q1.7 -4.61 1.7 -3.78V-3.71H0.46L0.7 -8.4H4.18V-7.2H1.87L1.76 -5.2H1.79Q2.16 -5.81 2.93 -5.81Q3.65 -5.81 4.02 -5.32Q4.39 -4.82 4.39 -3.89V-1.99Q4.39 -0.97 3.89 -0.43Q3.38 0.12 2.42 0.12Q1.46 0.12 0.96 -0.43Q0.46 -0.97 0.46 -1.99Z"],
  "6": [4.8, 0.43, 4.44, "M0.43 -1.99V-6.34Q0.43 -8.52 2.45 -8.52Q3.41 -8.52 3.91 -7.97Q4.42 -7.43 4.42 -6.41V-6.25H3.17V-6.49Q3.17 -7.32 2.48 -7.32Q2.11 -7.32 1.93 -7.09Q1.75 -6.86 1.75 -6.29V-4.68H1.78Q2.12 -5.41 2.98 -5.41Q3.7 -5.41 4.07 -4.92Q4.44 -4.43 4.44 -3.49V-1.99Q4.44 -0.98 3.92 -0.43Q3.41 0.12 2.44 0.12Q1.46 0.12 0.95 -0.43Q0.43 -0.98 0.43 -1.99ZM3.12 -1.9V-3.38Q3.12 -4.21 2.44 -4.21Q1.75 -4.21 1.75 -3.38V-1.9Q1.75 -1.08 2.44 -1.08Q3.12 -1.08 3.12 -1.9Z"],
  "7": [4.8, 0.41, 4.37, "M3.07 -7.2H0.41V-8.4H4.37V-7.25L2.3 0H0.96Z"],
  "8": [4.8, 0.34, 4.46, "M0.34 -1.96V-2.7Q0.34 -3.32 0.54 -3.75Q0.74 -4.18 1.2 -4.42V-4.44Q0.78 -4.67 0.58 -5.07Q0.38 -5.47 0.38 -6.1V-6.44Q0.38 -7.45 0.91 -7.99Q1.43 -8.52 2.4 -8.52Q3.37 -8.52 3.89 -7.99Q4.42 -7.45 4.42 -6.44V-6.1Q4.42 -4.9 3.6 -4.44V-4.42Q4.06 -4.18 4.26 -3.75Q4.46 -3.32 4.46 -2.7V-1.96Q4.46 -0.95 3.93 -0.41Q3.4 0.12 2.4 0.12Q1.4 0.12 0.87 -0.41Q0.34 -0.95 0.34 -1.96ZM3.1 -5.82V-6.48Q3.1 -7.32 2.4 -7.32Q1.7 -7.32 1.7 -6.48V-5.82Q1.7 -4.98 2.4 -4.98Q3.1 -4.98 3.1 -5.82ZM3.14 -2.03V-2.83Q3.14 -3.78 2.4 -3.78Q1.66 -3.78 1.66 -2.83V-2.03Q1.66 -1.08 2.4 -1.08Q3.14 -1.08 3.14 -2.03Z"],
  "9": [4.8, 0.36, 4.37, "M0.38 -1.99V-2.15H1.63V-1.91Q1.63 -1.08 2.32 -1.08Q2.69 -1.08 2.87 -1.31Q3.05 -1.54 3.05 -2.11V-3.72H3.02Q2.68 -2.99 1.82 -2.99Q1.1 -2.99 0.73 -3.48Q0.36 -3.97 0.36 -4.91V-6.41Q0.36 -7.42 0.88 -7.97Q1.39 -8.52 2.36 -8.52Q3.34 -8.52 3.85 -7.97Q4.37 -7.42 4.37 -6.41V-2.06Q4.37 0.12 2.35 0.12Q1.39 0.12 0.89 -0.43Q0.38 -0.97 0.38 -1.99ZM3.05 -5.02V-6.5Q3.05 -7.32 2.36 -7.32Q1.68 -7.32 1.68 -6.5V-5.02Q1.68 -4.19 2.36 -4.19Q3.05 -4.19 3.05 -5.02Z"],
}
export const DIGIT_HEIGHT = 8.4 // the height of the flat-topped digits, which is what the eye centres

/** The number of a section: a circle for one digit, a pill from two (a whole number of pixels wide, like the circle is), the digits drawn as outlines with the middle of their ink on the middle of the shape. The number also stays in the element as text (hidden by the CSS) for screen readers. */
export function drawCount(host: HTMLElement, n: number): void {
  const digits = String(n)
  host.textContent = digits
  const width = digits.length < 2 ? 16 : digits.length < 3 ? 24 : 32
  const root = drawing(width)
  root.appendChild(svgEl("rect", { class: "cf-count-bg", x: "0", y: "0", width: String(width), height: "16", rx: "8" }))
  const glyphs = [...digits].map((ch, i) => ({ glyph: DIGITS[ch], at: i * DIGITS["0"][0] })).filter((g) => g.glyph)
  if (glyphs.length > 0) {
    const inkLeft = glyphs[0].at + glyphs[0].glyph[1]
    const inkRight = glyphs[glyphs.length - 1].at + glyphs[glyphs.length - 1].glyph[2]
    const x = width / 2 - (inkLeft + inkRight) / 2
    const y = 8 + DIGIT_HEIGHT / 2
    for (const { glyph, at } of glyphs) {
      const path = svgEl("path", { class: "cf-count-num", d: glyph[3] })
      path.setAttribute("transform", "translate(" + +(x + at).toFixed(2) + " " + y + ")")
      root.appendChild(path)
    }
  }
  host.appendChild(root)
}
