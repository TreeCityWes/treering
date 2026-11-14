// Append-only record of every cycle, one JSON line each, in data/history/YYYY-MM-DD.jsonl (UTC).
// It keeps what a later backtest or review needs: the full Mood Ring reading (all coins, not only
// traded ones), positions, prices, targets, orders, fills, stops and P&L. ~6 KB per cycle,
// about 1.7 MB a day at the default 5-minute interval.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PATHS, DEADBAND, FILE_MODE, DIR_MODE } from "./config.js";

const r = (v, d = 6) => (Number.isFinite(v) ? Number(v.toFixed(d)) : v ?? null);

export function historyRecord(out) {
  return {
    ts: out.ts, v: 1, reason: out.reason, live: out.live, paused: out.paused, durationMs: out.durationMs, mode: out.mode ?? null,
    // The settings in force, so a later replay knows what produced each decision.
    cfg: out.cfg ? { leverage: out.cfg.leverage, markets: out.cfg.markets, killPct: out.cfg.killPct, maxDrawdownPct: out.cfg.maxDrawdownPct, minOrderUsd: out.cfg.minOrderUsd, slippage: out.cfg.slippage, deadband: DEADBAND, rebalance: out.cfg.rebalance, flipMinScore: out.cfg.flipMinScore, smoothHours: out.cfg.smoothHours, stops: out.cfg.stops, builderFee: out.cfg.builderFee } : null,
    equity: r(out.equity, 4), dayStart: r(out.dayStart, 4), dayPnl: r(out.dayPnl, 4), killed: out.killed ?? null,
    pnl: out.pnl ? { total: r(out.pnl.total, 4), realized: r(out.pnl.realized, 4), fees: r(out.pnl.fees, 4), funding: r(out.pnl.funding, 4), upnl: r(out.pnl.upnl, 4), residual: r(out.pnl.residual, 4), ...(out.pnlError ? { error: out.pnlError } : {}), ...(out.pnl.stale ? { stale: true } : {}) } : null,
    signalTs: out.signal?.timestamp ?? null, ...(out.signalError ? { signalError: out.signalError } : {}),
    peakEquity: r(out.peakEquity, 4), ...(out.drawdownStop ? { drawdownStop: out.drawdownStop } : {}),
    signal: out.signal?.coins ?? null,
    // Traded markets plus every other coin in the signal, so untraded markets can be backtested too.
    mids: out.mids ? { ...(out.signalMids ?? {}), ...Object.fromEntries(out.cfg.markets.filter((c) => out.mids[c] != null).map((c) => [c, Number(out.mids[c])])) } : null,
    positions: out.positions ? Object.fromEntries(Object.entries(out.positions).filter(([, p]) => p.szi).map(([c, p]) => [c, { szi: p.szi, entryPx: p.entryPx, upnl: r(p.upnl, 4), value: r(p.value, 4) }])) : null,
    plan: out.rows?.length ? Object.fromEntries(out.rows.map((x) => [x.coin, { score: x.score, current: r(x.current, 2), target: r(x.target, 2), actions: x.actions, ...(x.small ? { small: true } : {}), ...(x.flipHeld ? { flipHeld: true } : {}), ...(x.noResize ? { noResize: true } : {}) }])) : null,
    orders: out.orders?.map((o) => ({ coin: o.coin, tag: o.tag, isBuy: o.isBuy, sz: o.sz, px: o.px })) ?? [],
    fills: out.fills?.map((f) => ({ coin: f.coin, tag: f.tag, filled: f.filled ?? null, avgPx: f.avgPx ?? null, error: f.error ?? null })) ?? [],
    stops: out.stops?.map((s) => ({ coin: s.coin, side: s.side, size: s.size, entry: s.entry, stopPx: s.stopPx ?? null, best: s.best ?? null, armed: !!s.armed, status: s.status })) ?? null,
    stopEvents: out.stopEvents?.length ? out.stopEvents : null,
    blocks: out.blocks && Object.keys(out.blocks).length ? out.blocks : null,
    // Paper scoreboard: each alternative rule set's equity this cycle (see paper.js).
    ...(out.paper ? { paper: Object.fromEntries(out.paper.map((p) => [p.id, r(p.equity, 4)])) } : {}),
    skip: out.skip, error: out.error,
  };
}

export function recordCycle(out) {
  mkdirSync(PATHS.history, { recursive: true, mode: DIR_MODE });
  const day = new Date(out.ts).toISOString().slice(0, 10);
  appendFileSync(join(PATHS.history, `${day}.jsonl`), JSON.stringify(historyRecord(out)) + "\n", { mode: FILE_MODE });
}

/** Read records back (for reports and backtests), optionally from a start time. */
export function readHistory(since = 0) {
  if (!existsSync(PATHS.history)) return [];
  const sinceDay = new Date(since).toISOString().slice(0, 10);
  return readdirSync(PATHS.history).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) >= sinceDay).sort()
    .flatMap((f) => readFileSync(join(PATHS.history, f), "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }))
    .filter((x) => x.ts >= since);
}
