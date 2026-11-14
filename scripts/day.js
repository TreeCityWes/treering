#!/usr/bin/env node
// What the bot did over a stretch of time, from the cycle history. Read-only.
//
//   node scripts/day.js                         the last 24 hours
//   node scripts/day.js --since 2026-11-14T00:00Z --tz America/New_York
//   node scripts/day.js --dir /var/lib/treering/history --every 2
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "../src/config.js";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const dir = opt("dir") ?? (existsSync(PATHS.history) ? PATHS.history : "/var/lib/treering/history");
const since = opt("since") ? Date.parse(opt("since")) : Date.now() - 864e5;
const tz = opt("tz") ?? undefined;
const everyH = Number(opt("every") ?? 2);
if (!Number.isFinite(since)) { console.error("--since must be a date, e.g. 2026-11-14T00:00Z"); process.exit(1); }
if (!existsSync(dir)) { console.error(`No history directory at ${dir}. Pass --dir.`); process.exit(1); }

const sinceDay = new Date(since).toISOString().slice(0, 10);
const recs = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) >= sinceDay).sort()
  .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }))
  .filter((r) => r.ts >= since).sort((a, b) => a.ts - b.ts);
if (!recs.length) { console.log("No cycles in that window."); process.exit(0); }

const t = (ts) => new Date(ts).toLocaleString("en-US", { timeZone: tz, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const $ = (v) => (v == null ? "-" : `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`);
const eq = recs.map((r) => r.equity).filter((v) => v > 0);
const skips = {};
for (const r of recs) if (r.skip) skips[r.skip] = (skips[r.skip] ?? 0) + 1;

console.log(`${recs.length} cycles ${t(recs[0].ts)} → ${t(recs.at(-1).ts)}${tz ? ` (${tz})` : ""}`);
console.log(`errors ${recs.filter((r) => r.error).length}, signal errors ${recs.filter((r) => r.signalError).length}; skipped: ${Object.entries(skips).map(([k, n]) => `${k} ×${n}`).join(", ") || "none"}`);
console.log(`equity $${eq[0].toFixed(2)} → $${eq.at(-1).toFixed(2)} (${$(eq.at(-1) - eq[0])}), low $${Math.min(...eq).toFixed(2)}, high $${Math.max(...eq).toFixed(2)}`);

console.log("\nEvents");
let any = false;
for (const r of recs) {
  for (const e of r.stopEvents ?? []) { any = true; console.log(`  ${t(r.ts)}  ${e.msg ?? JSON.stringify(e)}`); }
  for (const f of r.fills ?? []) { any = true; console.log(`  ${t(r.ts)}  ${f.tag} ${f.coin}: ${f.error ? `ERROR ${f.error}` : f.filled ? `filled ${f.filled} @ ${f.avgPx}` : "not filled"}`); }
  if (r.error) { any = true; console.log(`  ${t(r.ts)}  cycle error: ${r.error}`); }
}
if (!any) console.log("  none");

console.log(`\nEvery ${everyH}h: equity, then score/position $ per traded coin`);
let next = 0;
for (const r of recs) {
  if (r.ts < next) continue;
  next = r.ts + everyH * 3600e3 - 150e3;
  const cells = Object.entries(r.plan ?? {}).map(([c, p]) => `${c} ${p.score ?? "-"}/${Math.round(p.current ?? 0)}`);
  console.log(`  ${t(r.ts)}  $${r.equity?.toFixed(2)}  ${cells.join("  ")}`);
}

const last = recs.at(-1);
console.log(`\nNow (${t(last.ts)})`);
for (const [c, p] of Object.entries(last.positions ?? {})) {
  const s = (last.stops ?? []).find((x) => x.coin === c);
  const locked = s?.stopPx ? p.szi * (s.stopPx - p.entryPx) : null;
  console.log(`  ${c.padEnd(5)} ${p.szi > 0 ? "long " : "short"} $${Math.abs(p.value).toFixed(2)}  open ${$(p.upnl)}  score ${last.plan?.[c]?.score ?? "-"}  stop ${s?.stopPx ?? "-"}${s?.armed ? " (trailing)" : ""}  if stopped ${$(locked)}`);
}
if (!Object.keys(last.positions ?? {}).length) console.log("  flat");
const blocks = Object.entries(last.blocks ?? {});
if (blocks.length) console.log(`  re-entry blocked: ${blocks.map(([c, b]) => `${c} (${b.side > 0 ? "long" : "short"} stopped ${t(b.at)})`).join(", ")}`);
console.log(`  day P&L ${$(last.dayPnl)}, peak $${last.peakEquity?.toFixed(2)}${last.pnl ? `, since start ${$(last.pnl.total)}` : ""}`);
if (last.paper) console.log(`  paper: ${Object.entries(last.paper).map(([k, v]) => `${k} $${v.toFixed(2)}`).join(", ")}`);
