#!/usr/bin/env node
// Mood Ring bot: every cycle, read the public Mood Ring scores, size targets, and
// trade the owner account through a trading-only API wallet. Dry-run until `live` is on.
import { ALL_MARKETS, PATHS, loadConfig, loadCredentials, ensureDataDir } from "./config.js";
import { makeClients, loadMarkets, fetchSignal, snapshot, sendOrders } from "./hl.js";
import { targetRows, buildOrders, drawdownCheck, formatSize, formatPrice } from "./strategy.js";
import { readControl, updateControl, readState, readJson, writeJson, logEvent } from "./control.js";
import { detectStopFills, syncStops, cancelAllStops } from "./stops.js";
import { X1_BUILDER } from "./config.js";
import { notify, alertsEnabled, alertState, saveAlertState, money } from "./alerts.js";
import { fetchPnl } from "./ledger.js";
import { recordCycle } from "./history.js";

const once = process.argv.includes("--once");
const MIN_EQUITY = 15;
const say = (msg, extra = {}) => { const e = logEvent({ msg, ...extra }); console.log(`${new Date(e.ts).toISOString()} ${msg}`); };

ensureDataDir();
const cfg = loadConfig();
const creds = loadCredentials();
const network = creds.network ?? cfg.network;
const { info, exchange, agent } = makeClients({ ...creds, network });
const markets = await loadMarkets(info, ALL_MARKETS);
let state = readState() ?? {};
// Stop book: trail state, resting stop oids, re-entry blocks. Persisted across restarts.
const book = { trail: {}, oids: {}, blocks: {}, ...readJson(PATHS.stops, {}) };
const saveBook = () => writeJson(PATHS.stops, book);
const A = alertState();
// Keys that belonged to the watchdog when it shared this file; it has its own state file now.
delete A.watchdogDown; delete A.diskHigh;

function dailySummary(prev, out) {
  const pnl = (prev.equity ?? 0) - (prev.dayStart ?? prev.equity ?? 0), pct = prev.dayStart ? (pnl / prev.dayStart) * 100 : 0;
  const pos = Object.entries(out.positions ?? {}).filter(([, p]) => Math.abs(p.szi) > 0)
    .map(([c, p]) => `${c} ${p.szi > 0 ? "long" : "short"} ${money(Math.abs(p.value ?? 0))} (uPnL ${money(p.upnl, true)})`);
  const stops = (out.stops ?? []).filter((x) => x.status === "resting").length;
  const p = out.pnl ?? prev.pnl;
  const since = p ? `Since ${new Date(p.since).toISOString().slice(0, 10)}: ${money(p.total, true)}${p.totalPct != null ? ` (${p.totalPct >= 0 ? "+" : ""}${p.totalPct.toFixed(2)}%)` : ""} · realized ${money(p.realized, true)} · fees ${money(-p.fees, true)} (X1 ${money(-p.builderFees, true)}) · funding ${money(p.funding, true)} · open ${money(p.upnl, true)} · ${p.trades} fills` : null;
  return [`📊 Treering daily summary for ${prev.day} (UTC)`, `Equity ${money(prev.dayStart)} → ${money(prev.equity)}  (${money(pnl, true)}, ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`,
    `Mode: ${out.live ? "LIVE" : "dry-run"}${out.paused ? ", paused" : ""}`, pos.length ? `Positions:\n${pos.join("\n")}` : "No open positions", `Stops resting: ${stops}/${pos.length}`, since].filter(Boolean).join("\n");
}

