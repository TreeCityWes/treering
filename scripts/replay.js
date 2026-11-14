#!/usr/bin/env node
// Replay recorded history under different settings and compare the results.
// Read-only: it reads data/history/*.jsonl and, with --candles, public 1-minute price bars from
// Hyperliquid (cached). It never needs the agent key and never sends an order.
//
//   node scripts/replay.js                       built-in variants, stops checked at cycle prices
//   node scripts/replay.js --candles             also trigger stops inside a cycle (more accurate)
//   node scripts/replay.js --variants my.json    your own variants (see BUILTIN below for the shape)
//   node scripts/replay.js --dir /var/lib/treering/history --since 2026-11-08 --json
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PATHS } from "../src/config.js";
import { simulate } from "../src/replay.js";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const flag = (name) => args.includes(`--${name}`);

const dir = opt("dir") ?? (existsSync(PATHS.history) ? PATHS.history : "/var/lib/treering/history");
const since = opt("since") ? Date.parse(opt("since")) : 0;
if (!existsSync(dir)) { console.error(`No history directory at ${dir}. Pass --dir.`); process.exit(1); }

const records = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()
  .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }))
  .filter((r) => r.ts >= since).sort((a, b) => a.ts - b.ts);
if (records.length < 2) { console.error("Not enough history to replay."); process.exit(1); }

// Each variant: { name, cfg: <bot config overrides>, sim: <replay-only options, see SIM_DEFAULTS> }.
const WIDE = { trailArmPct: 0.08, trailPct: 0.08, stopLossPct: 0.12 };
const BUILTIN = [
  { name: "current settings" },
  { name: "raw score (no averaging)", sim: { smoothHours: 0 } },
  { name: "no stops at all", cfg: { stops: { enabled: false } } },
  { name: "hard stop only (no trail)", cfg: { stops: { trailArmPct: 9 } } },
  { name: "no re-entry block", sim: { reentryBlock: false } },
  { name: "ZEC wide stops (8% trail, 12% hard)", sim: { stopsByCoin: { ZEC: WIDE } } },
  { name: "all coins wide stops", cfg: { stops: WIDE } },
  { name: "smooth signal 2h", sim: { smoothHours: 2 } },
  { name: "smooth signal 6h", sim: { smoothHours: 6 } },
  { name: "smooth signal 12h", sim: { smoothHours: 12 } },
  { name: "decide hourly", sim: { decideEverySec: 3600 } },
  { name: "decide every 4h", sim: { decideEverySec: 14400 } },
  // Leverage 2.5 on five markets keeps each coin's size the same as 3 on six.
  { name: "drop HYPE (same size per coin)", cfg: { markets: ["BTC", "ETH", "SOL", "ZEC", "NEAR"], leverage: 2.5 } },
  { name: "flip only at |score| >= 40", cfg: { flipMinScore: 40 } },
  { name: "smooth 6h + ZEC wide + no HYPE", cfg: { markets: ["BTC", "ETH", "SOL", "ZEC", "NEAR"], leverage: 2.5 }, sim: { smoothHours: 6, stopsByCoin: { ZEC: WIDE } } },
];
const variants = opt("variants") ? JSON.parse(readFileSync(opt("variants"), "utf8")) : BUILTIN;

// Public 1-minute candles, so a stop can trigger between two cycles as it does on the exchange.
async function loadCandles(coins, from, to) {
  const cacheDir = opt("cache") ?? join(tmpdir(), "treering-replay-candles");
  mkdirSync(cacheDir, { recursive: true });
  const out = {};
  for (const coin of coins) {
    const file = join(cacheDir, `${coin.replace(/[^A-Za-z0-9]/g, "_")}.json`);
    let bars = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
    let start = bars.length && bars[0].t <= from ? bars.at(-1).t + 60_000 : (bars = [], from - 60_000);
    while (start < to) {
      const res = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval: "1m", startTime: start, endTime: Math.min(to, start + 4000 * 60_000) } }) });
      if (!res.ok) throw new Error(`candles ${coin}: HTTP ${res.status}`);
      const got = (await res.json()).map((c) => ({ t: c.t, h: Number(c.h), l: Number(c.l) })).filter((c) => !bars.length || c.t > bars.at(-1).t);
      if (!got.length) break;
      bars.push(...got);
      start = bars.at(-1).t + 60_000;
    }
    writeFileSync(file, JSON.stringify(bars));
    out[coin] = bars;
  }
  return out;
}

