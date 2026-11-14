#!/usr/bin/env node
// P&L report: live breakdown from Hyperliquid since the start point, plus trading activity from
// the cycle history.   node src/report.js [--json]
import { loadOwner, loadConfig, PATHS } from "./config.js";
import { makeInfo, loadMarkets, snapshot } from "./hl.js";
import { readState, readJson } from "./control.js";
import { paperSummary } from "./paper.js";
import { fetchPnl } from "./ledger.js";
import { readHistory } from "./history.js";

const json = process.argv.includes("--json");
// Read-only: needs the owner address, never the agent key. Falls back to the address the bot last ran with.
const cfg = loadConfig();
const creds = loadOwner() ?? (readState()?.owner ? { owner: readState().owner, network: readState().network } : null);
if (!creds) { console.error("No account address: set X1_ACCOUNT_ADDRESS or run the bot once."); process.exit(1); }
const info = makeInfo(creds.network ?? cfg.network);
const markets = await loadMarkets(info, cfg.markets);
const snap = await snapshot(info, creds.owner, markets);
const upnl = Object.values(snap.positions).reduce((n, p) => n + (p.upnl || 0), 0);
const p = await fetchPnl(info, creds.owner, { equity: snap.equity, upnl, unified: snap.mode === "unifiedAccount", persist: false });
for (const [c, x] of Object.entries(p.byCoin)) x.upnl = snap.positions[c]?.upnl ?? 0;

const hist = readHistory(p.since);
const activity = {
  cycles: hist.length,
  firstRecord: hist[0] ? new Date(hist[0].ts).toISOString() : null,
  cyclesWithOrders: hist.filter((h) => h.fills?.length).length,
  smallSkips: hist.reduce((n, h) => n + Object.values(h.plan ?? {}).filter((r) => r.small).length, 0),
  flipHolds: hist.reduce((n, h) => n + Object.values(h.plan ?? {}).filter((r) => r.flipHeld).length, 0),
  errors: hist.filter((h) => h.error).length,
  maxEquity: hist.length ? hist.reduce((m, h) => Math.max(m, h.equity ?? -Infinity), -Infinity) : null,
  minEquity: hist.length ? hist.reduce((m, h) => Math.min(m, h.equity ?? Infinity), Infinity) : null,
};

const paper = readJson(PATHS.paper, null);
const board = paper ? paperSummary(paper) : null;

if (json) { console.log(JSON.stringify({ pnl: p, activity, paper: board && { startTs: paper.startTs, startEquity: paper.startEquity, actual: snap.equity - paper.startEquity, rows: board } }, null, 2)); process.exit(0); }
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
if (activity.cycles) console.log(`  history: ${activity.cycles} cycles since ${activity.firstRecord.slice(0, 16)}, ${activity.cyclesWithOrders} traded, ${activity.smallSkips} small trades skipped, ${activity.flipHolds} weak flips held, ${activity.errors} errors, equity range $${activity.minEquity.toFixed(2)}–$${activity.maxEquity.toFixed(2)}`);
else console.log("  history: no cycle records yet (data/history/ fills in as the bot runs)");

if (board) {
  const days = (Date.now() - paper.startTs) / 864e5;
  console.log(`\nPaper scoreboard since ${new Date(paper.startTs).toISOString().replace("T", " ").slice(0, 16)} UTC (${days.toFixed(1)} days), every row starting from the live account at $${paper.startEquity.toFixed(2)}`);
  console.log("(paper fills at mid plus fees; stops on 1-minute highs/lows; no funding. \"current rules\" vs actual shows the model's error)\n");
  const pw = [32, 9, 8, 7, 7, 6, 7];
  console.log("  " + row(["rules", "change", "fees", "trades", "stops", "open", "max dd"], pw));
  console.log("  " + row(["actual account", $(snap.equity - paper.startEquity), "", "", "", "", ""], pw));
  for (const x of board) console.log("  " + row([x.label, $(x.change), $(-x.fees), x.trades, x.stopsHit, x.positions, `${(x.maxDD * 100).toFixed(1)}%`], pw));
}
