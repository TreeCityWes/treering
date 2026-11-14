// Pure target/plan math, ported from x1-terminal's apps/terminal/src/lib/auto-trader/targets.ts
// so this bot sizes positions the same way the hosted Auto Trader does.
import { DEADBAND } from "./config.js";

export function findScore(signal, coin) {
  const bare = coin.split(":").at(-1);
  const entry = signal.coins.find((c) => c.coin === coin) ?? signal.coins.find((c) => c.coin === bare);
  return entry ? { score: entry.score ?? null, label: entry.label } : { score: null };
}

/**
 * The signal with each coin's score replaced by its average over the last `hours` (from the
 * ~24h of 3-minute points the API returns), rounded to 0.1. The reading's own score is kept as
 * rawScore. A coin with no current score, or no points in the window, keeps its raw score.
 * hours <= 0 returns the signal unchanged.
 */
export function smoothSignal(signal, hours) {
  if (!(hours > 0) || !signal) return signal;
  const to = signal.timestamp ?? Date.now(), from = to - hours * 3600e3;
  return { ...signal, smoothHours: hours, coins: signal.coins.map((c) => {
    if (c.score == null) return c;
    const pts = (c.points ?? []).filter(([t]) => t >= from && t <= to);
    if (!pts.length) return { ...c, rawScore: c.score };
    return { ...c, rawScore: c.score, score: Math.round((pts.reduce((n, [, s]) => n + s, 0) / pts.length) * 10) / 10 };
  }) };
}

/**
 * target notional = equity × leverage ÷ markets × score/100
 * |score| < 15 or missing → hold current position unchanged.
 * killed (daily loss stop hit) → may reduce/close, never add or flip.
 * Flip hysteresis: reversing an open position needs |score| >= cfg.flipMinScore; a weaker opposite
 * score holds the position (`flipHeld`). Not applied while the loss stop is hit, so it can still close.
 * Adds/trims to an open position smaller than cfg.rebalance (max of minGapUsd and minGapFrac ×
 * position) are skipped and marked `small`, to avoid churning fees on noise.
 * cfg.rebalance.resize === false turns off adds and trims altogether (marked `noResize`): a position
 * keeps the size it was opened at until it is closed or flipped. The daily loss stop can still trim.
 */
export function targetRows({ equity, cfg, signal, current, killed = false }) {
  const perCoin = cfg.markets.length ? (equity * cfg.leverage) / cfg.markets.length : 0;
  return cfg.markets.map((coin) => {
    const { score, label } = findScore(signal, coin);
    const cur = current[coin] ?? 0;
    const weakFlip = !killed && score !== null && Math.abs(score) >= DEADBAND && cur !== 0
      && Math.sign(score) !== Math.sign(cur) && Math.abs(score) < (cfg.flipMinScore ?? 0);
    const hold = score === null || Math.abs(score) < DEADBAND || weakFlip;
    const raw = hold ? cur : perCoin * (score / 100);
    let tgt = raw;
    if (killed && !hold) {
      if (cur !== 0 && Math.sign(tgt) !== Math.sign(cur)) tgt = 0;
      else if (Math.abs(tgt) > Math.abs(cur)) tgt = cur;
    }
    const gap = tgt - cur;
    const flip = cur !== 0 && tgt !== 0 && Math.sign(cur) !== Math.sign(tgt);
    const rb = cfg.rebalance ?? {};
    const minGap = Math.max(rb.minGapUsd ?? 0, (rb.minGapFrac ?? 0) * Math.abs(cur));
    let actions, small = false, noResize = false;
    if (hold) actions = [cur === 0 ? "SKIP" : "HOLD"];
    else if (cur !== 0 && (tgt === 0 || flip)) actions = [flip ? "FLIP-CLOSE" : "CLOSE", ...(flip && Math.abs(tgt) >= cfg.minOrderUsd && !killed ? ["FLIP-OPEN"] : [])];
    else if (Math.abs(gap) < cfg.minOrderUsd) actions = [killed && tgt !== raw ? "LOSS-STOP" : "SKIP"];
    else if (!killed && cur !== 0 && rb.resize === false) { actions = ["SKIP"]; noResize = true; }
    else if (!killed && cur !== 0 && Math.abs(gap) < minGap) { actions = ["SKIP"]; small = true; }
    else actions = [cur === 0 ? "OPEN" : Math.abs(tgt) > Math.abs(cur) ? "ADD" : "REDUCE"];
    return { coin, score, label, current: cur, target: tgt, gap, actions, ...(small ? { small: true } : {}), ...(noResize ? { noResize: true } : {}), ...(weakFlip ? { flipHeld: true } : {}) };
  });
}

