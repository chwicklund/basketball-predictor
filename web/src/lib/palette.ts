// Chart colours: the dataviz skill's categorical palette, validated on the white card surface
// (all adjacent pairs clear the colour-blind and normal-vision floors). Aqua, yellow and pink sit
// under 3:1 against white, so every mark in those colours carries a written label.
// SVG attributes can't read CSS variables, so the hex lives here; index.css mirrors --home and --away.

export const HOME = "#2a78d6";  // slot 1, blue
export const AWAY = "#eb6834";  // slot 2, orange

// Colour follows the stat, in a fixed order, on every chart
export const STAT_COLOR: Record<string, string> = {
  MIN: "#2a78d6", PTS: "#eb6834", TRB: "#1baf7a", AST: "#eda100",
  "3P": "#e87ba4", STL: "#008300", BLK: "#6250d6", TOV: "#e34948",
};

// Status: reserved for right and wrong calls, always beside a word or icon
export const GOOD = "#0ca30c";
export const BAD = "#d03b3b";
export const PENDING = "#c9c8c5";

/** A pale tint of a colour on white, for ranges and the bars behind the one that matters. */
export function tint(hex: string, amount = 0.25) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [n >> 16, (n >> 8) & 255, n & 255].map((c) => Math.round(c * amount + 255 * (1 - amount)));
  return `rgb(${ch.join(",")})`;
}
