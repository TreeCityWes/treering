#!/usr/bin/env node
// Runs from a systemd timer, separate from the bot. Alerts once when the bot stops cycling
// (process gone or no completed cycle for 2 intervals + 2 min), and once when it recovers.
import { readState, readJson, writeJson } from "./control.js";
import { statfsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, DATA_DIR } from "./config.js";
import { notify, money } from "./alerts.js";

// The watchdog keeps its own state file. It used to share alerts.json with the bot, which loads that
// file once and rewrites it every cycle: a flag set here just before a bot start was picked up by
// the bot and written back after every clear, so the "cycling again" message repeated every run.
const WD_STATE = join(DATA_DIR, "watchdog.json");
const alertState = () => readJson(WD_STATE, {});
const saveAlertState = (s) => writeJson(WD_STATE, s);

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
    "Check the bot service with systemctl status and its journal.",
  ].filter(Boolean).join("\n"));
} else if (!down && A.watchdogDown) {
  const mins = Math.round((now - A.watchdogDown) / 60000);
  delete A.watchdogDown;
  saveAlertState(A);
  await notify(`✅ Treering bot is cycling again (was down ~${mins} min).`);
}

// Disk space: a full disk stops state/history writes. Alert at 85% used, all-clear below 80%.
let disk = "";
try {
  const st = statfsSync(DATA_DIR);
  const used = 1 - st.bavail / st.blocks, freeGb = (st.bavail * st.bsize) / 1e9;
  disk = ` · disk ${(used * 100).toFixed(0)}% used`;
  const B = alertState();
  if (used >= 0.85 && !B.diskHigh) {
    B.diskHigh = now; saveAlertState(B);
    await notify(`💾 Disk is ${(used * 100).toFixed(0)}% full (${freeGb.toFixed(1)} GB free). The bot stops saving state and history if it fills up.`);
  } else if (used < 0.8 && B.diskHigh) {
    delete B.diskHigh; saveAlertState(B);
    await notify(`✅ Disk back to ${(used * 100).toFixed(0)}% used (${freeGb.toFixed(1)} GB free).`);
  }
} catch (e) { disk = ` · disk check failed: ${e.message}`; }

console.log((down ? `DOWN: ${reason}` : `ok: last cycle ${Math.round(age / 1000)}s ago`) + disk);
