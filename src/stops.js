// Protective stops, modelled on the X1 copybot's "stop sync" (whitepaper, Risk Management):
//  - Hard stop: a reduce-only stop-market trigger RESTING ON HYPERLIQUID at stopLossPct adverse
//    to entry, with a stopSlippage cap. Replaced when size changes, cancelled when flat. Because it
//    rests on the exchange it fires even if this bot is down.
//  - Trailing stop: once the best price is trailArmPct in favour, the stop moves to breakeven
//    +0.1%, then trails trailPct behind the best price. It only ever tightens.
//  - Re-entry block: after a stop fills, the coin is blocked from re-opening until the signal
//    flips direction, goes flat (|score| < deadband), leaves the signal, or its weight changes by
//    more than reentryWeightChange (relative).
import { DEADBAND } from "./config.js";
import { formatPrice, formatSize } from "./strategy.js";

const BREAKEVEN_BUFFER = 0.001;

// ── pure math ───────────────────────────────────────────────────────────────────────────────

/** Tighter of two stop prices for a side (long: higher; short: lower). */
export const tighter = (side, a, b) => (a == null ? b : b == null ? a : side > 0 ? Math.max(a, b) : Math.min(a, b));

/**
 * Next trail state + desired trigger price for one position.
 * pos: {side: ±1, entry}; mid: current price; prev: {best, armed, stopPx, entry, side} | undefined.
 */
export function stopPlan(pos, mid, prev, sc) {
  const { side, entry } = pos;
  const fresh = !prev || prev.side !== side;
  let best = fresh ? entry : prev.best;
  if (Number.isFinite(mid)) best = side > 0 ? Math.max(best, mid) : Math.min(best, mid);
  const favour = side > 0 ? best / entry - 1 : 1 - best / entry;
  const armed = (!fresh && prev.armed) || favour >= sc.trailArmPct;
  const hard = side > 0 ? entry * (1 - sc.stopLossPct) : entry * (1 + sc.stopLossPct);
  let stopPx = hard;
  if (armed) {
    const be = side > 0 ? entry * (1 + BREAKEVEN_BUFFER) : entry * (1 - BREAKEVEN_BUFFER);
    const trail = side > 0 ? best * (1 - sc.trailPct) : best * (1 + sc.trailPct);
    stopPx = tighter(side, be, trail);
  }
  // Only tightens while the same position is held. An add that moves the entry resets to the new hard stop.
  if (!fresh && prev.entry === entry) stopPx = tighter(side, stopPx, prev.stopPx);
  return { side, entry, best, armed, stopPx };
}

/** Should an existing re-entry block be lifted, given the coin's current score? Returns a reason or null. */
export function releaseReason(block, score, sc) {
  if (score == null) return "left the signal";
  if (Math.abs(score) < DEADBAND) return "signal went flat";
  if (Math.sign(score) !== block.side) return "signal flipped";
  const w = score / 100, w0 = block.weight;
  if (Math.abs(w0) > 0 && Math.abs(w - w0) / Math.abs(w0) > sc.reentryWeightChange) return `weight moved ${Math.round(((w - w0) / Math.abs(w0)) * 100)}%`;
  return null;
}

/** The wire order for a reduce-only stop-market trigger. */
export function stopOrder(m, side, size, stopPx, sc) {
  const isBuy = side < 0; // a short is stopped out by buying
  const triggerPx = formatPrice(stopPx, m.szDecimals);
  const limit = formatPrice(isBuy ? stopPx * (1 + sc.stopSlippage) : stopPx * (1 - sc.stopSlippage), m.szDecimals);
  return { a: m.asset, b: isBuy, p: limit, s: formatSize(size, m.szDecimals), r: true, t: { trigger: { isMarket: true, triggerPx, tpsl: "sl" } } };
}

// ── exchange sync ─────────────────────────────────────────────────────────────────────────

const isOurStop = (o) => o.isTrigger && o.reduceOnly && /Stop/.test(o.orderType ?? "");

/**
 * Detect stops that filled since the last check and update blocks.
 * book: persisted {trail, oids, blocks, lastCheck}. Returns events for logging.
 */
export async function detectStopFills({ info, owner, book, positions, signal, sc, now }) {
  const events = [];
  const since = book.lastCheck ?? now - 3600_000;
  const watched = Object.entries(book.oids ?? {});
  if (watched.length) {
    const fills = await info.userFillsByTime({ user: owner, startTime: since });
    for (const [coin, oid] of watched) {
      const hit = fills.find((f) => f.oid === oid);
      const flatNow = !(Math.abs(positions[coin]?.szi ?? 0) > 0);
      if (hit && flatNow) {
        const score = signal.coins.find((c) => c.coin === coin || c.coin === coin.split(":").at(-1))?.score ?? null;
        const side = book.trail?.[coin]?.side ?? (hit.dir?.includes("Long") ? 1 : -1);
        book.blocks[coin] = { side, weight: (score ?? side * DEADBAND) / 100, at: hit.time, px: Number(hit.px), pnl: Number(hit.closedPnl) };
        delete book.trail[coin]; delete book.oids[coin];
        events.push({ kind: "fill", msg: `STOP ${coin}: filled ${hit.sz} @ ${hit.px} (pnl ${Number(hit.closedPnl).toFixed(2)}); re-entry blocked`, coin, stop: true });
      }
    }
  }
  for (const [coin, block] of Object.entries(book.blocks)) {
    const score = signal.coins.find((c) => c.coin === coin || c.coin === coin.split(":").at(-1))?.score ?? null;
    const why = releaseReason(block, score, sc);
    if (why) { delete book.blocks[coin]; events.push({ kind: "control", msg: `re-entry block lifted on ${coin}: ${why}` }); }
  }
  book.lastCheck = now;
  return events;
}

