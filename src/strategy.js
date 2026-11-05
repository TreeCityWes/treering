// Pure target/plan math, ported from x1-terminal's apps/terminal/src/lib/auto-trader/targets.ts
// so this bot sizes positions the same way the hosted Auto Trader does.
import { DEADBAND } from "./config.js";

export function findScore(signal, coin) {
  const bare = coin.split(":").at(-1);
  const entry = signal.coins.find((c) => c.coin === coin) ?? signal.coins.find((c) => c.coin === bare);
  return entry ? { score: entry.score ?? null, label: entry.label } : { score: null };
}

/**
 * target notional = equity × leverage ÷ markets × score/100
 * |score| < 15 or missing → hold current position unchanged.
 * killed (daily loss stop hit) → may reduce/close, never add or flip.
 */
export function targetRows({ equity, cfg, signal, current, killed = false }) {
  const perCoin = cfg.markets.length ? (equity * cfg.leverage) / cfg.markets.length : 0;
  return cfg.markets.map((coin) => {
    const { score, label } = findScore(signal, coin);
    const hold = score === null || Math.abs(score) < DEADBAND;
    const cur = current[coin] ?? 0;
    const raw = hold ? cur : perCoin * (score / 100);
    let tgt = raw;
    if (killed && !hold) {
      if (cur !== 0 && Math.sign(tgt) !== Math.sign(cur)) tgt = 0;
      else if (Math.abs(tgt) > Math.abs(cur)) tgt = cur;
    }
    const gap = tgt - cur;
    const flip = cur !== 0 && tgt !== 0 && Math.sign(cur) !== Math.sign(tgt);
    let actions;
    if (hold) actions = [cur === 0 ? "SKIP" : "HOLD"];
    else if (cur !== 0 && (tgt === 0 || flip)) actions = [flip ? "FLIP-CLOSE" : "CLOSE", ...(flip && Math.abs(tgt) >= cfg.minOrderUsd && !killed ? ["FLIP-OPEN"] : [])];
    else if (Math.abs(gap) < cfg.minOrderUsd) actions = [killed && tgt !== raw ? "LOSS-STOP" : "SKIP"];
    else actions = [cur === 0 ? "OPEN" : Math.abs(tgt) > Math.abs(cur) ? "ADD" : "REDUCE"];
    return { coin, score, label, current: cur, target: tgt, gap, actions };
  });
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

/** Turn plan rows into IOC limit orders priced `slippage` through mid. */
export function buildOrders(rows, { markets, mids, positions, slippage, minOrderUsd }) {
  const orders = [];
  for (const r of rows) {
    const m = markets[r.coin], mid = mids[r.coin];
    if (!m || !(mid > 0)) continue;
    const posSz = Math.abs(positions[r.coin]?.szi ?? 0);
    const push = (tag, isBuy, szNum, reduceOnly, fullClose = false) => {
      const px = formatPrice(isBuy ? mid * (1 + slippage) : mid * (1 - slippage), m.szDecimals);
      let sz = formatSize(szNum, m.szDecimals);
      // Hyperliquid checks the $10 minimum at the order's limit price (1% worse than mid) and
      // exempts only full closes, so an order sized to ~$10 at mid can be rejected. If it is
      // within 15% of the minimum, round up to the smallest size that clears it with 0.5%
      // headroom (never past the position for a reduce); otherwise skip it.
      if (!fullClose && Number(sz) * Number(px) < minOrderUsd) {
        if (szNum * Number(px) < minOrderUsd * 0.85) return;
        const step = 10 ** -m.szDecimals;
        const bumped = Math.ceil((minOrderUsd * 1.005) / Number(px) / step - 1e-9) * step;
        if (reduceOnly && bumped > posSz + 1e-12) return;
        sz = formatSize(bumped, m.szDecimals);
      }
      if (Number(sz) <= 0) return;
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
