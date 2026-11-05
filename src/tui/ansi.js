// ANSI primitives for the dashboard: color depth, styling, and width-aware padding/clipping.
// Every styling helper returns the input untouched when color is "none", so --no-color /
// NO_COLOR frames contain zero escape bytes.
export const ESC = "\x1b[";

let MODE = "256";
/** "truecolor" | "256" | "none" */
export const setColorMode = (m) => { MODE = m === "truecolor" || m === "none" ? m : "256"; };
export const colorMode = () => MODE;

// Nearest xterm-256 color: the 6x6x6 cube or the 24-step gray ramp, whichever is closer.
// (The plain cube maps dark slates to bright grays; the ramp keeps dark bands dark.)
const LEVELS = [0, 95, 135, 175, 215, 255];
const cubeIdx = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
const cache = new Map();
export function to256(r, g, b) {
  const key = (r << 16) | (g << 8) | b;
  if (cache.has(key)) return cache.get(key);
  const [cr, cg, cb] = [cubeIdx(r), cubeIdx(g), cubeIdx(b)];
  const cd = (LEVELS[cr] - r) ** 2 + (LEVELS[cg] - g) ** 2 + (LEVELS[cb] - b) ** 2;
  const avg = (r + g + b) / 3, gi = Math.max(0, Math.min(23, Math.round((avg - 8) / 10))), gv = 8 + 10 * gi;
  const gd = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
  const idx = gd < cd ? 232 + gi : 16 + 36 * cr + 6 * cg + cb;
  cache.set(key, idx);
  return idx;
}

export const sgr = (layer, [r, g, b]) => MODE === "none" ? "" : MODE === "truecolor" ? `${ESC}${layer};2;${r};${g};${b}m` : `${ESC}${layer};5;${to256(r, g, b)}m`;
export const fg = (c) => (s) => (MODE === "none" ? s : `${sgr(38, c)}${s}${ESC}39m`);
export const bg = (c) => (s) => (MODE === "none" ? s : `${sgr(48, c)}${s}${ESC}49m`);
export const bold = (s) => (MODE === "none" ? s : `${ESC}1m${s}${ESC}22m`);
export const dim = (s) => (MODE === "none" ? s : `${ESC}2m${s}${ESC}22m`);
export const reset = () => (MODE === "none" ? "" : `${ESC}0m`);

const SGR_RE = /\x1b\[[0-9;]*m/g;
export const visible = (s) => s.replace(SGR_RE, "");
export const width = (s) => [...visible(s)].length;
export const pad = (s, w, right = false) => { const n = w - width(s); return n <= 0 ? s : right ? " ".repeat(n) + s : s + " ".repeat(n); };
export const center = (s, w) => { const n = w - width(s); if (n <= 0) return s; const l = Math.floor(n / 2); return " ".repeat(l) + s + " ".repeat(n - l); };

/** Cut a styled string to w visible cells (keeps escape codes, closes styles when it cuts). */
export function clip(s, w) {
  if (width(s) <= w) return s;
  let n = 0, res = "";
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b[")) { res += part; continue; }
    for (const ch of part) { if (n >= w) return res + reset(); res += ch; n++; }
  }
  return res;
}
/** Exactly w visible cells. */
export const fit = (s, w) => pad(clip(s, w), w);
/** Truncate plain (unstyled) text with an ellipsis. */
export const ell = (t, w) => { const a = [...String(t)]; return w <= 0 ? "" : a.length <= w ? a.join("") : a.slice(0, Math.max(0, w - 1)).join("") + "…"; };

/** Paint a full-width background band; inner background resets fall back to the band color. */
export function band(s, w, color) {
  if (MODE === "none") return fit(s, w);
  const open = sgr(48, color);
  const body = fit(s, w).replaceAll(`${ESC}49m`, open).replaceAll(`${ESC}0m`, `${ESC}0m${open}`);
  return `${open}${body}${ESC}49m`;
}
