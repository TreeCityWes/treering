// Replay of recorded cycle history (data/history/*.jsonl) under different settings. Pure: no
// network, no files, never touches the exchange. It reuses the live decision code (targetRows,
// buildOrders, stopPlan, releaseReason), so a replay with the recorded settings makes the same
// choices the bot made, to the limit of what one reading every cycle can show.
//
// What it models: sizing, deadband, flip hysteresis, small-rebalance filter, minimum order size,
// the daily loss stop, the drawdown pause, hard and trailing stops, and re-entry blocks.
// What it does not: funding (a few cents a week at this size), partial fills, order rejections,
// and operator actions. Stops trigger on trade prices when 1-minute candles are supplied, and on
// the cycle's mid price otherwise; the exchange triggers on mark price, which can differ a little.
import { DEADBAND, DEFAULT_CONFIG } from "./config.js";
import { targetRows, buildOrders } from "./strategy.js";
import { stopPlan, releaseReason } from "./stops.js";

// Size decimals for the markets the bot trades (Hyperliquid meta). Others fall back to a guess
// from the price, which only affects rounding.
const SZ_DECIMALS = { BTC: 5, ETH: 4, SOL: 2, HYPE: 2, ZEC: 2, NEAR: 1, XRP: 0 };
const szDecimals = (coin, px) => SZ_DECIMALS[coin] ?? (px >= 10000 ? 5 : px >= 1000 ? 4 : px >= 100 ? 3 : px >= 10 ? 2 : px >= 1 ? 1 : 0);

export const SIM_DEFAULTS = {
  feeRate: 0.00045,        // Hyperliquid taker fee
  builderRate: 0.0005,     // X1 builder fee (applied when cfg.builderFee)
  fillSlipBps: 0.5,        // IOC fills vs mid; recorded fills average about 0.2 bps
  stopSlipBps: 15,         // stop-market fill vs trigger price
  smoothHours: null,       // average each coin's score over this many trailing hours (0 = raw; null = cfg.smoothHours)
  decideEverySec: 0,       // only make trading decisions this often (0 = every recorded cycle)
  reentryBlock: true,      // false = never block a coin after its stop fills
  stopsByCoin: {},         // per-coin overrides of cfg.stops, e.g. { ZEC: { trailPct: 0.08 } }
  recordedCfg: false,      // true = use the settings stored in each record (to check the model)
};

/** Merge a variant's settings over the base bot config. */
export function variantConfig(base, v = {}) {
  return { ...DEFAULT_CONFIG, ...base, ...(v.cfg ?? {}), stops: { ...DEFAULT_CONFIG.stops, ...(base?.stops ?? {}), ...(v.cfg?.stops ?? {}) }, rebalance: { ...DEFAULT_CONFIG.rebalance, ...(base?.rebalance ?? {}), ...(v.cfg?.rebalance ?? {}) } };
}

/**
 * Position bookkeeping: apply a signed size change at a price. Returns the realized P&L of the
 * part that closed. Average entry on adds; entry unchanged on reductions; a cross through zero
 * closes the old position and opens the remainder at the fill price.
 */
export function applyFill(pos, dSz, px) {
  const szi = pos?.szi ?? 0, entry = pos?.entryPx ?? px;
  if (szi === 0 || Math.sign(szi) === Math.sign(dSz)) {
    const next = szi + dSz;
    return { pos: { szi: next, entryPx: (Math.abs(szi) * entry + Math.abs(dSz) * px) / Math.abs(next) }, realized: 0 };
  }
  const closed = Math.min(Math.abs(dSz), Math.abs(szi));
  const realized = closed * (px - entry) * Math.sign(szi);
  const next = szi + dSz;
  if (Math.abs(next) < 1e-12) return { pos: null, realized };
  return { pos: { szi: next, entryPx: Math.sign(next) === Math.sign(szi) ? entry : px }, realized };
}

/** Lowest and highest trade price per coin in (from, to], from 1-minute candles {t, h, l}. */
function rangeBetween(candles, from, to) {
  if (!candles) return null;
  let lo = Infinity, hi = -Infinity;
  // Candles are sorted by open time; a candle counts when it opened at or after `from` (rounded
  // down to its minute) and before `to`.
  let a = 0, b = candles.length;
  const start = from - 60_000;
  while (a < b) { const m = (a + b) >> 1; if (candles[m].t <= start) a = m + 1; else b = m; }
  for (let i = a; i < candles.length && candles[i].t < to; i++) { if (candles[i].l < lo) lo = candles[i].l; if (candles[i].h > hi) hi = candles[i].h; }
  return hi === -Infinity ? null : { lo, hi };
}

/**
 * Run one variant over the records. `records` are history lines in time order; `candles` is an
 * optional { coin: [{t, h, l}] } map of 1-minute bars for intra-cycle stop triggers.
 * Returns totals, a per-coin breakdown and the equity curve.
 */
