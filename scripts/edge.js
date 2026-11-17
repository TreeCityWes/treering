#!/usr/bin/env node
// How often the Mood Ring's direction was right: for every recorded reading past the deadband,
// was the price higher (long) or lower (short) N hours later? Raw reading and 12-hour average.
// Read-only.
//
//   node scripts/edge.js                              all history, split at --split if given
//   node scripts/edge.js --since 2026-11-10 --split 2026-11-14T12:00Z --hours 4,12,24
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PATHS, DEADBAND } from "../src/config.js";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const dir = opt("dir") ?? (existsSync(PATHS.history) ? PATHS.history : "/var/lib/treering/history");
const since = opt("since") ? Date.parse(opt("since")) : 0;
const split = opt("split") ? Date.parse(opt("split")) : null;
const horizons = (opt("hours") ?? "4,12,24").split(",").map(Number);
const avgHours = Number(opt("avg") ?? 12);

const recs = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()
  .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }))
  .filter((r) => Array.isArray(r.signal) && r.mids && r.ts >= since).sort((a, b) => a.ts - b.ts);
if (recs.length < 2) { console.log("Not enough history."); process.exit(0); }
const coins = recs.at(-1).cfg?.markets ?? ["BTC", "ETH", "SOL", "HYPE", "ZEC", "NEAR"];

const hist = {};
const rows = recs.map((r) => {
  const o = { ts: r.ts, mid: {}, raw: {}, avg: {} };
  for (const c of coins) {
    const s = r.signal.find((x) => x.coin === c);
    if (!s || !Number.isFinite(s.score) || !(r.mids[c] > 0)) continue;
    const h = (hist[c] ??= []);
    h.push({ ts: r.ts, v: s.score });
    while (h[0].ts < r.ts - avgHours * 3.6e6) h.shift();
    o.mid[c] = r.mids[c]; o.raw[c] = s.score; o.avg[c] = h.reduce((n, x) => n + x.v, 0) / h.length;
  }
  return o;
});

const periods = split ? [["all", 0, Infinity], [`before ${opt("split")}`, 0, split], [`since ${opt("split")}`, split, Infinity]] : [["all", 0, Infinity]];
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : "-");
console.log(`Mood Ring direction vs price, ${new Date(rows[0].ts).toISOString().slice(0, 16)} → ${new Date(rows.at(-1).ts).toISOString().slice(0, 16)} UTC`);
console.log("right = share of readings past ±15 where price moved that way; move = average signed move\n");
for (const [label, from, to] of periods) {
  console.log(label);
  for (const H of horizons) {
    const res = { raw: { hit: 0, n: 0, mv: 0 }, avg: { hit: 0, n: 0, mv: 0 } };
    let j = 0;
    for (const a of rows) {
      if (a.ts < from || a.ts >= to) continue;
      while (j < rows.length && rows[j].ts < a.ts + H * 3.6e6) j++;
      if (j >= rows.length) break;
      const b = rows[j];
      for (const c of coins) {
        if (!(c in a.raw) || !(c in b.mid)) continue;
        const ret = b.mid[c] / a.mid[c] - 1;
        for (const k of ["raw", "avg"]) {
          const s = a[k][c];
          if (Math.abs(s) < DEADBAND) continue;
          const R = res[k]; R.n++; if (Math.sign(s) === Math.sign(ret)) R.hit++; R.mv += Math.sign(s) * ret * 100;
        }
      }
    }
    const f = (R) => `right ${pct(R.hit, R.n).padStart(4)}  move ${R.n ? (R.mv / R.n).toFixed(2).padStart(5) : "    -"}%`;
    console.log(`  ${String(H).padStart(2)}h ahead   raw: ${f(res.raw)}   ${avgHours}h avg: ${f(res.avg)}`);
  }
}
