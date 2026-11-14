// Paper scoreboard: next to live trading, track what a few alternative rule sets would hold, marked
// to the same prices every cycle, so rule changes can be judged on forward results instead of
// replays. Pure bookkeeping: nothing here touches the exchange or fails a cycle.
//
// Each variant starts from the live account (its equity, positions and stop state) at the moment
// the scoreboard begins, then trades on its own. It reuses the live sizing code (targetRows) and
// stop logic (stopPlan, releaseReason). Simplifications, all small at this size:
//   - fills at the cycle's mid price plus fees (0.045% Hyperliquid + 0.05% X1 builder); no slippage,
//     no funding. Sizes are rounded as real orders are (size step, $10 minimum) when the markets'
//     size decimals are passed in;
//   - stops trigger on the lowest/highest trade price since the previous cycle when 1-minute
//     ranges are passed in (as the exchange triggers between cycles), else on the cycle's mid,
//     and fill at the stop price;
//   - no daily loss stop or drawdown pause.
// "current rules" is a paper twin of the live bot: the gap between it and the real account is the
// model's error, and tells how far to trust the other rows.
import { targetRows, findScore, orderSize } from "./strategy.js";
import { stopPlan, releaseReason } from "./stops.js";
import { DEADBAND } from "./config.js";

export const PAPER_FEE = 0.00095;

export const PAPER_VARIANTS = [
  { id: "live", label: "current rules (paper twin)" },
  { id: "old", label: "old rules: leverage 3, resizing", cfg: { leverage: 3, rebalance: { resize: true } } },
  { id: "smooth6h", label: "score smoothed over 6h", smoothHours: 6 },
  { id: "lev1", label: "leverage 1", cfg: { leverage: 1 } },
  { id: "fade", label: "against the signal", invert: true, flatStart: true },
];

export function variantCfg(base, v) {
  return { ...base, ...(v.cfg ?? {}), rebalance: { ...base.rebalance, ...(v.cfg?.rebalance ?? {}) }, stops: { ...base.stops, ...(v.cfg?.stops ?? {}) } };
}

function freshVariant(v, { equity, positions, mids, trail, scores }) {
  const pos = {}, tr = {};
  if (!v.flatStart) for (const [c, p] of Object.entries(positions ?? {})) {
    if (!p?.szi || !(mids[c] > 0)) continue;
    pos[c] = { szi: p.szi, entry: p.entryPx ?? mids[c] };
    if (trail?.[c] && trail[c].side === Math.sign(p.szi)) tr[c] = { ...trail[c] };
  }
  const ema = {};
  for (const [c, s] of Object.entries(scores ?? {})) if (s != null) ema[c] = v.invert ? -s : s;
  return { equity, peak: equity, maxDD: 0, fees: 0, volume: 0, trades: 0, stopsHit: 0, pos, trail: tr, blocks: {}, ema, last: { ...ema } };
}

/** Start a scoreboard from the live account. positions: {coin: {szi, entryPx}}; trail: the live stop book's trail. */
export function initPaper({ ts, equity, positions, mids, trail, scores, variants = PAPER_VARIANTS }) {
  const ctx = { equity, positions, mids, trail, scores };
  return { v: 1, startTs: ts, startEquity: equity, lastTs: ts, mids: { ...mids }, variants: Object.fromEntries(variants.map((v) => [v.id, freshVariant(v, ctx)])) };
}

function fill(s, dSz, px) {
  const n = Math.abs(dSz * px);
  s.fees += n * PAPER_FEE; s.equity -= n * PAPER_FEE; s.volume += n; s.trades++;
}

/**
 * Advance every variant by one cycle. scores: {coin: score|null} from a fresh signal, or null when
 * there is none (then positions are only marked to market and checked against their stops).
 * equity/positions/trail are the live account's, used only to start a variant added later.
 * markets: {coin: {szDecimals}} to round sizes like real orders. ranges: {coin: {lo, hi}}, the
 * trade-price range since the previous cycle (from 1-minute candles), for stop triggers.
 */