export function simulate(records, variant = {}, candles = null) {
  const opt = { ...SIM_DEFAULTS, ...(variant.sim ?? {}) };
  const recs = records.filter((r) => r.mids && r.equity > 0);
  if (!recs.length) throw new Error("no usable history records");
  const latestCfg = [...recs].reverse().find((r) => r.cfg)?.cfg ?? {};
  let cfg = variantConfig(latestCfg, variant);
  const first = recs[0];
  const coinsAll = new Set(cfg.markets);

  // Start from the recorded book: positions, trail state and re-entry blocks at the first record.
  const pos = {}, book = { trail: {}, blocks: {} };
  for (const [c, p] of Object.entries(first.positions ?? {})) if (coinsAll.has(c)) pos[c] = { szi: p.szi, entryPx: p.entryPx };
  for (const s of first.stops ?? []) if (pos[s.coin]) book.trail[s.coin] = { side: s.side, entry: s.entry, best: s.best ?? s.entry, armed: !!s.armed, stopPx: s.stopPx };
  for (const [c, b] of Object.entries(first.blocks ?? {})) if (coinsAll.has(c) && opt.reentryBlock) book.blocks[c] = { ...b };
  const upnlAt = (mids) => Object.entries(pos).reduce((n, [c, p]) => n + (mids[c] > 0 ? p.szi * (mids[c] - p.entryPx) : 0), 0);
  let cash = first.equity - upnlAt(first.mids);

  const per = {}; // per coin: realized, fees, volume, trades, stopOuts
  const stat = (c) => (per[c] ??= { realized: 0, fees: 0, volume: 0, trades: 0, stopOuts: 0, open: 0 });
  const fill = (c, dSz, px) => {
    const { pos: next, realized } = applyFill(pos[c], dSz, px);
    const ntl = Math.abs(dSz) * px, fee = ntl * (opt.feeRate + (cfg.builderFee ? opt.builderRate : 0));
    if (next) pos[c] = next; else delete pos[c];
    cash += realized - fee;
    const s = stat(c); s.realized += realized; s.fees += fee; s.volume += ntl; s.trades++;
  };
  const stopsFor = (c) => ({ ...cfg.stops, ...(opt.stopsByCoin[c] ?? {}) });

  const scores = {}; // coin -> [{ts, score}] for smoothing
  const curve = [];
  let prevTs = first.ts, day = null, dayStart = 0, peak = first.peakEquity ?? first.equity, paused = false, pausedAt = null, lastDecision = -Infinity;
  let maxDd = 0, runPeak = first.equity, killedCycles = 0;

  for (const r of recs) {
    // Settings that did not exist yet when a record was written were off, not at today's default.
    // Resizing was on before rebalance.resize existed (Nov 13), so records without it resized.
    if (opt.recordedCfg && r.cfg) cfg = variantConfig({ flipMinScore: 0, maxDrawdownPct: 0, smoothHours: 0, ...r.cfg, rebalance: { resize: true, ...(r.cfg.rebalance ?? {}) } }, variant);
    const mids = r.mids;

    // 1. Stops resting on the exchange since the previous cycle.
    if (cfg.stops.enabled && r !== first) for (const [c, t] of Object.entries(book.trail)) {
      const p = pos[c];
      if (!p || !(t.stopPx > 0)) continue;
      const range = rangeBetween(candles?.[c], prevTs, r.ts) ?? (mids[c] > 0 ? { lo: mids[c], hi: mids[c] } : null);
      if (!range) continue;
      const hit = t.side > 0 ? range.lo <= t.stopPx : range.hi >= t.stopPx;
      if (!hit) continue;
      const slip = opt.stopSlipBps / 1e4;
      // Without candles the trigger is only seen at the cycle, so a gap through the stop fills at the mid.
      const base = candles?.[c] ? t.stopPx : t.side > 0 ? Math.min(t.stopPx, mids[c]) : Math.max(t.stopPx, mids[c]);
      fill(c, -p.szi, t.side > 0 ? base * (1 - slip) : base * (1 + slip));
      stat(c).stopOuts++;
      delete book.trail[c];
      if (opt.reentryBlock) {
        const score = (r.signal ?? []).find((s) => s.coin === c)?.score ?? null;
        book.blocks[c] = { side: t.side, weight: (score ?? t.side * DEADBAND) / 100, at: r.ts };
      }
    }

    // 2. The reading the bot acts on (optionally smoothed).
    const fresh = Array.isArray(r.signal) && r.signalTs && (r.ts - r.signalTs) / 1000 <= cfg.maxSignalAgeSec;
    let coins = [];
    if (Array.isArray(r.signal)) {
      for (const s of r.signal) if (Number.isFinite(s.score)) (scores[s.coin] ??= []).push({ ts: r.ts, score: s.score });
      coins = r.signal.map((s) => {
        const hours = opt.smoothHours ?? cfg.smoothHours ?? 0;
        if (!(hours > 0) || !Number.isFinite(s.score)) return { coin: s.coin, score: s.score };
        const h = scores[s.coin], from = r.ts - hours * 3.6e6;
        while (h.length && h[0].ts < from) h.shift();
        return { coin: s.coin, score: h.reduce((n, x) => n + x.score, 0) / h.length };
      });
    }
    if (Array.isArray(r.signal)) for (const [c, b] of Object.entries(book.blocks)) {
      if (releaseReason(b, coins.find((s) => s.coin === c)?.score ?? null, stopsFor(c))) delete book.blocks[c];
    }

    // 3. Equity, daily loss stop, drawdown pause.
    const equity = cash + upnlAt(mids);
    const d = new Date(r.ts).toISOString().slice(0, 10);
    if (d !== day) { day = d; dayStart = equity; }
    const killed = dayStart > 0 && equity - dayStart <= -cfg.killPct * dayStart;
    if (killed) killedCycles++;
    peak = Math.max(peak, equity);
    if (cfg.maxDrawdownPct > 0 && !paused && 1 - equity / peak >= cfg.maxDrawdownPct) { paused = true; pausedAt = r.ts; }
    runPeak = Math.max(runPeak, equity); maxDd = Math.max(maxDd, 1 - equity / runPeak);

    // 4. Decide and trade, exactly as a live cycle would.
    const due = r.ts - lastDecision >= opt.decideEverySec * 1000 - 30_000;
    if (fresh && !paused && r.live !== false && r.paused !== true && due && equity >= 15) {
      lastDecision = r.ts;
      const current = Object.fromEntries(cfg.markets.map((c) => [c, pos[c] && mids[c] > 0 ? pos[c].szi * mids[c] : 0]));
      const rows = targetRows({ equity, cfg, signal: { coins }, current, killed });
      for (const row of rows) if (book.blocks[row.coin]) Object.assign(row, { target: row.current, gap: 0, actions: ["BLOCKED"] });
      const markets = Object.fromEntries(cfg.markets.filter((c) => mids[c] > 0).map((c) => [c, { asset: 0, szDecimals: szDecimals(c, mids[c]) }]));
      const orders = buildOrders(rows, { markets, mids, positions: pos, slippage: cfg.slippage, minOrderUsd: cfg.minOrderUsd });
      const slip = opt.fillSlipBps / 1e4;
      for (const o of orders) {
        let sz = Number(o.sz);
        if (o.reduceOnly) sz = Math.min(sz, Math.abs(pos[o.coin]?.szi ?? 0));
        if (sz > 0) fill(o.coin, o.isBuy ? sz : -sz, mids[o.coin] * (o.isBuy ? 1 + slip : 1 - slip));
      }
    }

    // 5. Stop upkeep: one stop per open position, tightened by the trail.
    if (cfg.stops.enabled) {
      for (const [c, p] of Object.entries(pos)) if (mids[c] > 0) book.trail[c] = stopPlan({ side: Math.sign(p.szi), entry: p.entryPx }, mids[c], book.trail[c], stopsFor(c));
      for (const c of Object.keys(book.trail)) if (!pos[c]) delete book.trail[c];
    } else book.trail = {};

    curve.push({ ts: r.ts, equity: cash + upnlAt(mids), actual: r.equity });
    prevTs = r.ts;
  }

  const last = recs.at(-1);
  for (const [c, p] of Object.entries(pos)) stat(c).open = last.mids[c] > 0 ? p.szi * (last.mids[c] - p.entryPx) : 0;
  const startOpen = Object.entries(first.positions ?? {}).reduce((m, [c, p]) => (coinsAll.has(c) ? { ...m, [c]: p.szi * (first.mids[c] - p.entryPx) } : m), {});
  const coins = Object.fromEntries(Object.entries(per).map(([c, s]) => [c, { ...s, net: s.realized - s.fees + s.open - (startOpen[c] ?? 0) }]));
  for (const c of Object.keys(startOpen)) coins[c] ??= { realized: 0, fees: 0, volume: 0, trades: 0, stopOuts: 0, open: 0, net: -startOpen[c] };
  const sum = (k) => Object.values(coins).reduce((n, s) => n + s[k], 0);
  const end = curve.at(-1).equity, mid = curve[Math.floor(curve.length / 2)];
  return {
    name: variant.name ?? "variant", from: first.ts, to: last.ts, cycles: recs.length,
    startEquity: first.equity, endEquity: end, pnl: end - first.equity, actualPnl: last.equity - first.equity,
    firstHalf: mid.equity - first.equity, secondHalf: end - mid.equity,
    fees: sum("fees"), volume: sum("volume"), trades: sum("trades"), stopOuts: sum("stopOuts"),
    maxDrawdown: maxDd, killedCycles, pausedAt, coins, curve,
  };
}
