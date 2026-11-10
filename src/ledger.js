// Running P&L since a fixed start point, reconciled against the account's equity.
//   total     = equity − startEquity − net deposits/withdrawals since the start
//   explained = realized − fees + funding + (uPnL now − uPnL at start)
//   residual  = total − explained   (≈0 when everything is accounted for)
// Fees are what Hyperliquid charged on each fill and already include the builder fee.
import { PATHS } from "./config.js";
import { readJson, writeJson } from "./control.js";

const isPerp = (coin) => typeof coin === "string" && !coin.startsWith("@") && !coin.includes("/");
const KNOWN_LEDGER = ["deposit", "withdraw", "internalTransfer", "subAccountTransfer", "spotTransfer", "accountClassTransfer", "vaultDeposit", "vaultWithdraw"];

/**
 * Every row in [since, until] from a time-ranged info endpoint. Hyperliquid caps each response
 * (2000 fills, ~500 funding/ledger rows), so page forward from the newest time seen until a page
 * brings nothing new. Rows are de-duplicated by `key`, so overlapping page edges are safe.
 */
export async function pageByTime(fetchPage, since, until, key) {
  const out = [], seen = new Set();
  let start = since;
  for (let page = 0; page < 100; page++) {
    const batch = await fetchPage(start, until);
    let added = 0;
    for (const x of batch) { const k = key(x); if (!seen.has(k)) { seen.add(k); out.push(x); added++; } }
    if (!added || !batch.length) break;
    const last = Math.max(...batch.map((x) => x.time));
    if (last <= start && page > 0) break;
    start = last;
  }
  return out;
}

/**
 * USDC that entered (+) or left (−) the trading equity through a ledger update. Only USDC counts:
 * another token arriving in spot is not equity until it is sold. In unified mode spot and perps
 * share one balance, so perp⇄spot class transfers are not flows.
 */
export function ledgerFlow(delta, owner, unified) {
  const me = owner.toLowerCase(), n = (v) => Number(v ?? 0) || 0;
  const incoming = (delta.destination ?? "").toLowerCase() === me;
  switch (delta.type) {
    case "deposit": return n(delta.usdc);
    case "withdraw": return -n(delta.usdc) - n(delta.fee);
    case "internalTransfer":
    case "subAccountTransfer": return incoming ? n(delta.usdc) : -n(delta.usdc) - n(delta.fee);
    case "spotTransfer": {
      const fee = (delta.user ?? "").toLowerCase() === me && delta.feeToken === "USDC" ? n(delta.fee) : 0;
      if (delta.token !== "USDC") return fee ? -fee : 0;
      return incoming ? n(delta.amount) : -n(delta.amount) - fee;
    }
    case "accountClassTransfer": return unified ? 0 : delta.toPerp ? n(delta.usdc) : -n(delta.usdc);
    case "vaultDeposit": return -n(delta.usdc);
    case "vaultWithdraw": return n(delta.netWithdrawnUsd ?? delta.usdc);
    default: return 0;
  }
}

const emptyAgg = () => ({ realized: 0, fees: 0, builderFees: 0, volume: 0, trades: 0, funding: 0, flows: 0, byCoin: {}, unknown: [] });
const emptyCoin = () => ({ realized: 0, fees: 0, funding: 0, fills: 0, volume: 0 });

/** Plain sums over the rows with from <= time < to. Additive, so two windows can be merged. */
export function aggregate({ fills, funding, ledger, owner, unified, from, to = Infinity }) {
  const a = emptyAgg(), unknown = new Set();
  const within = (t) => t >= from && t < to;
  for (const f of fills) {
    if (!within(f.time)) continue;
    const fee = Number(f.fee) || 0, bf = Number(f.builderFee) || 0;
    a.fees += fee; a.builderFees += bf;
    if (!isPerp(f.coin)) continue;
    const c = (a.byCoin[f.coin] ??= emptyCoin());
    const r = Number(f.closedPnl) || 0, v = Number(f.px) * Number(f.sz);
    c.realized += r; c.fees += fee; c.fills++; c.volume += v;
    a.realized += r; a.volume += v; a.trades++;
  }
  for (const x of funding) {
    if (!within(x.time)) continue;
    const usdc = Number(x.delta?.usdc) || 0;
    a.funding += usdc;
    (a.byCoin[x.delta?.coin] ??= emptyCoin()).funding += usdc;
  }
  for (const l of ledger) {
    if (!within(l.time)) continue;
    a.flows += ledgerFlow(l.delta, owner, unified);
    if (!KNOWN_LEDGER.includes(l.delta?.type)) unknown.add(l.delta?.type);
  }
  a.unknown = [...unknown];
  return a;
}

export function mergeAgg(a, b) {
  const out = emptyAgg();
  for (const k of ["realized", "fees", "builderFees", "volume", "trades", "funding", "flows"]) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  for (const src of [a.byCoin ?? {}, b.byCoin ?? {}]) for (const [coin, c] of Object.entries(src)) {
    const t = (out.byCoin[coin] ??= emptyCoin());
    for (const k of Object.keys(t)) t[k] += c[k] ?? 0;
  }
  out.unknown = [...new Set([...(a.unknown ?? []), ...(b.unknown ?? [])])];
  return out;
}

