import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import { SIGNAL_URL, X1_BUILDER } from "./config.js";

/** Read-only client: public info calls need no key. */
export function makeInfo(network) {
  return new InfoClient({ transport: new HttpTransport({ isTestnet: network === "testnet", timeout: 15_000 }) });
}

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

/**
 * Shape the signal payload. `timestamp` is when the scores were last computed: the newest point in
 * the per-coin history, which the API appends about every 3 minutes. The payload's `now` is only
 * the server clock at request time, so it would look fresh even if the feed had frozen; it is the
 * fallback (`timestampFrom: "server"`) when the payload carries no history.
 */
export function parseSignal(data) {
  if (!Array.isArray(data?.coins)) throw new Error("Signal API returned no coins");
  let dataTs = 0;
  const coins = data.coins
    .filter((c) => c && typeof c.coin === "string" && (c.score === null || (Number.isFinite(c.score) && Math.abs(c.score) <= 100)))
    .map((c) => {
      const hist = Array.isArray(c.history) ? c.history.filter((h) => Array.isArray(h)) : [];
      for (const h of hist) if (Number.isFinite(h[0]) && h[0] > dataTs) dataTs = h[0];
      return { coin: c.coin, score: c.score, label: c.label, tradersLong: c.tradersLong, tradersShort: c.tradersShort,
        posScore: c.posScore, flowScore: c.flowScore, pctLong: c.pctLong, net: c.net, flow1h: c.flow1h, flow24h: c.flow24h, vol24h: c.vol24h, dominantShare: c.dominant?.share,
        history: hist.map((h) => h[1]).filter(Number.isFinite),
        // [timestamp, score] pairs over the last ~24h, for smoothing (see smoothSignal).
        points: hist.filter((h) => Number.isFinite(h[0]) && Number.isFinite(h[1])) };
    });
  const now = data.ts ?? data.timestamp ?? data.now;
  const serverNow = typeof now === "number" ? now : null;
  return { coins, timestamp: dataTs || serverNow, serverNow, timestampFrom: dataTs ? "history" : "server" };
}

export async function fetchSignal() {
  const res = await fetch(SIGNAL_URL, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Signal API HTTP ${res.status}`);
  return parseSignal(await res.json());
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
  let equity;
  // Unified account: the spot USDC total is already marked to market (it includes open perp P&L,
  // realized P&L, fees and funding) and equals the account value Hyperliquid's portfolio reports.
  // Adding unrealized P&L on top would count it twice.
  if (mode === "unifiedAccount") {
    // Never size off a silently-missing balance: a zero here would trip the daily loss stop.
    if (!spot.balances.some((b) => b.coin === "USDC")) throw new Error("unified account has no spot USDC balance; refusing to compute equity");
    equity = usdcSpot;
  }
  else equity = Number(main.marginSummary.accountValue) + Number(xyz?.marginSummary.accountValue ?? 0);
  return {
    mode, equity, positions, current,
    allMids: mids, // every market on the dexes read (raw strings), for recording prices of untraded signal coins
    mids: Object.fromEntries(Object.keys(markets).map((c) => [c, Number(mids[c])])),
    spot: spot.balances.map((b) => ({ coin: b.coin, total: Number(b.total) })).filter((b) => b.total > 0),
    agents: agents.map((a) => ({ name: a.name, address: a.address, validUntil: a.validUntil })),
    builderFeeUnits: maxFee,
  };
}

/**
 * 1-minute candles per coin since `from` (public; empty for a coin whose request failed), for the
 * paper scoreboard's stop check between cycles.
 */
export async function minuteCandles(info, coins, from, to) {
  const res = await Promise.all(coins.map((coin) => info.candleSnapshot({ coin, interval: "1m", startTime: Math.floor(from), endTime: Math.ceil(to) }).catch(() => [])));
  return Object.fromEntries(coins.map((c, i) => [c, res[i]]));
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
