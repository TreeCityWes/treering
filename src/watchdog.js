#!/usr/bin/env node
// Runs from a systemd timer, separate from the bot. Alerts once when the bot stops cycling
// (process gone or no completed cycle for 2 intervals + 2 min), and once when it recovers.
import { readState } from "./control.js";
import { loadConfig } from "./config.js";
import { notify, alertState, saveAlertState, money } from "./alerts.js";

const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const cfg = loadConfig();
const s = readState();
const A = alertState();
const now = Date.now();
const limit = (cfg.intervalSec * 2 + 120) * 1000;
const age = s?.ts ? now - s.ts : Infinity;
const down = !s || !alive(s.pid) || age > limit;
const reason = !s ? "no state file" : !alive(s.pid) ? "bot process is not running" : `no completed cycle for ${Math.round(age / 60000)} min`;

const held = Object.entries(s?.positions ?? {}).filter(([, p]) => Math.abs(p.szi) > 0);
if (down && !A.watchdogDown) {
  A.watchdogDown = now;
  saveAlertState(A);
  await notify([
    `🚨 Treering bot is DOWN: ${reason}.`,
    held.length ? `${held.length} open position(s); their stop-losses stay on the exchange, but nothing is rebalancing.` : "No open positions.",
    s?.equity != null ? `Last equity ${money(s.equity)}.` : "",
    "Check the bot service: systemctl --user status <unit> and its journal.",
  ].filter(Boolean).join("\n"));
} else if (!down && A.watchdogDown) {
  const mins = Math.round((now - A.watchdogDown) / 60000);
  delete A.watchdogDown;
  saveAlertState(A);
  await notify(`✅ Treering bot is cycling again (was down ~${mins} min).`);
}
console.log(down ? `DOWN: ${reason}` : `ok: last cycle ${Math.round(age / 1000)}s ago`);