/**
 * Drawdown from the equity high-water mark. Returns the peak to carry forward, the drawdown as a
 * fraction of it, and whether it has reached maxPct (0 turns the check off).
 */
export function drawdownCheck(peak, equity, maxPct) {
  const hi = Math.max(peak > 0 ? peak : 0, equity);
  const dd = hi > 0 ? 1 - equity / hi : 0;
  return { peak: hi, dd, hit: maxPct > 0 && dd >= maxPct };
}

// Hyperliquid perp prices: ≤5 significant figures and ≤(6 − szDecimals) decimals.
export function formatPrice(px, szDecimals) {
  if (Number.isInteger(px) && px >= 1e5) return String(px);
  const sig = Number(px.toPrecision(5));
  const decimals = Math.max(0, 6 - szDecimals);
  return String(Number(sig.toFixed(decimals)));
}

export function formatSize(sz, szDecimals) {
  const f = 10 ** szDecimals;
  return String(Math.floor(sz * f + 1e-9) / f);
}

// A small open is rounded up to clear the $10 minimum, but never to more than this multiple of
// the size asked for. Coarse size steps (ZEC trades in 0.01 ≈ $9) otherwise turn a $10.70 target
// into $19, and with resizing off the position keeps that size until it closes.
export const MAX_ROUND_UP = 1.5;

/**
 * Order size as a string at Hyperliquid's size step, or null to skip the order. Hyperliquid checks
 * the $10 minimum at the order's limit price (1% worse than mid) and exempts only full closes, so
 * an order sized to ~$10 at mid can be rejected. Within 15% of the minimum it is rounded up to the
 * smallest size that clears it with 0.5% headroom, unless that is more than MAX_ROUND_UP times the
 * size asked for or (for a reduce) more than the position; further below it is skipped.
 */
export function orderSize(szNum, { px, szDecimals, minOrderUsd, reduceOnly = false, posSz = Infinity, fullClose = false }) {
  let sz = formatSize(szNum, szDecimals);
  if (!fullClose && Number(sz) * px < minOrderUsd) {
    if (szNum * px < minOrderUsd * 0.85) return null;
    const step = 10 ** -szDecimals;
    const bumped = Math.ceil((minOrderUsd * 1.005) / px / step - 1e-9) * step;
    if (bumped > szNum * MAX_ROUND_UP + 1e-12) return null;
    if (reduceOnly && bumped > posSz + 1e-12) return null;
    sz = formatSize(bumped, szDecimals);
  }
  return Number(sz) > 0 ? sz : null;
}

/** Turn plan rows into IOC limit orders priced `slippage` through mid. */
export function buildOrders(rows, { markets, mids, positions, slippage, minOrderUsd }) {
  const orders = [];
  for (const r of rows) {
    const m = markets[r.coin], mid = mids[r.coin];
    if (!m || !(mid > 0)) continue;
    const posSz = Math.abs(positions[r.coin]?.szi ?? 0);
    const push = (tag, isBuy, szNum, reduceOnly, fullClose = false) => {
      const px = formatPrice(isBuy ? mid * (1 + slippage) : mid * (1 - slippage), m.szDecimals);
      const sz = orderSize(szNum, { px: Number(px), szDecimals: m.szDecimals, minOrderUsd, reduceOnly, posSz, fullClose });
      if (!sz) return;
      const ntl = Number(sz) * mid;
      orders.push({ coin: r.coin, tag, isBuy, sz, px, ntl, reduceOnly, wire: { a: m.asset, b: isBuy, p: px, s: sz, r: reduceOnly, t: { limit: { tif: "Ioc" } } } });
    };
    for (const act of r.actions) {
      if (act === "CLOSE" || act === "FLIP-CLOSE") push(act, r.current < 0, posSz, true, true);
      else if (act === "FLIP-OPEN" || act === "OPEN" || act === "ADD") push(act, (act === "ADD" ? r.gap : r.target) > 0, Math.abs(act === "ADD" ? r.gap : r.target) / mid, false);
      else if (act === "REDUCE") push(act, r.gap > 0, Math.min(posSz, Math.abs(r.gap) / mid), true);
    }
  }
  // Closing legs first so flips free margin before re-opening.
  return orders.sort((a, b) => Number(b.reduceOnly) - Number(a.reduceOnly));
}