async function alertsFor(prev, out, stopEvents) {
  if (!alertsEnabled()) return;
  const msgs = [];
  for (const e of stopEvents) msgs.push(`🛑 ${e.msg}`);
  if (prev.live !== undefined && prev.live !== out.live) msgs.push(out.live ? "🔴 LIVE trading turned ON" : "⚪ Live trading turned OFF (dry-run). Open positions keep their stops.");
  if (out.drawdownStop) msgs.push(`🛑 Drawdown stop: equity ${money(out.drawdownStop.equity)} is ${(out.drawdownStop.pct * 100).toFixed(1)}% below its peak ${money(out.drawdownStop.peak)}. The bot is PAUSED; open positions keep their stop-losses. Resume from the dashboard (p) when you have looked. A withdrawal can also trigger this.`);
  else if (prev.paused !== undefined && prev.paused !== out.paused) msgs.push(out.paused ? "⏸ Bot paused" : "▶ Bot resumed");
  if (out.fills?.length) msgs.push(`${out.fills.some((f) => f.error) ? "⚠️ Some orders were rejected" : "✅ Sent"} ${out.fills.length} order(s) · equity ${money(out.equity)}\n` + out.fills.map((f) => `${f.tag} ${f.coin}: ${f.error ? `ERROR ${f.error}` : f.filled ? `filled ${f.filled} @ ${f.avgPx}` : "not filled"}`).join("\n"));
  if (out.error) {
    if (!A.errorSince) { A.errorSince = out.ts; A.errorCount = 1; msgs.push(`⚠️ Cycle error: ${out.error}`); }
    else if (++A.errorCount === 6) msgs.push(`⚠️ Still failing after 6 cycles (~30 min): ${out.error}`);
  } else if (A.errorSince) { msgs.push(`✅ Recovered after ${A.errorCount} failed cycle(s)`); delete A.errorSince; delete A.errorCount; }
  if (out.killed && !prev.killed) msgs.push(`🛑 Daily loss stop hit: equity ${money(out.equity)} (${money(out.dayPnl, true)} today). Only reductions until UTC midnight.`);
  const stale = /signal (stale|unavailable)/.test(out.skip ?? "");
  if (stale && !A.stale) { A.stale = true; msgs.push(`⚠️ Mood Ring signal problem, so the bot is not trading (${out.skip}). Stop-losses stay in place.`); }
  else if (!stale && A.stale && !out.error) { A.stale = false; msgs.push("✅ Signal is fresh again; trading resumed"); }
  const today = new Date().toISOString().slice(0, 10);
  if (out.agentValidUntil) {
    const d = (out.agentValidUntil - Date.now()) / 864e5;
    if (d < 7 && A.expiryWarned !== today) { A.expiryWarned = today; msgs.push(`⏳ API wallet expires in ${Math.max(0, d).toFixed(1)} days. Authorize a new one on X1 Terminal's /API page and update .env.agent, or trading stops.`); }
  }
  const held = Object.values(out.positions ?? {}).filter((p) => Math.abs(p.szi) > 0).length;
  const resting = (out.stops ?? []).filter((x) => x.status === "resting").length;
  const missing = !out.error && held > 0 && cfg.stops.enabled && resting < held;
  if (missing && !A.stopsMissing) { A.stopsMissing = true; msgs.push(`⚠️ Only ${resting}/${held} positions have a stop-loss resting on the exchange`); }
  else if (!missing && A.stopsMissing && !out.error) { A.stopsMissing = false; msgs.push(`✅ All ${held} positions have resting stops again`); }
  if (prev.day && out.day && prev.day !== out.day) msgs.push(dailySummary(prev, out));
  // P&L that doesn't reconcile means an untracked flow (a spot sale, a transfer type we don't parse) or a bug.
  const p = out.pnl;
  if (p && !out.pnlError && Math.abs(p.residual) > Math.max(1, 0.01 * p.equity) && A.pnlWarned !== today) {
    A.pnlWarned = today;
    msgs.push(`⚠️ P&L doesn't reconcile: equity change ${money(p.total, true)} vs fills/fees/funding/open ${money(p.explained, true)} (gap ${money(p.residual, true)}).${p.unknownLedgerTypes.length ? ` Unparsed ledger types: ${p.unknownLedgerTypes.join(", ")}.` : ""} Check for transfers or spot trades.`);
  }
  saveAlertState(A);
  for (const m of msgs) await notify(m);
}
let stopping = false;
let warnedNoHistory = false;

function flattenOrders(snap) {
  return Object.entries(snap.positions).filter(([coin, p]) => markets[coin] && p.szi !== 0).map(([coin, p]) => {
    const m = markets[coin], mid = snap.mids[coin] || Math.abs(p.value / p.szi), isBuy = p.szi < 0;
    const px = formatPrice(isBuy ? mid * (1 + cfg.slippage) : mid * (1 - cfg.slippage), m.szDecimals), sz = formatSize(Math.abs(p.szi), m.szDecimals);
    return { coin, tag: "FLATTEN", isBuy, sz, px, ntl: Math.abs(p.szi) * mid, reduceOnly: true, wire: { a: m.asset, b: isBuy, p: px, s: sz, r: true, t: { limit: { tif: "Ioc" } } } };
  });
}

