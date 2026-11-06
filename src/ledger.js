// Running P&L since a fixed start point, reconciled against the account's equity.
//   total     = equity − startEquity − net deposits/withdrawals since the start
//   explained = realized − fees + funding + (uPnL now − uPnL at start)
//   residual  = total − explained   (≈0 when everything is accounted for)
// Fees are what Hyperliquid charged on each fill and already include the builder fee.
import { PATHS } from "./config.js";
import { readJson, writeJson } from "./control.js";

const isPerp = (coin) => typeof coin === "string" && !coin.startsWith("@") && !coin.includes("/");

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

/** Sum fills, funding and flows into a P&L breakdown. Pure, so it is tested without the network. */
export function summarize({ fills, funding, ledger, owner, unified, start, equity, upnl, now = Date.now() }) {
  const byCoin = {};
  let realized = 0, fees = 0, builderFees = 0, volume = 0, trades = 0;
  for (const f of fills) {
    if (f.time < start.since) continue;
    const fee = Number(f.fee) || 0, bf = Number(f.builderFee) || 0;
    fees += fee; builderFees += bf;
    if (!isPerp(f.coin)) continue;
    const c = (byCoin[f.coin] ??= { realized: 0, fees: 0, funding: 0, fills: 0, volume: 0 });
    const r = Number(f.closedPnl) || 0, v = Number(f.px) * Number(f.sz);
    c.realized += r; c.fees += fee; c.fills++; c.volume += v;
    realized += r; volume += v; trades++;
  }
  let fundingTotal = 0;
  for (const x of funding) {
    if (x.time < start.since) continue;
    const usdc = Number(x.delta?.usdc) || 0;
    fundingTotal += usdc;
    (byCoin[x.delta?.coin] ??= { realized: 0, fees: 0, funding: 0, fills: 0, volume: 0 }).funding += usdc;
  }
  const unknown = new Set();
  let flows = 0;
  for (const l of ledger) {
    if (l.time < start.since) continue;
    flows += ledgerFlow(l.delta, owner, unified);
    if (!["deposit", "withdraw", "internalTransfer", "subAccountTransfer", "spotTransfer", "accountClassTransfer", "vaultDeposit", "vaultWithdraw"].includes(l.delta?.type)) unknown.add(l.delta?.type);
  }
  const total = equity - start.equity - flows;
  const explained = realized - fees + fundingTotal + (upnl - (start.upnl ?? 0));
  const basis = start.equity + Math.max(0, flows);
  return {
    since: start.since, startEquity: start.equity, equity, flows, total, totalPct: basis > 0 ? (total / basis) * 100 : null,
    realized, fees, builderFees, funding: fundingTotal, upnl, explained, residual: total - explained,
    trades, volume, byCoin, unknownLedgerTypes: [...unknown], days: (now - start.since) / 864e5, ts: now,
  };
}

/** The start point: data/pnl.json, created on the first call from the current equity. */
export function pnlStart(equity, upnl, asOf = Date.now()) {
  const s = readJson(PATHS.pnl, null);
  if (s?.since > 0 && s.equity > 0) return s;
  const fresh = { since: asOf, equity, upnl, note: "P&L start point. Edit since/equity to re-base." };
  writeJson(PATHS.pnl, fresh);
  return fresh;
}

/**
 * P&L as of `asOf`, the moment `equity`/`upnl` were read. Fills, funding and flows are bounded to
 * the same moment, so this cycle's own orders (sent after the snapshot) count next cycle, when the
 * equity reflects them too; otherwise a close would be counted both as realized and as stale uPnL.
 */
export async function fetchPnl(info, owner, { equity, upnl, unified, asOf = Date.now() }) {
  const start = pnlStart(equity, upnl, asOf);
  const ranged = (method, extra = {}) => (s, e) => info[method]({ user: owner, startTime: s, endTime: e, ...extra });
  const [fills, funding, ledger] = await Promise.all([
    pageByTime(ranged("userFillsByTime"), start.since, asOf, (f) => `${f.tid}:${f.oid}`),
    pageByTime(ranged("userFunding"), start.since, asOf, (x) => `${x.time}:${x.hash}:${x.delta?.coin}`),
    pageByTime(ranged("userNonFundingLedgerUpdates"), start.since, asOf, (x) => `${x.time}:${x.hash}:${x.delta?.type}`),
  ]);
  return { ...summarize({ fills, funding, ledger, owner, unified, start, equity, upnl, now: asOf }), asOf };
}
