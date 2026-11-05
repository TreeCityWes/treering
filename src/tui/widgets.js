// Reusable dashboard widgets: palette, mood bars, sparklines, meters, panels and columns.
import { DEADBAND } from "../config.js";
import { fg, bg, bold, dim, pad, fit, width, colorMode } from "./ansi.js";

// ── Palette (tuned for dark terminals) ─────────────────────────────────────────────────
export const PAL = {
  fg: [226, 232, 240], soft: [148, 163, 184], mute: [100, 116, 139], faint: [51, 65, 85], track: [44, 54, 72],
  up: [52, 211, 153], down: [251, 113, 133], warn: [251, 191, 36], info: [125, 211, 252], accent: [196, 181, 253],
  ink: [15, 23, 42], frame: [71, 85, 105], liveFrame: [190, 52, 85],
  bandDry: [24, 32, 50], bandLive: [96, 14, 36], keycap: [51, 65, 85],
};
export const C = Object.fromEntries(Object.entries(PAL).map(([k, v]) => [k, fg(v)]));

// ── Mood ring color: −100 deep red → 0 slate violet → +100 emerald ───────────────────────
export function moodColor(score) {
  if (score == null) return PAL.mute;
  const t = Math.max(-1, Math.min(1, score / 100));
  const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
  const mid = [139, 128, 196];
  return t < 0 ? mix(mid, [244, 63, 94], -t) : mix(mid, [16, 214, 160], t);
}
export const moodPaint = (score) => fg(moodColor(score));
export const signed = (n) => (n > 0 ? `+${n}` : String(n));

/** The wordmark; each letter takes a hue around the ring, rotating with `t`. */
export function wordmark(t = 0) {
  const hues = [[244, 63, 94], [251, 146, 60], [250, 204, 21], [52, 211, 153], [56, 189, 248], [129, 140, 248], [192, 132, 252], [244, 114, 182]];
  return [..."TREERING"].map((ch, i) => bold(fg(hues[(i + t) % hues.length])(ch))).join("");
}

/**
 * Diverging score bar, 2·half+1 cells, centered on zero. The fill is a gradient: each cell takes
 * the mood color of the score at its edge, so long bars fade violet → red/green like a mood ring.
 * Scores inside the deadband (bot holds) render as a dim hatch.
 */
export function moodBar(score, half) {
  const len = score == null ? 0 : (Math.abs(score) / 100) * half;
  let full = Math.floor(len), part = len - full >= 0.35;
  if (len > 0 && full === 0 && !part) part = true;
  const inBand = score != null && Math.abs(score) < DEADBAND;
  const side = (neg) => {
    const cells = [];
    for (let d = 1; d <= half; d++) {
      const on = score != null && score !== 0 && (score < 0) === neg;
      const edge = (neg ? -1 : 1) * Math.min(100, (d / half) * 100);
      if (on && (d <= full || (d === full + 1 && part))) {
        const ch = d <= full ? "█" : neg ? "▐" : "▌";
        cells.push(inBand ? dim(moodPaint(score)(d <= full ? "▒" : ch)) : fg(moodColor(edge))(ch));
      } else cells.push(C.track(Math.abs(edge) <= DEADBAND + 0.01 ? "╌" : "·"));
    }
    return cells;
  };
  return side(true).reverse().join("") + C.soft("│") + side(false).join("");
}

/** Position gauge on the same diverging axis: holding = solid fill, target = bright marker. */
export function bookGauge(current, target, cap, half) {
  const cells = Array.from({ length: half * 2 + 1 }, (_, i) => (i === half ? C.soft("│") : C.track("·")));
  if (!(cap > 0)) return cells.join("");
  const at = (v) => { const d = Math.min(half, Math.round((Math.abs(v) / cap) * half)); return v < 0 ? half - d : half + d; };
  if (Math.abs(current) > 0.005) {
    const end = at(current), col = current > 0 ? C.up : C.down;
    const from = Math.min(end, half), to = Math.max(end, half);
    for (let i = from; i <= to; i++) if (i !== half) cells[i] = col("█");
    if (end === half) cells[half + (current > 0 ? 1 : -1)] = col(current > 0 ? "▌" : "▐");
  }
  if (target == null || !Number.isFinite(target)) return cells.join("");
  const t = at(target);
  cells[t] = bold(fg(PAL.fg)(t === half ? "┼" : "┃"));
  return cells.join("");
}

const TICKS = "▁▂▃▄▅▆▇█";
function resample(values, w) {
  const n = Math.min(w, values.length);
  return Array.from({ length: n }, (_, i) => {
    const lo = Math.floor((i * values.length) / n), hi = Math.max(lo + 1, Math.floor(((i + 1) * values.length) / n));
    const seg = values.slice(lo, hi); return seg.reduce((x, y) => x + y, 0) / seg.length;
  });
}
function scaled(v, levels) {
  // Height auto-scales to this market's own range (min span 10 pts); color shows the absolute mood.
  let lo = Math.min(...v), hi = Math.max(...v);
  if (hi - lo < 10) { const m = (hi + lo) / 2; lo = m - 5; hi = m + 5; }
  return v.map((x) => Math.min(levels - 1, Math.max(0, Math.round(((x - lo) / (hi - lo)) * (levels - 1)))));
}
/** One-row sparkline of the ~24h history, right-aligned in w cells. */
export function spark(values, w) {
  if (!values?.length || w < 1) return " ".repeat(Math.max(0, w));
  const v = resample(values, w), lv = scaled(v, 8);
  return pad(v.map((x, i) => moodPaint(x)(TICKS[lv[i]])).join(""), w, true);
}
/** Two-row sparkline (16 levels) for roomy layouts. Returns [top, bottom]. */
export function spark2(values, w) {
  if (!values?.length || w < 1) return [" ".repeat(Math.max(0, w)), " ".repeat(Math.max(0, w))];
  const v = resample(values, w), lv = scaled(v, 16);
  const top = v.map((x, i) => (lv[i] >= 8 ? moodPaint(x)(TICKS[lv[i] - 8]) : " ")).join("");
  const bot = v.map((x, i) => moodPaint(x)(lv[i] >= 8 ? "█" : TICKS[lv[i]])).join("");
  return [pad(top, w, true), pad(bot, w, true)];
}