/**
 * Place / replace / cancel resting stops so every open position has exactly one, at the plan's price.
 * Returns {rows, events}. When send is false it only plans.
 */
export async function syncStops({ info, exchange, owner, markets, book, positions, mids, sc, send, builder }) {
  const events = [], rows = [];
  const dexes = [...new Set(Object.values(markets).map((m) => m.dex))];
  const open = (await Promise.all(dexes.map((dex) => info.frontendOpenOrders(dex ? { user: owner, dex } : { user: owner })))).flat().filter(isOurStop);
  const cancels = [], places = [];

  for (const [coin, p] of Object.entries(positions)) {
    const m = markets[coin];
    if (!m || !(Math.abs(p.szi) > 0)) continue;
    const side = Math.sign(p.szi), size = Math.abs(p.szi);
    const plan = stopPlan({ side, entry: p.entryPx }, mids[coin], book.trail[coin], sc);
    const want = stopOrder(m, side, size, plan.stopPx, sc);
    const mine = open.filter((o) => o.coin === coin);
    const match = mine.find((o) => Number(o.sz) === Number(want.s) && Number(o.triggerPx) === Number(want.t.trigger.triggerPx) && o.side === (want.b ? "B" : "A"));
    for (const o of mine) if (o !== match) cancels.push({ coin, a: m.asset, o: o.oid });
    if (!match) places.push({ coin, wire: want, plan });
    else book.oids[coin] = match.oid;
    book.trail[coin] = { ...plan, stopPx: Number(want.t.trigger.triggerPx) };
    const dist = mids[coin] > 0 ? Math.abs(plan.stopPx / mids[coin] - 1) : null;
    rows.push({ coin, side, size, entry: p.entryPx, stopPx: Number(want.t.trigger.triggerPx), armed: plan.armed, best: plan.best, distPct: dist, status: match ? "resting" : send ? "placing" : "planned" });
  }
  // Stops left on coins we no longer hold.
  for (const o of open) if (!(Math.abs(positions[o.coin]?.szi ?? 0) > 0) && markets[o.coin]) cancels.push({ coin: o.coin, a: markets[o.coin].asset, o: o.oid });
  for (const coin of Object.keys(book.trail)) if (!(Math.abs(positions[coin]?.szi ?? 0) > 0)) { delete book.trail[coin]; delete book.oids[coin]; }

  if (!send) return { rows, events, cancels: cancels.length, places: places.length };
  if (cancels.length) {
    try { await exchange.cancel({ cancels: cancels.map(({ a, o }) => ({ a, o })) }); }
    catch (e) { events.push({ kind: "error", msg: `stop cancel failed: ${e.message}` }); }
  }
  if (places.length) {
    try {
      const req = { orders: places.map((x) => x.wire), grouping: "na" };
      if (builder) req.builder = builder;
      const res = await exchange.order(req);
      const st = res.response?.data?.statuses ?? [];
      places.forEach((x, i) => {
        const s = st[i] ?? {};
        // Trigger orders come back as {resting:{oid}} (or a similar {<state>:{oid}} wrapper).
        const oid = s.resting?.oid ?? Object.values(s).find((v) => v && typeof v === "object" && v.oid)?.oid;
        if (oid) { book.oids[x.coin] = oid; const r = rows.find((rr) => rr.coin === x.coin); if (r) r.status = "resting"; }
        events.push(s.error ? { kind: "error", msg: `stop ${x.coin}: ${s.error}` } : { kind: "control", msg: `stop ${x.coin} ${x.plan.side > 0 ? "sell" : "buy"} ${x.wire.s} @ trigger ${x.wire.t.trigger.triggerPx}${x.plan.armed ? " (trailing)" : ""}` });
      });
    } catch (e) { events.push({ kind: "error", msg: `stop placement failed: ${e.message}` }); }
  }
  return { rows, events, cancels: cancels.length, places: places.length };
}

/** Cancel every stop we manage (used by flatten). */
export async function cancelAllStops({ info, exchange, owner, markets }) {
  const dexes = [...new Set(Object.values(markets).map((m) => m.dex))];
  const open = (await Promise.all(dexes.map((dex) => info.frontendOpenOrders(dex ? { user: owner, dex } : { user: owner })))).flat().filter(isOurStop).filter((o) => markets[o.coin]);
  if (open.length) await exchange.cancel({ cancels: open.map((o) => ({ a: markets[o.coin].asset, o: o.oid })) });
  return open.length;
}
