// Running P&L since a fixed start point, reconciled against the account's equity.
//   total     = equity − startEquity − net deposits/withdrawals since the start
//   explained = realized − fees + funding + (uPnL now − uPnL at start)
//   residual  = total − explained   (≈0 when everything is accounted for)
// Fees are what Hyperliquid charged on each fill and already include the builder fee.
import { PATHS } from "./config.js";
import { readJson, writeJson } from "./control.js";

const isPerp = (coin) => typeof coin === "string" && !coin.startsWith("@") && !coin.includes("/");

/** Fills since `since`, following Hyperliquid's 2000-per-page limit. */
async function fillsSince(info, owner, since) {
  const out = [], seen = new Set();
  let start = since;
  for (let page = 0; page < 50; page++) {
    const batch = await info.userFillsByTime({ user: owner, startTime: start });
    for (const f of batch) { const k = `${f.tid}:${f.oid}`; if (!seen.has(k)) { seen.add(k); out.push(f); } }
    if (batch.length < 2000) break;
    start = Math.max(...batch.map((f) => f.time));
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
export function pnlStart(equity, upnl) {
  const s = readJson(PATHS.pnl, null);
  if (s?.since > 0 && s.equity > 0) return s;
  const fresh = { since: Date.now(), equity, upnl, note: "P&L start point. Edit since/equity to re-base." };
  writeJson(PATHS.pnl, fresh);
  return fresh;
}

export async function fetchPnl(info, owner, { equity, upnl, unified }) {
  const start = pnlStart(equity, upnl);
  const [fills, funding, ledger] = await Promise.all([
    fillsSince(info, owner, start.since),
    info.userFunding({ user: owner, startTime: start.since }),
    info.userNonFundingLedgerUpdates({ user: owner, startTime: start.since }),
  ]);
  return summarize({ fills, funding, ledger, owner, unified, start, equity, upnl });
}