/** Turn the sums into the P&L breakdown. */
export function finish(agg, { start, equity, upnl, now = Date.now() }) {
  const total = equity - start.equity - agg.flows;
  const explained = agg.realized - agg.fees + agg.funding + (upnl - (start.upnl ?? 0));
  const basis = start.equity + Math.max(0, agg.flows);
  return {
    since: start.since, startEquity: start.equity, equity, flows: agg.flows, total, totalPct: basis > 0 ? (total / basis) * 100 : null,
    realized: agg.realized, fees: agg.fees, builderFees: agg.builderFees, funding: agg.funding, upnl, explained, residual: total - explained,
    trades: agg.trades, volume: agg.volume, byCoin: agg.byCoin, unknownLedgerTypes: agg.unknown, days: (now - start.since) / 864e5, ts: now,
  };
}

/** Sum fills, funding and flows into a P&L breakdown. Pure, so it is tested without the network. */
export function summarize({ fills, funding, ledger, owner, unified, start, equity, upnl, now = Date.now() }) {
  return finish(aggregate({ fills, funding, ledger, owner, unified, from: start.since }), { start, equity, upnl, now });
}

/** The start point: data/pnl.json, created on the first call from the current equity. */
export function pnlStart(equity, upnl, asOf = Date.now()) {
  const s = readJson(PATHS.pnl, null);
  if (s?.since > 0 && s.equity > 0) return s;
  const fresh = { since: asOf, equity, upnl, note: "P&L start point. Edit since/equity to re-base." };
  writeJson(PATHS.pnl, fresh);
  return fresh;
}

// Checkpoint: the sums for [since, upTo) are kept in data/pnl-cache.json, so each cycle fetches only
// the rows after upTo instead of the whole history. upTo trails the present by CKPT_LAG so rows
// that land a little late are still read live, it advances every CKPT_EVERY, and the whole thing
// is rebuilt from scratch once every CKPT_FULL so an error cannot persist. Deleting the file is safe.
export const CKPT_LAG = 3600e3, CKPT_EVERY = 6 * 3600e3, CKPT_FULL = 24 * 3600e3;

/** The checkpoint to build on: the saved one if it matches this start point and is recent, else an empty one. */
export function checkpointBase(cache, { start, owner, unified, asOf }) {
  const ok = cache?.v === 1 && cache.since === start.since && cache.unified === unified
    && typeof cache.owner === "string" && cache.owner.toLowerCase() === owner.toLowerCase()
    && cache.upTo > start.since && cache.upTo <= asOf && asOf - cache.fullAt <= CKPT_FULL && cache.agg;
  return ok ? cache : { v: 1, since: start.since, owner, unified, upTo: start.since, fullAt: asOf, agg: emptyAgg() };
}

/** Combine a checkpoint with the rows fetched since it. Returns the totals and, when due, the next checkpoint to save. */
export function applyCheckpoint(base, rows, { asOf }) {
  const args = { ...rows, owner: base.owner, unified: base.unified };
  const total = mergeAgg(base.agg, aggregate({ ...args, from: base.upTo }));
  let next = null;
  if (asOf - base.upTo > CKPT_EVERY + CKPT_LAG) {
    const upTo = asOf - CKPT_LAG;
    next = { ...base, upTo, agg: mergeAgg(base.agg, aggregate({ ...args, from: base.upTo, to: upTo })) };
  }
  return { total, next };
}

/**
 * P&L as of `asOf`, the moment `equity`/`upnl` were read. Fills, funding and flows are bounded to
 * the same moment, so this cycle's own orders (sent after the snapshot) count next cycle, when the
 * equity reflects them too; otherwise a close would be counted both as realized and as stale uPnL.
 * `persist: false` reads the checkpoint but never writes it (reports).
 */
export async function fetchPnl(info, owner, { equity, upnl, unified, asOf = Date.now(), persist = true }) {
  const start = pnlStart(equity, upnl, asOf);
  const base = checkpointBase(readJson(PATHS.pnlCache, null), { start, owner, unified, asOf });
  const ranged = (method, extra = {}) => (s, e) => info[method]({ user: owner, startTime: s, endTime: e, ...extra });
  const [fills, funding, ledger] = await Promise.all([
    pageByTime(ranged("userFillsByTime"), base.upTo, asOf, (f) => `${f.tid}:${f.oid}`),
    pageByTime(ranged("userFunding"), base.upTo, asOf, (x) => `${x.time}:${x.hash}:${x.delta?.coin}`),
    pageByTime(ranged("userNonFundingLedgerUpdates"), base.upTo, asOf, (x) => `${x.time}:${x.hash}:${x.delta?.type}`),
  ]);
  const { total, next } = applyCheckpoint(base, { fills, funding, ledger }, { asOf });
  if (next && persist) { try { writeJson(PATHS.pnlCache, next); } catch { /* the next cycle just fetches a little more */ } }
  return { ...finish(total, { start, equity, upnl, now: asOf }), asOf, fetchedFrom: base.upTo };
}