/**
 * The mood ring as a scale (idea from the Grok design): a −100…+100 gradient rule with a bright
 * marker at `score` (the traded book's average mood). Exactly w cells.
 */
export function moodScale(score, w) {
  const l = "-100 ", r = " +100";
  const n = Math.max(3, w - l.length - r.length);
  const at = score == null ? -1 : Math.round(((Math.max(-100, Math.min(100, score)) + 100) / 200) * (n - 1));
  let s = "";
  for (let i = 0; i < n; i++) {
    const v = -100 + (200 * i) / Math.max(1, n - 1);
    if (i === at) s += colorMode() === "none" ? "|" : bold(fg([255, 255, 255])("◆"));
    else if (i === Math.round((n - 1) / 2)) s += C.soft("┼");
    else s += fg(moodColor(v))(colorMode() === "none" ? "=" : "━");
  }
  return moodPaint(-100)(l) + s + moodPaint(100)(r);
}

// Braille dot bits: [row 0..3][col 0..1]
const BIT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
/**
 * Braille line chart (idea from the Grok design): 2×4 dots per cell, each cell colored by the mean
 * mood of the points it draws. Returns `rows` strings of `cols` cells.
 */
export function brailleChart(series, cols, rows, lo, hi) {
  const h = rows * 4, span = hi - lo || 1;
  const grid = Array.from({ length: rows }, () => new Uint16Array(cols));
  const sum = Array.from({ length: rows }, () => new Float64Array(cols));
  const cnt = Array.from({ length: rows }, () => new Uint16Array(cols));
  const yOf = (v) => Math.max(0, Math.min(h - 1, Math.round((1 - (Math.max(lo, Math.min(hi, v)) - lo) / span) * (h - 1))));
  let prev = null;
  for (let x = 0; x < series.length; x++) {
    const v = series[x];
    if (!Number.isFinite(v)) { prev = null; continue; }
    const y = yOf(v), a = Math.min(prev ?? y, y), b = Math.max(prev ?? y, y);
    for (let yy = a; yy <= b; yy++) {
      const cx = x >> 1, cy = yy >> 2;
      if (cx >= cols || cy >= rows) continue;
      grid[cy][cx] |= BIT[yy & 3][x & 1]; sum[cy][cx] += v; cnt[cy][cx] += 1;
    }
    prev = y;
  }
  return grid.map((row, r) => Array.from(row, (bits, c) => (bits ? moodPaint(sum[r][c] / cnt[r][c])(String.fromCharCode(0x2800 + bits)) : " ")).join(""));
}

/** Horizontal meter with 1/8-cell resolution. */
export function meter(frac, w, color) {
  const f = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0)) * w;
  const full = Math.floor(f), rem = Math.floor((f - full) * 8);
  const partial = rem > 0 && full < w ? "▏▎▍▌▋▊▉"[rem - 1] : "";
  return fg(color)("█".repeat(full) + partial) + C.track("─".repeat(Math.max(0, w - full - (partial ? 1 : 0))));
}

/** Long vs short split bar: green from the left, red from the right. */
export function splitBar(long, short, w) {
  const gross = long + short;
  if (!(gross > 0)) return C.track("─".repeat(w));
  const l = Math.round((long / gross) * w), s = w - l;
  return C.up("█".repeat(l)) + C.down("█".repeat(s));
}

/** Rounded panel. Body lines are clipped/padded to the inner width; h (if set) pads/clips rows. */
export function panel({ title, right = "", w, body, h, tint = C.frame, titleColor = C.accent }) {
  const inner = w - 4;
  const head = ` ${bold(titleColor(title))} `;
  const tail = right ? ` ${right} ` : "";
  const fill = Math.max(0, w - 3 - width(head) - width(tail) - 1);
  const lines = [tint("╭─") + head + tint("─".repeat(fill)) + tail + tint("─╮")];
  let rows = body;
  if (h != null) {
    const room = Math.max(0, h - 2);
    rows = body.length > room ? body.slice(0, room) : [...body, ...Array(room - body.length).fill("")];
  }
  for (const r of rows) lines.push(tint("│") + " " + fit(r, inner) + " " + tint("│"));
  lines.push(tint("╰" + "─".repeat(w - 2) + "╯"));
  return lines;
}

/** Section rule for compact layouts: ── TITLE ──────── right ── */
export function rule(title, w, right = "", tint = C.frame) {
  const head = ` ${bold(C.accent(title))} `, tail = right ? ` ${right} ` : "";
  return tint("──") + head + tint("─".repeat(Math.max(0, w - 4 - width(head) - width(tail)))) + tail + tint("──");
}

/** Place blocks of lines side by side. cols: [{lines, w}] */
export function hjoin(cols, gap = 1) {
  const h = Math.max(...cols.map((c) => c.lines.length));
  return Array.from({ length: h }, (_, i) => cols.map((c) => fit(c.lines[i] ?? "", c.w)).join(" ".repeat(gap)));
}

export const keycap = (k) => (colorMode() === "none" ? `[${k}]` : bold(bg(PAL.keycap)(fg(PAL.fg)(` ${k} `))));
export const badge = (txt, color, ink = PAL.ink) => (colorMode() === "none" ? `[${txt}]` : bold(bg(color)(fg(ink)(` ${txt} `))));
