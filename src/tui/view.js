// Frame composition. Pure: draw(input) → array of styled lines, each exactly W cells or less,
// never more than H lines. Three responsive layouts:
//   compact  (< 110 cols or < 30 rows)  one combined markets table, section rules
//   stacked  (110–169 cols)             KPI tiles + full-width panels
//   wide     (≥ 170 cols)               KPI tiles + two columns (crowd │ book, orders, activity)
import { DEADBAND } from "../config.js";
import { fg, bold, dim, pad, fit, clip, ell, width, band, reset, colorMode } from "./ansi.js";
import { PAL, C, moodColor, moodPaint, signed, wordmark, moodBar, bookGauge, spark, spark2, meter, splitBar, panel, rule, hjoin, keycap, badge, moodScale, brailleChart } from "./widgets.js";

// ── formatting ────────────────────────────────────────────────────────────────────────────
const num = (n, d = 2) => Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export function usd(n, { sign = false, compact = false } = {}) {
  if (n == null || !Number.isFinite(n)) return "—";
  const s = n < 0 ? "-" : sign && n > 0 ? "+" : "";
  const a = Math.abs(n);
  if (compact && a >= 1e6) return `${s}$${num(a / 1e6, 2)}M`;
  if (compact && a >= 1e4) return `${s}$${num(a / 1e3, 1)}k`;
  return `${s}$${num(a, a >= 1e5 ? 0 : 2)}`;
}
const dur = (sec) => { if (sec == null || !Number.isFinite(sec)) return "—"; const s = Math.max(0, Math.round(sec)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}` : `${Math.floor(s / 86400)}d`; };
const ago = (ts, now) => (ts ? `${dur((now - ts) / 1000)} ago` : "—");
const clock = (ms) => { if (ms == null) return "—"; const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const hms = (ts) => new Date(ts).toLocaleTimeString("en-GB", { hour12: false });
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const bare = (coin) => coin.replace(/^xyz:/, "");
const sgnCol = (n) => (Math.abs(n ?? 0) < 0.005 ? C.mute : n > 0 ? C.up : C.down);

// ── model: everything the layouts need, derived once per frame ───────────────────────────
export function model({ s, ctl, events = [], signal, signalErr, cfg, running, now = Date.now(), dataDir }) {
  const c = s?.cfg ?? cfg ?? {};
  const markets = c.markets ?? [];
  const tradedSet = new Set(markets.flatMap((m) => [m, bare(m)]));
  const sig = signal ?? (s?.signal ? { timestamp: s.signal.timestamp, coins: s.signal.coins.map((x) => ({ ...x, history: [] })), fromState: true } : null);
  const coins = [...(sig?.coins ?? [])].map((x) => ({ ...x, traded: tradedSet.has(x.coin) }));
  const order = (x) => { const i = markets.findIndex((m) => m === x.coin || bare(m) === x.coin); return i < 0 ? 1e3 : i; };
  coins.sort((a, b) => order(a) - order(b));
  const traded = coins.filter((x) => x.traded), watched = coins.filter((x) => !x.traded);

  const equity = s?.equity, dayStart = s?.dayStart, dayPnl = s?.dayPnl;
  const dayPct = dayStart > 0 && dayPnl != null ? (dayPnl / dayStart) * 100 : null;
  const killPct = c.killPct ?? 0.1, lev = c.leverage ?? null;
  const stopAt = dayStart > 0 ? dayStart * (1 - killPct) : null;
  const budget = dayStart > 0 ? dayStart * killPct : null;
  const room = stopAt != null && equity != null ? equity - stopAt : null;
  const roomFrac = budget ? Math.max(0, Math.min(1, room / budget)) : null;

  // A failed cycle leaves no plan; fall back to the last known positions so exposure stays visible.
  let rows = s?.rows ?? [];
  if (!rows.length && s?.positions) rows = Object.entries(s.positions).filter(([, p]) => p.szi).map(([coin, p]) => {
    const mid = s.mids?.[coin], cur = mid > 0 ? p.szi * mid : Math.sign(p.szi) * (p.value ?? 0);
    const sc = coins.find((x) => x.coin === coin || x.coin === bare(coin));
    return { coin, score: sc?.score ?? null, current: cur, target: null, gap: 0, actions: [], stale: true };
  });
  let long = 0, short_ = 0;
  for (const r of rows) { if (r.current > 0) long += r.current; else short_ -= r.current; }
  const gross = long + short_, net = long - short_;
  const cap = equity > 0 && lev ? equity * lev : null;
  const perCoin = cap && markets.length ? cap / markets.length : null;
  const levUsed = equity > 0 ? gross / equity : null;
  const upnl = rows.reduce((n, r) => n + (s?.positions?.[r.coin]?.upnl ?? 0), 0);

  const state = !s ? "nostate" : !running ? "stopped" : s.killed ? "lossstop" : s.error ? "error" : ctl.paused ? "paused" : "running";
  const intervalMs = (c.intervalSec ?? 300) * 1000;
  const nextMs = running && s?.nextCycleAt ? s.nextCycleAt - now : null;
  const sigAge = sig?.timestamp ? (now - sig.timestamp) / 1000 : null;
  const maxAge = c.maxSignalAgeSec ?? 600;
  const tradedScores = traded.map((x) => x.score).filter((x) => x != null);
  const avgMood = tradedScores.length ? tradedScores.reduce((a, b) => a + b, 0) / tradedScores.length : null;
  // Actionable rows first (idea from the GLM design), then the configured market order.
  const acting = (r) => (r.actions ?? []).some((a) => /OPEN|ADD|REDUCE|CLOSE|FLIP/.test(a));
  rows = rows.map((r, i) => [r, i]).sort((a, b) => Number(acting(b[0])) - Number(acting(a[0])) || a[1] - b[1]).map(([r]) => r);
  const equitySeries = events.filter((e) => e.kind === "cycle").map((e) => e.equity ?? Number(/equity \$([\d.,]+)/.exec(e.msg ?? "")?.[1]?.replace(/,/g, ""))).filter(Number.isFinite);
  if (equity != null && equitySeries.at(-1) !== equity) equitySeries.push(equity);

  return { s, ctl, events, sig, signalErr, c, markets, coins, traded, watched, equity, dayStart, dayPnl, dayPct, killPct, lev, stopAt, budget, room, roomFrac,
    rows, long, short: short_, gross, net, cap, perCoin, levUsed, upnl, state, running, intervalMs, nextMs, sigAge, maxAge, avgMood, equitySeries, now, dataDir };
}

// ── shared pieces ─────────────────────────────────────────────────────────────────────────
const STATE = {
  running: { txt: "▶ RUNNING", col: [52, 211, 153] },
  paused: { txt: "❚❚ PAUSED", col: [251, 191, 36] },
  stopped: { txt: "■ STOPPED", col: [120, 134, 156] },
  nostate: { txt: "■ NO STATE", col: [120, 134, 156] },
  error: { txt: "✗ ERROR", col: [251, 146, 60] },
  lossstop: { txt: "✗ LOSS STOP", col: [251, 113, 133] },
};

function header(m, W, ui) {
  const live = m.ctl.live, narrow = W < 100;
  const ring = fg(moodColor(m.avgMood))("◉");
  const net = m.s?.network ?? m.c.network ?? "";
  const who = narrow ? "" : `${C.soft(net)} ${C.mute("·")} ${C.mute("owner")} ${C.soft(short(m.s?.owner))}${W >= 150 ? ` ${C.mute("· agent")} ${C.soft(short(m.s?.agent))}` : ""}`;
  const left = ` ${ring} ${wordmark(Math.floor(ui.frame / 4))}  ${narrow ? C.soft(net) : who}`;
  const st = m.ctl.paused && (m.state === "stopped" || m.state === "nostate") ? { ...STATE[m.state], txt: `${STATE[m.state].txt} · PAUSED` } : STATE[m.state];
  const mk = (n) => (live ? badge(n ? "● LIVE" : "● LIVE · REAL ORDERS", [255, 92, 120], [40, 0, 10]) : badge(n ? "○ DRY-RUN" : "○ DRY-RUN · SIMULATED", [148, 163, 184]));
  const modeB = width(left) + width(mk(false)) + width(st.txt) + 6 <= W ? mk(false) : mk(true);
  const right = `${modeB} ${badge(st.txt, st.col)} `;
  const gap = W - width(left) - width(right);
  return band(left + " ".repeat(Math.max(1, gap)) + right, W, live ? PAL.bandLive : PAL.bandDry);
}

function outcome(m) {
  const s = m.s;
  if (!s?.ts) return "";
  if (s.error) return "";
  const n = s.orders?.length ?? 0, ords = `${n} order${n === 1 ? "" : "s"}`;
  if (!s.skip) return C.up(`sent ${ords}`);
  if (s.skip === "no orders needed") return C.soft("book on target, nothing to send");
  return `${C.fg(`${ords} planned`)} ${C.mute("·")} ${C.warn(`not sent: ${s.skip}`)}`;
}

function ribbon(m, W) {
  const s = m.s, last = s?.ts ? C.mute(`last cycle ${ago(s.ts, m.now)}${s.reason ? ` (${s.reason})` : ""}`) : "";
  const dot = C.mute(" · ");
  let lead, col;
  switch (m.state) {
    case "nostate": col = C.soft; lead = `${C.soft("No bot state yet")}${dot}${C.mute(`start the bot (npm run bot); watching ${m.dataDir ?? "data/"}`)}`; break;
    case "stopped": col = C.soft; lead = `${C.soft("Bot is not running")}${dot}${C.mute("showing its last saved state")}`; break;
    case "error": col = C.down; lead = `${bold(C.down("Last cycle failed:"))} ${C.down(s.error)}`; break;
    case "lossstop": col = C.down; lead = `${bold(C.down("Daily loss stop hit"))}${dot}${C.soft("only reduces/closes until the UTC day rolls over")}`; break;
    case "paused": col = C.warn; lead = `${bold(C.warn("Paused"))}${dot}${C.soft("cycles run, no orders are sent")}`; break;
    default: col = C.up; lead = bold(C.up("Running"));
  }
  const nxt = m.nextMs != null ? `${C.mute("next cycle")} ${bold(C.info(clock(m.nextMs)))} ` : "";
  const shortLast = s?.ts ? C.mute(`last cycle ${ago(s.ts, m.now)}`) : "";
  const leadShort = lead.split(dot)[0];
  const oc = m.state === "error" ? "" : s?.error ? C.down(`last cycle failed: ${s.error}`) : outcome(m);
  // Most informative first; drop detail until it fits.
  const variants = [[lead, last, oc], [leadShort, last, oc], [leadShort, shortLast, oc], [leadShort, oc], [leadShort, shortLast], [leadShort]];
  let text = "";
  for (const v of variants) { text = ` ${col("▌")}${v.filter(Boolean).join(dot)}`; if (width(text) + width(nxt) + 1 <= W) break; }
  if (width(text) + width(nxt) + 1 > W) text = clip(text, Math.max(10, W - width(nxt) - 1)) + reset();
  return pad(text, W - width(nxt)) + nxt;
}

// KPI tiles: [{label, value, sub(w)}]
function kpis(m) {
  const t = [];
  const eqSpark = m.equitySeries.length >= 2 ? (w) => { const txt = ` ${C.mute(`start ${usd(m.dayStart, { compact: true })}`)}`; const sw = Math.min(m.equitySeries.length, w - width(txt), 16); return sw >= 2 ? spark(m.equitySeries, sw) + txt : txt.trim(); } : () => C.mute(`day start ${usd(m.dayStart, { compact: true })}`);
  t.push({ label: "EQUITY", value: bold(C.fg(usd(m.equity, { compact: true }))), sub: eqSpark });
  t.push({ label: "TODAY", value: bold(sgnCol(m.dayPnl)(usd(m.dayPnl, { sign: true, compact: true }))) + (m.dayPct != null ? " " + sgnCol(m.dayPnl)(`${signed(Number(m.dayPct.toFixed(2)))}%`) : ""), sub: () => `${C.mute("open uPnL")} ${sgnCol(m.upnl)(usd(m.upnl, { sign: true }))}` });
  if (m.s?.killed) t.push({ label: "LOSS STOP", value: bold(C.down("HIT")), sub: () => C.down("adds & flips blocked") });
  else {
    const col = m.roomFrac == null ? PAL.mute : m.roomFrac > 0.6 ? PAL.up : m.roomFrac > 0.3 ? PAL.warn : PAL.down;
    t.push({ label: `LOSS STOP −${Math.round(m.killPct * 100)}%`, value: bold(fg(col)(usd(m.room, { compact: true }))) + C.mute(" room"), sub: (w) => { const txt = ` ${C.mute(`@ ${usd(m.stopAt, { compact: true })}`)}`; const mw = w - width(txt); return mw >= 4 ? meter(m.roomFrac ?? 0, mw, col) + txt : txt.trim(); } });
  }
  t.push({ label: "EXPOSURE", value: bold(C.fg(m.levUsed != null ? `${m.levUsed.toFixed(2)}x` : "—")) + C.mute(` / ${m.lev ?? "?"}x max`), sub: (w) => { const txt = ` ${C.mute(m.net < 0 ? "net short" : "net long")}`; const bw = w - width(txt); return bw >= 4 ? splitBar(m.long, m.short, bw) + txt : txt.trim(); } });
  if (m.nextMs != null) {
    const frac = 1 - m.nextMs / m.intervalMs;
    t.push({ label: "NEXT CYCLE", value: bold(C.info(clock(m.nextMs))) + (m.ctl.paused ? C.warn(" paused") : m.ctl.live ? C.down(" live") : C.mute(" dry")), sub: (w) => { const txt = ` ${C.mute(`every ${dur(m.intervalMs / 1000)}`)}`; const mw = w - width(txt); return mw >= 4 ? meter(frac, mw, PAL.info) + txt : txt.trim(); } });
  } else t.push({ label: "NEXT CYCLE", value: C.soft("not scheduled"), sub: () => C.mute(m.state === "nostate" ? "no bot state" : "bot is stopped") });
  if (m.sigAge != null) {
    const stale = m.sigAge > m.maxAge, col = stale ? PAL.down : m.sigAge > 120 ? PAL.warn : PAL.up;
    t.push({ label: "SIGNAL", value: bold(fg(col)(stale ? "STALE" : dur(m.sigAge))) + C.mute(stale ? ` ${dur(m.sigAge)}` : " old") + (m.sig.fromState ? C.mute(" (cached)") : ""), sub: (w) => { const txt = ` ${C.mute(`skip >${dur(m.maxAge)}`)}`; const mw = w - width(txt); return m.signalErr ? C.warn(ell("refresh failed", w)) : mw >= 4 ? meter(m.sigAge / m.maxAge, mw, col) + txt : txt.trim(); } });
  } else t.push({ label: "SIGNAL", value: m.signalErr ? C.down("unavailable") : C.mute("loading…"), sub: (w) => C.mute(ell(m.signalErr ?? "fetching mood ring", w)) });
  return t;
}

function tiles(m, W, tint) {
  const t = kpis(m), n = t.length;
  const tw = Math.floor((W - 2 - 3 * (n - 1)) / n);
  const sep = tint(" │ ");
  const row = (f) => " " + t.map((x) => fit(f(x), tw)).join(sep);
  return [row((x) => C.mute(x.label)), row((x) => x.value), row((x) => x.sub(tw))];
}

function kpiLine(m, W) {
  const roomCol = m.s?.killed ? C.down : m.roomFrac == null ? C.mute : m.roomFrac > 0.6 ? C.up : m.roomFrac > 0.3 ? C.warn : C.down;
  const sigCol = m.sigAge == null ? C.mute : m.sigAge > m.maxAge ? C.down : m.sigAge > 120 ? C.warn : C.up;
  const items = [
    `${C.mute("equity")} ${bold(C.fg(usd(m.equity, { compact: true })))}`,
    `${C.mute("today")} ${bold(sgnCol(m.dayPnl)(usd(m.dayPnl, { sign: true, compact: true })))}${m.dayPct != null ? " " + sgnCol(m.dayPnl)(`${signed(Number(m.dayPct.toFixed(1)))}%`) : ""}`,
    `${C.mute("stop room")} ${roomCol(m.s?.killed ? "HIT" : usd(m.room, { compact: true }))}`,
    `${C.mute("lev")} ${C.fg(m.levUsed != null ? `${m.levUsed.toFixed(2)}x` : "—")}`,
    `${C.mute("signal")} ${sigCol(m.sigAge == null ? (m.signalErr ? "error" : "…") : m.sigAge > m.maxAge ? "STALE" : dur(m.sigAge))}`,
  ];
  const held = m.rows.filter((r) => Math.abs(r.current) > 0.005).length;
  if (m.s && held) { const rest = (m.s.stops ?? []).filter((x) => x.status === "resting").length; items.push(`${C.mute("stops")} ${(rest >= held ? C.up : C.warn)(`${rest}/${held}`)}`); }
  // Shed the least important items (leverage, then signal age) before anything is cut off.
  for (const drop of [[], [3], [3, 4]]) {
    const keep = items.filter((_, i) => !drop.includes(i));
    for (const sep of ["   ", "  ", " "]) { const out = " " + keep.join(sep); if (width(out) <= W) return out; }
  }
  return " " + items.join(" ");
}

// ── mood ring rows ──────────────────────────────────────────────────────────────────────
function delta(h) {
  if (!h?.length || h.length < 2) return C.mute("  ·");
  const d = Math.round(h.at(-1) - h[0]);
  return d === 0 ? C.mute(" ±0") : d > 0 ? C.up(pad(`↑${d}`, 4, true)) : C.down(pad(`↓${-d}`, 4, true));
}
function nameCell(x, w, keepPrefix) {
  const mark = x.traded ? moodPaint(x.score)("●") : C.faint("·");
  const pre = keepPrefix && x.coin.startsWith("xyz:") ? C.mute("xyz:") : "";
  const nm = ell(keepPrefix ? bare(x.coin) : bare(x.coin), w - 2 - (pre ? 4 : 0));
  return `${mark} ${pre}${x.traded ? bold(C.fg(nm)) : C.soft(nm)}`;
}
const scoreCell = (x) => pad(x.score == null ? C.mute("—") : bold(moodPaint(x.score)(signed(x.score))), 4, true);
const labelCell = (x, w) => { const t = ell(x.label ?? "", w); return x.score != null && Math.abs(x.score) >= DEADBAND ? moodPaint(x.score)(t) : C.mute(t); };
const crowdCell = (x) => (x.tradersLong != null ? `${C.up(`▲${x.tradersLong}`)} ${C.down(`▼${x.tradersShort}`)}` : "");

/** Mood ring panel body. opts: {w, tall, sep} */
function moodBody(m, w, { tall = false, sep = true, collapse = false } = {}) {
  const nameW = w >= 90 ? 14 : 10, labelW = w >= 76 ? 15 : 0, crowdW = w >= 70 ? 8 : 0;
  const fixed = nameW + 1 + 4 + 1 + 1 + labelW + (labelW ? 1 : 0) + crowdW + 1 + 4;
  const free = w - fixed;
  const half = Math.max(5, Math.min(16, Math.floor((free * (tall ? 0.5 : 0.42)) / 2)));
  const sparkW = Math.max(0, w - fixed - (half * 2 + 1));
  const row = (x) => {
    const lead = `${pad(nameCell(x, nameW, w >= 90), nameW)} ${scoreCell(x)} ${moodBar(x.score, half)} ${labelW ? pad(labelCell(x, labelW), labelW) + " " : ""}${crowdW ? pad(crowdCell(x), crowdW) : ""}`;
    if (!tall) return [`${lead}${spark(x.history, sparkW - 1)} ${delta(x.history)}`];
    const [top, bot] = spark2(x.history, sparkW - 1);
    const h = x.history ?? [];
    const range = h.length && labelW ? C.faint(ell(`24h ${signed(Math.round(Math.min(...h)))} … ${signed(Math.round(Math.max(...h)))}`, labelW)) : "";
    const pre = nameW + 1 + 4 + 1;
    return [`${lead}${top} ${delta(x.history)}`, `${" ".repeat(pre)}${rangeBar(h, half)} ${pad(range, labelW)}${labelW ? " " : ""}${" ".repeat(crowdW)}${bot}`];
  };
  const out = [];
  for (const x of m.traded) out.push(...row(x));
  if (m.watched.length) {
    if (collapse) out.push(watchLine(m, w));
    else { if (sep) out.push(C.faint(`┄┄ watching, not traded ${"┄".repeat(Math.max(0, w - 24))}`)); for (const x of m.watched) out.push(...row(x)); }
  }
  if (!m.coins.length) out.push(m.signalErr ? C.down(`signal unavailable: ${m.signalErr}`) : C.mute("loading the mood ring…"));
  return out;
}
/** 24h score range drawn on the same axis as the mood bar, under it. */
function rangeBar(h, half) {
  if (!h?.length) return " ".repeat(half * 2 + 1);
  const lo = Math.min(...h), hi = Math.max(...h);
  const cell = (v) => Math.max(0, Math.min(half * 2, half + Math.round((v / 100) * half)));
  const a = cell(lo), b = cell(hi);
  return Array.from({ length: half * 2 + 1 }, (_, i) => {
    if (i >= a && i <= b) { const v = ((i - half) / half) * 100; return fg(moodColor(v))(i === a ? "╶" : i === b ? "╴" : "─"); }
    return i === half ? C.faint("╎") : " ";
  }).join("");
}
function watchLine(m, w) {
  let s = C.mute("also watching ");
  for (const x of m.watched) {
    const it = `${C.soft(bare(x.coin))} ${moodPaint(x.score)(x.score == null ? "—" : signed(x.score))}  `;
    if (width(s) + width(it) > w) { s += C.mute("…"); break; }
    s += it;
  }
  return s;
}
const moodRight = (m) => {
  if (!m.sig) return m.signalErr ? C.down("signal error") : C.mute("loading…");
  const bits = [m.sig.fromState ? C.warn("cached from bot (live fetch failed)") : C.mute(`updated ${ago(m.sig.timestamp, m.now)}`)];
  if (m.signalErr && !m.sig.fromState) bits.push(C.warn("refresh failed"));
  bits.push(C.mute(`deadband ±${DEADBAND}`), C.mute("24h →"));
  return bits.join(C.faint(" · "));
};

// ── book rows ───────────────────────────────────────────────────────────────────────────
function actionLabel(r, m, w) {
  const a = r.actions ?? [], gap = Math.abs(r.gap ?? 0), amt = usd(gap, { compact: true });
  const hold = r.score == null || Math.abs(r.score) < DEADBAND;
  let t, col;
  if (r.stale) { t = "— no plan"; col = C.mute; }
  else if (a.includes("BLOCKED")) { t = "⛔ blocked: stop hit"; col = C.down; }
  else if (a.includes("FLIP-CLOSE")) { t = a.includes("FLIP-OPEN") ? `⇄ flip ${r.target > 0 ? "long" : "short"}` : "× close (flip)"; col = C.warn; }
  else if (a.includes("CLOSE")) { t = "× close all"; col = C.warn; }
  else if (a.includes("OPEN")) { t = `${r.target > 0 ? "▲ buy" : "▼ sell"} ${amt}${w >= 16 ? " open" : ""}`; col = C.info; }
  else if (a.includes("ADD")) { t = `${r.gap > 0 ? "▲ buy" : "▼ sell"} ${amt}${w >= 16 ? " add" : ""}`; col = C.info; }
  else if (a.includes("REDUCE")) { t = `${r.gap > 0 ? "▲ buy" : "▼ sell"} ${amt}${w >= 16 ? " trim" : ""}`; col = C.warn; }
  else if (a.includes("LOSS-STOP")) { t = "■ frozen: stop"; col = C.down; }
  else if (a.includes("HOLD") || hold) { t = r.current ? "═ hold, neutral" : "· flat, neutral"; col = C.mute; }
  else { t = "✓ on target"; col = C.mute; }
  return col(ell(t, w));
}
function bookBody(m, w) {
  if (!m.rows.length) return [m.s ? C.mute(m.s.error ? "no plan and no positions: the last cycle errored before sizing" : "flat, no plan yet") : C.mute("no bot state: start the bot to see holdings and targets")];
  const wide = w >= 108;
  const stopBy = Object.fromEntries((m.s?.stops ?? []).map((x) => [x.coin, x]));
  const W_ = { mk: 7, side: w >= 88 ? 6 : 0, hold: 9, tgt: 9, act: 17, pnl: 8, px: wide ? 19 : 0, stop: w >= 100 ? 10 : 0 };
  const fixed = W_.mk + (W_.side ? W_.side + 1 : 0) + W_.hold + W_.tgt + W_.act + W_.pnl + (W_.px ? W_.px + 1 : 0) + (W_.stop ? W_.stop + 1 : 0) + 5;
  const half = Math.max(4, Math.min(14, Math.floor((w - fixed - 1) / 2)));
  const gw = half * 2 + 1;
  const gh = `${C.mute("short")}${" ".repeat(Math.max(1, gw - 9))}${C.mute("long")}`;
  const hdr = [pad(C.mute("market"), W_.mk), pad(C.mute("side"), W_.side), pad(C.mute("holding"), W_.hold, true), pad(gh, gw), pad(C.mute("target"), W_.tgt, true), pad(C.mute("next action"), W_.act), pad(C.mute("uPnL"), W_.pnl, true)];
  if (!W_.side) hdr.splice(1, 1);
  if (W_.px) hdr.splice(1, 0, pad(C.mute("entry → mark"), W_.px));
  if (W_.stop) hdr.push(pad(C.mute("stop"), W_.stop, true));
  const out = [hdr.join(" ")];
  for (const r of m.rows) {
    const p = m.s.positions?.[r.coin], mid = m.s.mids?.[r.coin];
    const side = Math.abs(r.current) < 0.005 ? C.mute("flat") : r.current > 0 ? bold(C.up("LONG")) : bold(C.down("SHORT"));
    const cells = [
      pad(bold(C.fg(ell(bare(r.coin), W_.mk))), W_.mk), pad(side, W_.side),
      pad(sgnCol(r.current)(usd(r.current, { compact: true })), W_.hold, true),
      bookGauge(r.current, r.target, m.perCoin, half),
      pad(sgnCol(r.target)(usd(r.target, { compact: true })), W_.tgt, true),
      pad(actionLabel(r, m, W_.act), W_.act),
      pad(p ? sgnCol(p.upnl)(usd(p.upnl, { sign: true })) : C.mute("—"), W_.pnl, true),
    ];
    if (!W_.side) cells.splice(1, 1);
    if (W_.px) {
      const fmt = (v) => (v == null || !Number.isFinite(v) ? "—" : v >= 1000 ? Math.round(v).toLocaleString("en-US") : String(Number(v.toPrecision(5))));
      cells.splice(1, 0, pad(p ? `${C.soft(fmt(p.entryPx))} ${C.mute("→")} ${C.fg(fmt(mid))}` : C.mute("—"), W_.px));
    }
    if (W_.stop) {
      const st = stopBy[r.coin];
      const fmtS = (v) => (v >= 1000 ? Math.round(v).toLocaleString("en-US") : String(Number(v.toPrecision(5))));
      cells.push(pad(!st ? C.mute(Math.abs(r.current) > 0.005 ? "none" : "—") : st.armed ? C.up(`⤒${fmtS(st.stopPx)}`) : st.status === "resting" ? C.soft(fmtS(st.stopPx)) : C.warn(`${fmtS(st.stopPx)}?`), W_.stop, true));
    }
    out.push(cells.join(" "));
  }
  return out;
}
const bookRight = (m) => (m.perCoin ? `${C.mute("cap")} ${C.soft(usd(m.perCoin, { compact: true }))}${C.mute(`/market @ ${m.lev}x`)}${C.faint(" · ")}${C.fg("┃")}${C.mute(" target")}` : "");

// ── orders ("what happens next") ──────────────────────────────────────────────────────────
function ordersBody(m, w, max = 6) {
  const s = m.s, out = [];
  if (!s) return [C.mute("nothing planned: no bot state")];
  const orders = s.orders ?? [], fills = s.fills ?? [];
  const sent = !s.skip && !s.error && orders.length;
  if (s.error) out.push(C.down(ell(`last cycle errored, nothing planned: ${s.error}`, w)));
  else if (!orders.length) out.push(`${C.up("✓")} ${C.soft("book matches targets, nothing to send")}`);
  else {
    out.push(sent ? `${C.up("●")} ${bold(C.up("SENT"))} ${C.soft(ago(s.ts, m.now))}` : `${C.warn("○")} ${bold(C.warn("NOT SENT"))} ${C.soft(s.skip)}`);
    const shown = orders.slice(0, max - 1);
    for (const o of shown) {
      const f = fills.find((x) => x.coin === o.coin && x.tag === o.tag);
      const res = !f ? "" : f.error ? C.down(` ✗ ${f.error}`) : f.filled ? C.up(` ✓ filled ${f.filled} @ ${f.avgPx}`) : C.mute(" not filled");
      const tight = w < 70;
      const line = `  ${o.isBuy ? bold(C.up("BUY ")) : bold(C.down("SELL"))} ${bold(C.fg(pad(bare(o.coin), tight ? 5 : 6)))} ${pad(C.fg(String(o.sz)), tight ? 7 : 9, true)} ${C.mute("@")} ${pad(C.fg(String(o.px)), tight ? 8 : 9)} ${C.mute("≈")}${pad(C.fg(usd(o.ntl)), tight ? 8 : 9)} ${C.info(o.tag)}${o.reduceOnly ? C.mute(tight ? " r/o" : " reduce-only") : ""}`;
      if (width(line + res) <= w) out.push(line + res);
      else { out.push(line); if (res) out.push(`       ${res.trimStart()}`); }
    }
    if (orders.length > shown.length) out.push(C.mute(`  … ${orders.length - shown.length} more`));
  }
  const when = m.nextMs != null ? `${C.mute("re-plans with fresh scores in")} ${bold(C.info(clock(m.nextMs)))}${m.ctl.live && !m.ctl.paused ? C.down(" and sends live") : C.mute(m.ctl.paused ? ", paused: won't send" : ", dry-run: won't send")}` : C.mute(m.state === "nostate" || m.state === "stopped" ? "no cycle scheduled: the bot is not running" : "");
  if (when) out.push(when);
  const hint = s.error ? "" : /dry-run/.test(s.skip ?? "") ? `${keycap("l")} ${C.mute("go live to send planned orders")}` : /paused/.test(s.skip ?? "") ? `${keycap("p")} ${C.mute("resume to send")}` : "";
  if (hint && orders.length) out.push(hint);
  return out;
}

// ── activity ────────────────────────────────────────────────────────────────────────────
function eventLine(e, w, now, rel) {
  const msg = e.msg ?? "";
  let icon, col, text = msg;
  switch (e.kind) {
    case "fill": { const bad = e.error || /ERROR|not filled/.test(msg); icon = bad ? "✗" : "✓"; col = bad ? C.down : C.up; break; }
    case "cycle": {
      icon = "↻"; const mm = /^cycle: equity \$([\d.,]+), (\d+) order\(s\)(?:, (sent)|, not sent: (.*))?$/.exec(msg);
      if (mm) { const n = Number(mm[2]); text = `cycle  $${mm[1]} · ${n} order${n === 1 ? "" : "s"}${mm[3] ? " · sent" : mm[4] ? ` · ${mm[4]}` : ""}`; }
      col = mm?.[3] ? C.up : /no orders needed/.test(msg) ? C.mute : C.soft; break;
    }
    case "error": icon = "✗"; col = C.down; break;
    case "control": icon = "⚑"; col = C.warn; break;
    case "start": icon = "▶"; col = C.info; break;
    case "stop": icon = "■"; col = C.info; break;
    default: icon = "•"; col = C.fg;
  }
  const t = C.mute(hms(e.ts));
  const tail = rel ? C.faint(ago(e.ts, now)) : "";
  const body = `${t} ${col(icon)} ${col(ell(text, w - 11 - (rel ? width(tail) + 2 : 0)))}`;
  return rel ? pad(body, w - width(tail)) + tail : body;
}
const activityBody = (m, w, n, rel) => (m.events.length ? m.events.slice(-n).reverse().map((e) => eventLine(e, w, m.now, rel)) : [C.mute("no events yet")]);

// ── safety panel (wide) ───────────────────────────────────────────────────────────────────
function safetyBody(m, w) {
  const lw = 16, mw = Math.max(8, Math.min(24, Math.floor(w * 0.28)));
  const row = (label, bar, txt) => `${pad(C.mute(label), lw)}${bar} ${txt}`;
  const out = [];
  if (m.s?.killed) out.push(row("daily loss stop", meter(1, mw, PAL.down), bold(C.down("HIT: adds & flips blocked"))));
  else if (m.roomFrac != null) { const col = m.roomFrac > 0.6 ? PAL.up : m.roomFrac > 0.3 ? PAL.warn : PAL.down; out.push(row("daily loss stop", meter(m.roomFrac, mw, col), `${fg(col)(usd(m.room))} ${C.mute(`room · stops at ${usd(m.stopAt)} (−${Math.round(m.killPct * 100)}% of ${usd(m.dayStart)})`)}`)); }
  if (m.cap) out.push(row("gross exposure", meter(m.gross / m.cap, mw, PAL.accent), `${C.fg(usd(m.gross))} ${C.mute(`of ${usd(m.cap)} max · ${m.levUsed.toFixed(2)}x of ${m.lev}x`)}`));
  if (m.gross > 0) out.push(row("long │ short", splitBar(m.long, m.short, mw), `${C.up(usd(m.long))} ${C.mute("│")} ${C.down(usd(m.short))} ${C.mute("· net")} ${sgnCol(m.net)(usd(m.net, { sign: true }))}`));
  if (m.sigAge != null) { const col = m.sigAge > m.maxAge ? PAL.down : m.sigAge > 120 ? PAL.warn : PAL.up; out.push(row("signal age", meter(m.sigAge / m.maxAge, mw, col), `${fg(col)(dur(m.sigAge))} ${C.mute(`· bot skips when older than ${dur(m.maxAge)}`)}`)); }
  const stops = m.s?.stops ?? [], held = m.rows.filter((r) => Math.abs(r.current) > 0.005).length;
  if (m.s) {
    const rest = stops.filter((x) => x.status === "resting").length, trail = stops.filter((x) => x.armed).map((x) => bare(x.coin));
    const blocks = Object.keys(m.s.blocks ?? {}).map(bare);
    const sl = Math.round((m.c.stops?.stopLossPct ?? 0.08) * 100);
    const ok = held === 0 || rest >= held;
    out.push(`${pad(C.mute("stop-losses"), lw)}${ok ? C.up("✓") : C.warn("!")} ${C.soft(m.c.stops?.enabled === false ? "disabled" : `${rest}/${held} resting on exchange · ${sl}% hard`)}${trail.length ? C.up(` · trailing ${trail.join(" ")}`) : ""}${blocks.length ? C.down(` · blocked ${blocks.join(" ")}`) : ""}`);
  }
  const tick = (ok) => (ok ? C.up("✓") : C.down("✗"));
  const days = m.s?.agentValidUntil ? Math.floor((m.s.agentValidUntil - m.now) / 86400000) : null;
  if (m.s) {
    out.push(`${pad(C.mute("api wallet"), lw)}${tick(days > 0)} ${C.soft(days != null ? `valid ${days}d` : "not authorized")} ${C.mute(`· ${short(m.s.agent)}`)}`);
    out.push(`${pad(C.mute("builder fee"), lw)}${tick(m.s.builderFeeOk)} ${C.soft(m.s.builderFeeOk ? "approved" : "not approved")} ${C.mute(`· account ${m.s.mode ?? "—"}`)}`);
    const spot = (m.s.spot ?? []).filter((b) => b.coin !== "USDC");
    if (spot.length) out.push(`${pad(C.mute("spot (ignored)"), lw)}${C.info("•")} ${C.soft(spot.map((b) => `${b.total} ${b.coin}`).join(", "))} ${C.mute("· not counted as perps equity")}`);
  }
  return out;
}

// ── borrowed panels ─────────────────────────────────────────────────────────────────────────
/** Mood scale strip under the header: where the traded book's average mood sits on −100…+100. */
function scaleStrip(m, W) {
  const lbl = m.avgMood == null ? C.mute(" book mood —") : ` ${C.mute("book mood")} ${bold(moodPaint(m.avgMood)(signed(Math.round(m.avgMood))))} `;
  return " " + moodScale(m.avgMood, W - 2 - width(lbl)) + lbl;
}

/** Average of the traded markets' 24h histories, resampled to n points. */
function bookSeries(m, n) {
  const hs = m.traded.map((x) => x.history ?? []).filter((h) => h.length >= 2);
  if (!hs.length) return null;
  return Array.from({ length: n }, (_, i) => {
    let s = 0;
    for (const h of hs) s += h[Math.min(h.length - 1, Math.floor((i * h.length) / n))];
    return s / hs.length;
  });
}
/** 24h book-mood braille chart with a small axis (idea from the Grok design). */
function chartBody(m, w, rows) {
  const axisW = 5, cols = Math.max(4, w - axisW);
  const series = bookSeries(m, cols * 2);
  if (!series) return [C.mute(m.sig ? "no 24h history in the signal yet" : "loading the mood ring…")];
  let lo = Math.min(...series), hi = Math.max(...series);
  if (hi - lo < 8) { const mid = (hi + lo) / 2; lo = mid - 4; hi = mid + 4; }
  const padv = (hi - lo) * 0.1; lo -= padv; hi += padv;
  const plot = brailleChart(series, cols, rows, lo, hi);
  const lab = (v) => moodPaint(v)(pad(signed(Math.round(v)), 4, true));
  return plot.map((p, r) => `${r === 0 ? lab(hi) : r === rows - 1 ? lab(lo) : "    "}${C.faint("┤")}${p}`);
}
const chartRight = (m) => {
  const s = bookSeries(m, 48);
  if (!s) return "";
  return `${C.mute("24h")} ${moodPaint(Math.min(...s))(signed(Math.round(Math.min(...s))))}${C.mute("…")}${moodPaint(Math.max(...s))(signed(Math.round(Math.max(...s))))} ${C.faint("·")} ${C.mute("now")} ${moodPaint(m.avgMood)(signed(Math.round(m.avgMood ?? 0)))}`;
};

/** Share of gross exposure per market (idea from the DeepSeek design). */
function exposureBody(m, w) {
  const held = m.rows.filter((r) => Math.abs(r.current) > 0.005).sort((a, b) => Math.abs(b.current) - Math.abs(a.current));
  if (!held.length || !(m.gross > 0)) return [C.mute("no open positions")];
  const nameW = 8, sideW = 6, tail = 22, bw = Math.max(6, w - nameW - sideW - tail - 3);
  return held.map((r) => {
    const share = Math.abs(r.current) / m.gross, col = r.current > 0 ? PAL.up : PAL.down;
    const p = m.s?.positions?.[r.coin];
    return `${pad(bold(C.fg(bare(r.coin))), nameW)}${pad(r.current > 0 ? C.up("LONG") : C.down("SHORT"), sideW)} ${meter(share, bw, col)} ${pad(C.fg(`${Math.round(share * 100)}%`), 4, true)} ${pad(sgnCol(r.current)(usd(r.current, { compact: true })), 8, true)} ${pad(p ? sgnCol(p.upnl)(usd(p.upnl, { sign: true })) : "", 8, true)}`;
  });
}

// ── footer ────────────────────────────────────────────────────────────────────────────────
function footer(m, W, ui) {
  if (ui.prompt) {
    const live = /LIVE/.test(ui.prompt);
    const tc = fg(live ? [255, 255, 255] : PAL.ink);
    const txt = ` ${tc(bold(`${live ? "▲" : "!"} ${ui.prompt}`))}   ${keycap("y")} ${tc(bold("confirm"))}   ${tc("any other key cancels")}`;
    return colorMode() === "none" ? fit(txt, W) : band(txt, W, live ? [190, 18, 60] : PAL.warn);
  }
  const keys = [["p", m.ctl.paused ? "resume" : "pause"], ["l", m.ctl.live ? "go dry-run" : "go LIVE"], ["r", "run now"], ["f", "flatten"], ["q", "quit"]];
  const k = " " + keys.map(([key, d]) => `${keycap(key)} ${key === "l" && !m.ctl.live ? C.soft(d) : C.mute(d)}`).join("  ");
  const right = ui.flash ? ` ${ui.flash} ` : ` ${C.faint(hms(m.now))} `;
  if (width(k) + width(right) > W) return ui.flash ? fit(right, W) : fit(k, W);
  return pad(k, W - width(right)) + right;
}

// ── layouts ───────────────────────────────────────────────────────────────────────────────
function compact(m, W, H, ui) {
  const tint = m.ctl.live ? C.liveFrame : C.frame;
  const top = [header(m, W, ui), ...(H >= 28 ? [scaleStrip(m, W)] : []), ribbon(m, W), kpiLine(m, W)];
  const foot = [footer(m, W, ui)];
  // Combined table: crowd score + 24h spark │ holding → target, next action.
  const byCoin = Object.fromEntries(m.rows.map((r) => [r.coin, r]));
  const actW = W >= 96 ? 17 : 14, valW = 8;
  const fixed = 1 + 8 + 4 + 1 + 1 + 1 + valW + 1 + valW + 1 + actW + 1;
  const free = Math.max(10, W - fixed);
  const half = Math.max(4, Math.min(10, Math.floor((free * 0.45) / 2)));
  const sw = Math.max(0, free - (half * 2 + 1) - 1);
  const mk = m.traded.map((x) => {
    const r = byCoin[x.coin] ?? m.rows.find((rr) => bare(rr.coin) === x.coin);
    const book = r ? `${pad(sgnCol(r.current)(usd(r.current, { compact: true })), valW, true)}${C.mute("→")}${pad(sgnCol(r.target)(usd(r.target, { compact: true })), valW, true)} ${pad(actionLabel(r, m, actW), actW)}` : C.mute(pad(m.s ? "not in last plan" : "—", valW * 2 + actW + 2));
    return ` ${pad(nameCell(x, 8, false), 8)}${scoreCell(x)} ${moodBar(x.score, half)} ${spark(x.history, sw)} ${book}`;
  });
  const markets = [rule("MARKETS", W, `${C.mute("crowd · 24h")} ${C.faint("│")} ${C.mute("holding → target · next")}`, tint), ...mk];
  if (!m.coins.length) markets.push(" " + (m.signalErr ? C.down(ell(`signal unavailable: ${m.signalErr}`, W - 2)) : C.mute("loading the mood ring…")));
  const watch = m.watched.length ? [" " + watchLine(m, W - 2)] : [];
  let orders = ordersBody(m, W - 2, 3).map((l) => " " + l);
  const next = () => [rule("NEXT", W, "", tint), ...orders];
  let used = top.length + foot.length + markets.length + watch.length + next().length;
  if (used > H && watch.length) { watch.length = 0; used--; }
  while (used > H && orders.length > 1) { orders.pop(); used--; }
  const body = [...top, ...markets, ...watch, ...next()];
  const room = H - body.length - foot.length;
  if (room >= 2) body.push(rule("ACTIVITY", W, "", tint), ...activityBody(m, W - 2, room - 1, false).map((l) => " " + l));
  return finish(body, foot, H);
}

function stacked(m, W, H, ui) {
  const tint = m.ctl.live ? C.liveFrame : C.frame;
  const top = [header(m, W, ui), scaleStrip(m, W), ribbon(m, W), ...tiles(m, W, tint)];
  const foot = [footer(m, W, ui)];
  const inner = W - 4;
  let opts = { sep: true, collapse: false };
  let mood = moodBody(m, inner, opts);
  const book = bookBody(m, inner);
  const ow = Math.floor((W - 1) * 0.5), aw = W - ow - 1;
  const orders = ordersBody(m, ow - 4, 5);
  // Keep at least 4 activity rows; shed the watch-list detail before that.
  const need = () => top.length + foot.length + (mood.length + 2) + (book.length + 2) + Math.max(orders.length + 2, 6);
  if (need() > H) mood = moodBody(m, inner, (opts = { sep: false }));
  if (need() > H) mood = moodBody(m, inner, (opts = { collapse: true }));
  const body = [...top, ...panel({ title: "MOOD RING", right: moodRight(m), w: W, body: mood, tint }), ...panel({ title: "BOOK", right: bookRight(m), w: W, body: book, tint })];
  const room = H - body.length - foot.length;
  if (room >= 3) {
    const op = panel({ title: "NEXT ORDERS", right: m.s?.ts ? C.mute(`planned ${ago(m.s.ts, m.now)}`) : "", w: ow, body: orders, h: room, tint });
    const ap = panel({ title: "ACTIVITY", right: C.mute("newest first"), w: aw, body: activityBody(m, aw - 4, room - 2, aw >= 70), h: room, tint });
    body.push(...hjoin([{ lines: op, w: ow }, { lines: ap, w: aw }], 1));
  }
  return finish(body, foot, H);
}

function wide(m, W, H, ui) {
  const tint = m.ctl.live ? C.liveFrame : C.frame;
  const top = [header(m, W, ui), scaleStrip(m, W), ribbon(m, W), ...tiles(m, W, tint)];
  const foot = [footer(m, W, ui)];
  const colH = H - top.length - foot.length;
  const lw = Math.floor((W - 1) * 0.52), rw = W - lw - 1;
  // Left: crowd. Tall two-row sparklines when the height allows, then the 24h book-mood chart
  // and the safety panel underneath, each only if it fits.
  const safety = safetyBody(m, lw - 4), safetyH = safety.length + 2;
  const tall = moodBody(m, lw - 4, { tall: true }), normal = moodBody(m, lw - 4, {});
  const CHART_ROWS = 4, chartH = CHART_ROWS + 2;
  const chartP = () => panel({ title: "24H BOOK MOOD", right: chartRight(m), w: lw, body: chartBody(m, lw - 4, CHART_ROWS), tint });
  let left;
  const moodP = (b, h) => panel({ title: "MOOD RING", right: moodRight(m), w: lw, body: b, h, tint });
  const withExtras = (mood) => {
    const out = [...moodP(mood)];
    if (out.length + chartH + safetyH <= colH) out.push(...chartP());
    out.push(...panel({ title: "RISK & SAFETY", w: lw, body: safety, h: colH - out.length, tint }));
    return out;
  };
  const fits = (mood, chart) => mood.length + 2 + (chart ? chartH : 0) + safetyH <= colH;
  const pick = [[tall, true], [normal, true], [tall, false], [normal, false]].find(([mood, chart]) => fits(mood, chart));
  if (pick) left = withExtras(pick[0]);
  else left = moodP(normal.length + 2 <= colH ? normal : moodBody(m, lw - 4, { collapse: true }), colH);
  // Right: book, orders, exposure map (if it leaves room for activity), activity (stretches).
  const book = panel({ title: "BOOK", right: bookRight(m), w: rw, body: bookBody(m, rw - 4), tint });
  const ob = ordersBody(m, rw - 4, 6);
  const orders = panel({ title: "NEXT ORDERS", right: m.s?.ts ? C.mute(`planned ${ago(m.s.ts, m.now)}`) : "", w: rw, body: ob, tint });
  const right = [...book, ...orders];
  const exp = exposureBody(m, rw - 4);
  if (m.gross > 0 && colH - right.length - (exp.length + 2) >= 6) right.push(...panel({ title: "EXPOSURE", right: `${C.mute("gross")} ${C.soft(usd(m.gross))} ${C.faint("·")} ${C.mute("net")} ${sgnCol(m.net)(usd(m.net, { sign: true }))}`, w: rw, body: exp, tint }));
  const room = colH - right.length;
  if (room >= 3) right.push(...panel({ title: "ACTIVITY", right: C.mute("newest first"), w: rw, body: activityBody(m, rw - 4, room - 2, true), h: room, tint }));
  const cols = hjoin([{ lines: left.slice(0, colH), w: lw }, { lines: right.slice(0, colH), w: rw }], 1);
  return finish([...top, ...cols], foot, H);
}

function finish(body, foot, H) {
  const b = body.slice(0, Math.max(0, H - foot.length));
  while (b.length < H - foot.length) b.push("");
  return [...b, ...foot];
}

/** Compose one frame. */
export function draw(input, { W, H, ui }) {
  const m = model(input);
  const lines = W < 110 || H < 30 ? compact(m, W, H, ui) : W < 170 ? stacked(m, W, H, ui) : wide(m, W, H, ui);
  return lines.slice(0, H).map((l) => clip(l, W) + reset());
}
