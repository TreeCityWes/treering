#!/usr/bin/env node
// P&L report: live breakdown from Hyperliquid since the start point, plus trading activity from
// the cycle history.   node src/report.js [--json]
import { loadCredentials, loadConfig } from "./config.js";
import { makeClients, loadMarkets, snapshot } from "./hl.js";
import { fetchPnl } from "./ledger.js";
import { readHistory } from "./history.js";

const json = process.argv.includes("--json");
const creds = loadCredentials(), cfg = loadConfig();
const { info } = makeClients({ ...creds, network: creds.network ?? cfg.network });
const markets = await loadMarkets(info, cfg.markets);
const snap = await snapshot(info, creds.owner, markets);
const upnl = Object.values(snap.positions).reduce((n, p) => n + (p.upnl || 0), 0);
const p = await fetchPnl(info, creds.owner, { equity: snap.equity, upnl, unified: snap.mode === "unifiedAccount" });
for (const [c, x] of Object.entries(p.byCoin)) x.upnl = snap.positions[c]?.upnl ?? 0;

const hist = readHistory(p.since);
const activity = {
  cycles: hist.length,
  firstRecord: hist[0] ? new Date(hist[0].ts).toISOString() : null,
  cyclesWithOrders: hist.filter((h) => h.fills?.length).length,
  smallSkips: hist.reduce((n, h) => n + Object.values(h.plan ?? {}).filter((r) => r.small).length, 0),
  errors: hist.filter((h) => h.error).length,
  maxEquity: hist.length ? Math.max(...hist.map((h) => h.equity ?? -Infinity)) : null,
  minEquity: hist.length ? Math.min(...hist.map((h) => h.equity ?? Infinity)) : null,
};

if (json) { console.log(JSON.stringify({ pnl: p, activity }, null, 2)); process.exit(0); }
const $ = (v, sign = true) => `${sign && v > 0 ? "+" : v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}`;
const row = (cells, w) => cells.map((c, i) => (i ? String(c).padStart(w[i]) : String(c).padEnd(w[i]))).join("  ");
console.log(`Treering P&L since ${new Date(p.since).toISOString().replace("T", " ").slice(0, 16)} UTC (${p.days.toFixed(1)} days)\n`);
console.log(`  equity     $${p.startEquity.toFixed(2)} → $${p.equity.toFixed(2)}${p.flows ? `   (net deposits ${$(p.flows)})` : ""}`);
console.log(`  total      ${$(p.total)}${p.totalPct != null ? `  (${p.totalPct >= 0 ? "+" : ""}${p.totalPct.toFixed(2)}%)` : ""}\n`);
console.log(`  realized   ${$(p.realized)}`);
console.log(`  fees       ${$(-p.fees)}   (Hyperliquid ${$(-(p.fees - p.builderFees))}, X1 builder ${$(-p.builderFees)})`);
console.log(`  funding    ${$(p.funding)}`);
console.log(`  open       ${$(p.upnl)}`);
console.log(`  unexplained ${$(p.residual)}${Math.abs(p.residual) > Math.max(1, 0.01 * p.equity) ? "   ← check for transfers or spot trades" : ""}\n`);
const w = [6, 10, 9, 9, 9, 10, 6, 9];
console.log("  " + row(["coin", "realized", "fees", "funding", "open", "net", "fills", "volume"], w));
for (const [c, x] of Object.entries(p.byCoin).sort((a, b) => (b[1].realized - b[1].fees + b[1].funding + b[1].upnl) - (a[1].realized - a[1].fees + a[1].funding + a[1].upnl)))
  console.log("  " + row([c, $(x.realized), $(-x.fees), $(x.funding), $(x.upnl), $(x.realized - x.fees + x.funding + x.upnl), x.fills, `$${x.volume.toFixed(0)}`], w));
console.log(`\n  ${p.trades} fills · $${p.volume.toFixed(0)} volume · fees ${((p.fees / (p.volume || 1)) * 100).toFixed(3)}% of volume`);
if (activity.cycles) console.log(`  history: ${activity.cycles} cycles since ${activity.firstRecord.slice(0, 16)}, ${activity.cyclesWithOrders} traded, ${activity.smallSkips} small trades skipped, ${activity.errors} errors, equity range $${activity.minEquity.toFixed(2)}–$${activity.maxEquity.toFixed(2)}`);
else console.log("  history: no cycle records yet (data/history/ fills in as the bot runs)");