const coins = [...new Set(variants.flatMap((v) => v.cfg?.markets ?? []).concat([...records].reverse().find((r) => r.cfg)?.cfg.markets ?? []))];
let candles = null;
if (flag("candles")) {
  try { candles = await loadCandles(coins, records[0].ts, records.at(-1).ts); }
  catch (e) { console.error(`Could not load candles (${e.message}); stops will be checked at cycle prices only.`); }
}

// The check: the same replay with the settings that were actually in force at each cycle.
const check = simulate(records, { name: "as recorded (model check)", sim: { recordedCfg: true } }, candles);
const results = variants.map((v) => simulate(records, v, candles));

if (flag("json")) { console.log(JSON.stringify({ check, results }, (k, v) => (k === "curve" ? undefined : v), 2)); process.exit(0); }

const $ = (n) => `${n < 0 ? "−" : "+"}$${Math.abs(n).toFixed(2)}`;
const iso = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
const days = (records.at(-1).ts - records[0].ts) / 864e5;
console.log(`Treering replay · ${iso(check.from)} → ${iso(check.to)} UTC (${days.toFixed(1)} days, ${check.cycles} cycles)`);
console.log(`Stops triggered on: ${candles ? "1-minute trade prices" : "cycle mid prices only (add --candles for intra-cycle triggers)"}\n`);
console.log(`Actual result over this window           ${$(check.actualPnl)}`);
console.log(`Replay with the settings then in force   ${$(check.pnl)}   (gap ${$(check.pnl - check.actualPnl)}: how far the model is from reality)\n`);

const base = results[0];
const head = ["variant", "P&L", "vs current", "1st half", "2nd half", "fees", "trades", "stops", "max DD"];
const rows = results.map((r) => [r.name, $(r.pnl), r === base ? "" : $(r.pnl - base.pnl), $(r.firstHalf), $(r.secondHalf), `$${r.fees.toFixed(2)}`, String(r.trades), String(r.stopOuts), `${(r.maxDrawdown * 100).toFixed(1)}%${r.pausedAt ? " ⏸" : ""}`]);
const w = head.map((h, i) => Math.max(h.length, ...rows.map((x) => x[i].length)));
const line = (x) => x.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join("  ");
console.log(line(head)); console.log(w.map((n) => "─".repeat(n)).join("  "));
for (const x of rows) console.log(line(x));
if (results.some((r) => r.pausedAt)) console.log("\n⏸ = the drawdown stop paused the bot during the replay; it stays paused to the end.");

const allCoins = [...new Set(results.flatMap((r) => Object.keys(r.coins)))];
console.log(`\nNet P&L by coin (after fees)\n`);
const ch = ["variant", ...allCoins], cr = results.map((r) => [r.name, ...allCoins.map((c) => (r.coins[c] ? $(r.coins[c].net) : "—"))]);
const cw = ch.map((h, i) => Math.max(h.length, ...cr.map((x) => x[i].length)));
const cl = (x) => x.map((c, i) => (i === 0 ? c.padEnd(cw[i]) : c.padStart(cw[i]))).join("  ");
console.log(cl(ch)); console.log(cw.map((n) => "─".repeat(n)).join("  "));
for (const x of cr) console.log(cl(x));
console.log(`\n${days.toFixed(1)} days is a small sample from one market move. A variant that wins in only one half is probably luck.`);