async function cycle(reason) {
  const ctl = readControl();
  const started = Date.now();
  const stopEvents = [];
  const out = { ts: started, pid: process.pid, network, owner: creds.owner, agent, live: ctl.live, paused: ctl.paused, reason, cfg, skip: null, error: null, pnl: null, pnlError: null, rows: [], orders: [], fills: [] };
  try {
    // A failed signal fetch must not fail the cycle: stop upkeep, flatten and P&L do not need it.
    const [snap, sig] = await Promise.all([snapshot(info, creds.owner, markets), fetchSignal().then((s) => ({ s }), (e) => ({ err: e?.message ?? String(e) }))]);
    const signal = sig.s ?? null;
    const snapAt = Date.now();
    const me = snap.agents.find((a) => a.address.toLowerCase() === agent.toLowerCase());
    const day = new Date().toISOString().slice(0, 10);
    const dayStart = state.day === day && state.dayStart > 0 ? state.dayStart : snap.equity;
    const dayPnl = snap.equity - dayStart;
    const killed = dayStart > 0 && dayPnl <= -cfg.killPct * dayStart;
    // Drawdown stop: pause once equity is maxDrawdownPct below its high-water mark, then re-base the
    // mark so that resuming does not trip it again at once.
    const dd = drawdownCheck(state.peakEquity, snap.equity, cfg.maxDrawdownPct);
    let peakEquity = dd.peak;
    if (dd.hit && !ctl.paused && !ctl.flatten) {
      updateControl({ paused: true }); ctl.paused = true; out.paused = true;
      out.drawdownStop = { peak: dd.peak, equity: snap.equity, pct: dd.dd };
      peakEquity = snap.equity;
      say(`drawdown stop: equity $${snap.equity.toFixed(2)} is ${(dd.dd * 100).toFixed(1)}% below its peak $${dd.peak.toFixed(2)}; bot paused`, { kind: "control" });
    }
    // Prices for every coin in the signal, traded or not, so history can be used to test other markets.
    const signalMids = Object.fromEntries((signal?.coins ?? []).map((c) => [c.coin, Number(snap.allMids[c.coin])]).filter(([, v]) => v > 0));
    Object.assign(out, {
      mode: snap.mode, equity: snap.equity, day, dayStart, dayPnl, killed, peakEquity, drawdown: dd.dd, spot: snap.spot, positions: snap.positions, mids: snap.mids, signalMids,
      agentValidUntil: me?.validUntil ?? null, builderFeeOk: snap.builderFeeUnits >= 50, signalError: sig.err ?? null,
      // Left unset when the fetch failed, so the saved state keeps the last good reading.
      ...(signal ? { signal: { timestamp: signal.timestamp, timestampFrom: signal.timestampFrom, coins: signal.coins.map(({ history, ...c }) => c) } } : {}),
    });
    if (signal?.timestampFrom === "server" && !warnedNoHistory) { warnedNoHistory = true; say("signal carries no history timestamps; the freshness check falls back to the server clock", { kind: "control" }); }
    const signalAge = signal?.timestamp ? (Date.now() - signal.timestamp) / 1000 : Infinity;
    const sc = cfg.stops;
    // Without a fresh signal, stop fills are still detected (scored with the last known reading) but no block is lifted.
    if (sc.enabled) for (const e of await detectStopFills({ info, owner: creds.owner, book, positions: snap.positions, signal: signal ?? state.signal ?? { coins: [] }, sc, now: Date.now(), canRelease: !!signal })) { say(e.msg, e); if (e.stop) stopEvents.push(e); }
    out.stopEvents = stopEvents;
    // No signal: every score is unknown, so every row holds.
    out.rows = targetRows({ equity: snap.equity, cfg, signal: signal ?? { coins: [] }, current: snap.current, killed });
    // Re-entry block: a coin whose stop fired is not re-opened until its signal changes.
    for (const r of out.rows) if (book.blocks[r.coin]) Object.assign(r, { target: r.current, gap: 0, actions: ["BLOCKED"], blocked: book.blocks[r.coin] });

    if (ctl.flatten) out.orders = flattenOrders(snap);
    else out.orders = buildOrders(out.rows, { markets, mids: snap.mids, positions: snap.positions, slippage: cfg.slippage, minOrderUsd: cfg.minOrderUsd });

    if (!me || me.validUntil <= Date.now()) out.skip = "API wallet not authorized or expired";
    else if (cfg.builderFee && !out.builderFeeOk) out.skip = "builder fee not approved";
    else if (!ctl.flatten && !signal) out.skip = `signal unavailable (${sig.err})`;
    else if (!ctl.flatten && signalAge > cfg.maxSignalAgeSec) out.skip = `signal stale (${Math.round(signalAge)}s old)`;
    else if (!ctl.flatten && snap.equity < MIN_EQUITY) out.skip = `equity $${snap.equity.toFixed(2)} below $${MIN_EQUITY}`;
    else if (ctl.paused && !ctl.flatten) out.skip = "paused";
    else if (!out.orders.length) out.skip = "no orders needed";

    if (!out.skip && !ctl.live) out.skip = "dry-run (live is off)";
    if (!out.skip) {
      out.fills = await sendOrders(exchange, out.orders, cfg.builderFee);
      for (const f of out.fills) say(`${f.tag} ${f.coin}: ${f.error ? `ERROR ${f.error}` : f.filled ? `filled ${f.filled} @ ${f.avgPx}` : "not filled"}`, { kind: "fill", ...f });
    }
    // Stop sync: every open position gets one resting stop on the exchange (after this cycle's fills).
    const approved = me && me.validUntil > Date.now();
    if (ctl.flatten && !out.skip && approved) {
      const n = await cancelAllStops({ info, exchange, owner: creds.owner, markets });
      book.trail = {}; book.oids = {};
      if (n) say(`flatten: cancelled ${n} resting stop(s)`, { kind: "control" });
    } else if (sc.enabled && approved) {
      // After fills, Hyperliquid's account view can lag by a moment. Re-read until every filled coin's
      // size has changed from the pre-trade snapshot (up to ~6s), so stops are sized to the new position.
      let positions = snap.positions;
      const filled = out.fills.filter((f) => f.filled > 0).map((f) => f.coin);
      for (let i = 0; filled.length && i < 6; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        positions = (await snapshot(info, creds.owner, markets)).positions;
        if (filled.every((c) => (positions[c]?.szi ?? 0) !== (snap.positions[c]?.szi ?? 0))) break;
      }
      const send = ctl.live || sc.whenNotLive;
      const res = await syncStops({ info, exchange, owner: creds.owner, markets, book, positions, mids: snap.mids, sc, send, builder: cfg.builderFee ? X1_BUILDER : null });
      out.stops = res.rows;
      for (const e of res.events) say(e.msg, e);
    }
    out.blocks = book.blocks;
    saveBook();
    // Running P&L since the start point in data/pnl.json. A failure here never fails the cycle.
    try {
      const upnl = Object.values(snap.positions).reduce((n, p) => n + (p.upnl || 0), 0);
      out.pnl = await fetchPnl(info, creds.owner, { equity: snap.equity, upnl, unified: snap.mode === "unifiedAccount", asOf: snapAt });
    } catch (e) { out.pnlError = e.message ?? String(e); out.pnl = state.pnl ? { ...state.pnl, stale: true } : null; }
    if (ctl.flatten) { updateControl({ flatten: false, paused: true }); out.paused = true; say(out.skip ? `flatten requested but not sent: ${out.skip}` : "flatten done; bot paused", { kind: "control" }); }
    say(`cycle: equity $${snap.equity.toFixed(2)}, ${out.orders.length} order(s)${out.skip ? `, not sent: ${out.skip}` : ", sent"}`, { kind: "cycle", equity: snap.equity, orders: out.orders.length, skip: out.skip, live: ctl.live });
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
    if (creds.key) out.error = out.error.replaceAll(creds.key, "[REDACTED]");
    say(`cycle error: ${out.error}`, { kind: "error" });
  }
  out.durationMs = Date.now() - started;
  out.nextCycleAt = once ? null : Date.now() + cfg.intervalSec * 1000;
  const prev = state;
  state = { ...state, ...out, day: out.day ?? state.day, dayStart: out.dayStart ?? state.dayStart, pnl: out.pnl ?? state.pnl ?? null };
  writeJson(PATHS.state, state);
  try { recordCycle(out); } catch (e) { console.error(`history: ${e.message}`); }
  await alertsFor(prev, out, stopEvents).catch((e) => console.error(`alerts: ${e.message}`));
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stopping = true; });

say(`treering bot started (${network}, owner ${creds.owner}, agent ${agent}, markets ${cfg.markets.join(" ")})`, { kind: "start" });
if (readControl().live) say("LIVE trading is ON", { kind: "control" });
// Announce starts, but at most once per 10 minutes so a crash loop doesn't flood Telegram.
if (alertsEnabled() && !once && Date.now() - (A.lastStart ?? 0) > 600_000) {
  A.lastStart = Date.now(); saveAlertState(A);
  await notify(`▶ Treering bot started (${network}, ${readControl().live ? "LIVE" : "dry-run"}, markets ${cfg.markets.join(" ")})`);
}
await cycle(once ? "once" : "startup");

while (!once && !stopping) {
  await new Promise((r) => setTimeout(r, 1000));
  const ctl = readControl();
  if (ctl.runNow || ctl.flatten) { updateControl({ runNow: false }); await cycle(ctl.flatten ? "flatten" : "manual"); }
  else if (Date.now() >= state.nextCycleAt) await cycle("schedule");
}
say("treering bot stopped", { kind: "stop" });
if (!once) await notify("■ Treering bot stopped. Open positions keep their resting stop-losses.");
writeJson(PATHS.state, { ...state, pid: null, nextCycleAt: null });
