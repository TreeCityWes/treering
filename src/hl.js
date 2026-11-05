import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import { SIGNAL_URL, X1_BUILDER } from "./config.js";

export function makeClients({ owner, key, network }) {
  const account = privateKeyToAccount(key);
  if (account.address.toLowerCase() === owner.toLowerCase())
    throw new Error("X1_AGENT_PRIVATE_KEY is the owner key. Use a trading-only API wallet key.");
  const isTestnet = network === "testnet";
  const transport = new HttpTransport({ isTestnet, timeout: 15_000 });
  return { agent: account.address, info: new InfoClient({ transport }), exchange: new ExchangeClient({ transport, wallet: account, isTestnet }) };
}

/** asset id + size decimals for each configured market (xyz = HIP-3 builder dex). */
export async function loadMarkets(info, coins) {
  const dexes = [...new Set(coins.map((c) => (c.includes(":") ? c.split(":")[0] : "")))];
  const perpDexs = await info.perpDexs();
  const out = {};
  for (const dex of dexes) {
    const meta = await info.meta(dex ? { dex } : undefined);
    const dexIdx = dex ? perpDexs.findIndex((d) => d?.name === dex) : 0;
    if (dex && dexIdx < 1) throw new Error(`Unknown perp dex ${dex}`);
    meta.universe.forEach((u, i) => {
      if (!coins.includes(u.name)) return;
      if (u.isDelisted) throw new Error(`${u.name} is delisted`);
      out[u.name] = { asset: dex ? 100000 + dexIdx * 10000 + i : i, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage, dex };
    });
  }
  const missing = coins.filter((c) => !out[c]);
  if (missing.length) throw new Error(`Markets not found on Hyperliquid: ${missing.join(", ")}`);
  return out;
}

export async function fetchSignal() {
  const res = await fetch(SIGNAL_URL, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Signal API HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.coins)) throw new Error("Signal API returned no coins");
  const coins = data.coins
    .filter((c) => c && typeof c.coin === "string" && (c.score === null || (Number.isFinite(c.score) && Math.abs(c.score) <= 100)))
    .map((c) => ({ coin: c.coin, score: c.score, label: c.label, tradersLong: c.tradersLong, tradersShort: c.tradersShort, history: Array.isArray(c.history) ? c.history.map((h) => h[1]).filter(Number.isFinite) : [] }));
  const ts = data.ts ?? data.timestamp ?? data.now;
  return { coins, timestamp: typeof ts === "number" ? ts : null };
}

/** Everything a cycle needs about the owner account, read with public info calls. */
export async function snapshot(info, owner, markets) {
  // Main and xyz clearinghouses are always read: equity spans both, like the hosted executor.
  const dexes = [...new Set(["", "xyz", ...Object.values(markets).map((m) => m.dex)])];
  const [mode, spot, agents, maxFee, ...rest] = await Promise.all([
    info.userAbstraction({ user: owner }),
    info.spotClearinghouseState({ user: owner }),
    info.extraAgents({ user: owner }),
    info.maxBuilderFee({ user: owner, builder: X1_BUILDER.b }),
    ...dexes.map((dex) => info.clearinghouseState(dex ? { user: owner, dex } : { user: owner })),
    ...dexes.map((dex) => info.allMids(dex ? { dex } : undefined)),
  ]);
  const states = Object.fromEntries(dexes.map((d, i) => [d, rest[i]]));
  const mids = {};
  dexes.forEach((d, i) => Object.assign(mids, rest[dexes.length + i]));
  const main = states[""], xyz = states.xyz;
  const allPositions = Object.values(states).flatMap((s) => s.assetPositions.map((p) => p.position));
  const positions = {};
  for (const p of allPositions) positions[p.coin] = { szi: Number(p.szi), entryPx: Number(p.entryPx), upnl: Number(p.unrealizedPnl), value: Number(p.positionValue) };
  const current = {};
  for (const [coin, p] of Object.entries(positions)) current[coin] = p.szi * (Number(mids[coin]) || p.value / Math.abs(p.szi) || 0);
  const usdcSpot = Number(spot.balances.find((b) => b.coin === "USDC")?.total ?? 0);
  const upnl = allPositions.reduce((n, p) => n + Number(p.unrealizedPnl), 0);
  let equity;
  if (mode === "unifiedAccount") equity = usdcSpot + upnl;
  else equity = Number(main.marginSummary.accountValue) + Number(xyz?.marginSummary.accountValue ?? 0);
  return {
    mode, equity, positions, current,
    mids: Object.fromEntries(Object.keys(markets).map((c) => [c, Number(mids[c])])),
    spot: spot.balances.map((b) => ({ coin: b.coin, total: Number(b.total) })).filter((b) => b.total > 0),
    agents: agents.map((a) => ({ name: a.name, address: a.address, validUntil: a.validUntil })),
    builderFeeUnits: maxFee,
  };
}

export async function sendOrders(exchange, orders, builderFee) {
  const req = { orders: orders.map((o) => o.wire), grouping: "na" };
  if (builderFee) req.builder = X1_BUILDER;
  // The SDK throws when any order in the batch is rejected; Hyperliquid still processes the others.
  // Turn that into per-order results so one rejection never aborts the cycle (or the stop sync).
  let statuses;
  try { statuses = (await exchange.order(req)).response?.data?.statuses ?? []; }
  catch (e) {
    statuses = e?.response?.response?.data?.statuses;
    if (!Array.isArray(statuses)) return orders.map((o) => ({ coin: o.coin, tag: o.tag, error: e.message ?? String(e) }));
  }
  return statuses.map((s, i) => ({
    coin: orders[i].coin, tag: orders[i].tag,
    ...(s.filled ? { filled: Number(s.filled.totalSz), avgPx: Number(s.filled.avgPx) } : {}),
    ...(s.resting ? { resting: s.resting.oid } : {}),
    ...(s.error ? { error: s.error } : {}),
  }));
}