export function stepPaper(paper, { ts, mids, scores, cfg, equity, positions, trail, markets = null, ranges = null, variants = PAPER_VARIANTS }) {
  const dt = Math.max(0, ts - paper.lastTs);
  for (const v of variants) {
    if (!paper.variants[v.id]) { paper.variants[v.id] = freshVariant(v, { equity, positions, mids, trail, scores }); continue; }
    const s = paper.variants[v.id], vc = variantCfg(cfg, v), sc = vc.stops;
    // 1. Mark to market.
    for (const [c, p] of Object.entries(s.pos)) if (paper.mids[c] > 0 && mids[c] > 0) s.equity += p.szi * (mids[c] - paper.mids[c]);
    // 2. This variant's view of the scores.
    let vs = null;
    if (scores) {
      vs = {};
      for (const c of vc.markets) {
        let x = scores[c] ?? null;
        if (x != null && v.invert) x = -x;
        if (x != null && v.smoothHours) {
          const a = 1 - Math.exp(-dt / (v.smoothHours * 3600e3));
          x = s.ema[c] == null ? x : s.ema[c] + a * (x - s.ema[c]);
          s.ema[c] = x;
        }
        vs[c] = x;
      }
      s.last = { ...vs };
    }
    // 3. Stops, checked against the price range since the last cycle (or this cycle's mid).
    if (sc.enabled !== false) for (const [c, p] of Object.entries(s.pos)) {
      const t = s.trail[c], m = mids[c], side = Math.sign(p.szi);
      if (!t || !(m > 0)) continue;
      const lo = Math.min(m, ranges?.[c]?.lo ?? m), hi = Math.max(m, ranges?.[c]?.hi ?? m);
      if (!(side > 0 ? lo <= t.stopPx : hi >= t.stopPx)) continue;
      s.equity += p.szi * (t.stopPx - m);
      fill(s, p.szi, t.stopPx); s.stopsHit++;
      // Scored with the last known reading when there is no fresh one, as the live bot does.
      s.blocks[c] = { side, weight: ((vs ?? s.last)?.[c] ?? side * DEADBAND) / 100 };
      delete s.pos[c]; delete s.trail[c];
    }
    // 4. Decide and trade, only on a fresh signal.
    if (vs) {
      for (const c of Object.keys(s.blocks)) if (releaseReason(s.blocks[c], vs[c], sc)) delete s.blocks[c];
      const current = Object.fromEntries(vc.markets.map((c) => [c, s.pos[c] && mids[c] > 0 ? s.pos[c].szi * mids[c] : 0]));
      const signal = { coins: Object.entries(vs).filter(([, x]) => x != null).map(([coin, score]) => ({ coin, score })) };
      for (const r of targetRows({ equity: s.equity, cfg: vc, signal, current })) {
        const c = r.coin, m = mids[c];
        if (!(m > 0)) continue;
        // Signed size for a notional, rounded as a real order would be (0 = the order is skipped).
        const size = (usd, reduceOnly = false) => {
          if (!markets?.[c]) return usd / m;
          const px = usd > 0 ? m * (1 + vc.slippage) : m * (1 - vc.slippage);
          const sz = orderSize(Math.abs(usd) / m, { px, szDecimals: markets[c].szDecimals, minOrderUsd: vc.minOrderUsd, reduceOnly, posSz: Math.abs(s.pos[c]?.szi ?? 0) });
          return sz ? Math.sign(usd) * Number(sz) : 0;
        };
        for (const a of r.actions) {
          if ((a === "CLOSE" || a === "FLIP-CLOSE") && s.pos[c]) { fill(s, s.pos[c].szi, m); delete s.pos[c]; delete s.trail[c]; }
          else if ((a === "OPEN" || a === "FLIP-OPEN") && !s.blocks[c]) { const sz = size(r.target); if (sz) { fill(s, sz, m); s.pos[c] = { szi: sz, entry: m }; } }
          else if (a === "ADD" && s.pos[c]) {
            const d = size(r.gap), p = s.pos[c];
            if (!d) continue;
            fill(s, d, m);
            p.entry = (p.entry * Math.abs(p.szi) + m * Math.abs(d)) / (Math.abs(p.szi) + Math.abs(d)); p.szi += d;
          } else if (a === "REDUCE" && s.pos[c]) { const d = size(r.gap, true); if (d) { fill(s, d, m); s.pos[c].szi += d; } }
        }
      }
    }
    // 5. Stop levels for what is now held.
    for (const [c, p] of Object.entries(s.pos)) if (mids[c] > 0) s.trail[c] = stopPlan({ side: Math.sign(p.szi), entry: p.entry }, mids[c], s.trail[c], sc);
    s.peak = Math.max(s.peak, s.equity);
    s.maxDD = Math.max(s.maxDD, s.peak > 0 ? 1 - s.equity / s.peak : 0);
  }
  paper.mids = { ...paper.mids, ...mids };
  paper.lastTs = ts;
  return paper;
}

/** One row per variant, in display order. */
export function paperSummary(paper, variants = PAPER_VARIANTS) {
  return variants.filter((v) => paper.variants[v.id]).map((v) => {
    const s = paper.variants[v.id];
    return { id: v.id, label: v.label, equity: s.equity, change: s.equity - paper.startEquity, fees: s.fees, trades: s.trades, stopsHit: s.stopsHit, maxDD: s.maxDD, positions: Object.keys(s.pos).length };
  });
}

/** Coins any variant holds, whose price range since the last cycle the stop check needs. */
export const paperCoins = (paper) => [...new Set(Object.values(paper.variants).flatMap((s) => Object.keys(s.pos)))];

/** Lowest and highest trade price per coin from 1-minute candles [{t, h, l}] opened at or after `from`. */
export function candleRange(candles, from) {
  let lo = Infinity, hi = -Infinity;
  for (const k of candles ?? []) if (k.t >= from) { lo = Math.min(lo, Number(k.l)); hi = Math.max(hi, Number(k.h)); }
  return hi > -Infinity ? { lo, hi } : null;
}

/** Scores for the traded markets from a signal reading. */
export const scoresFor = (signal, markets) => Object.fromEntries(markets.map((c) => [c, findScore(signal, c).score]));
