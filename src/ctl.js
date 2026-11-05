#!/usr/bin/env node
// Control the running bot without the TUI:  node src/ctl.js live on|off | pause | resume | flatten | run | status
import { readControl, updateControl, readState } from "./control.js";

const [cmd, arg] = process.argv.slice(2);
const actions = {
  live: () => {
    if (!["on", "off"].includes(arg)) throw new Error("usage: ctl live on|off");
    return updateControl({ live: arg === "on" });
  },
  pause: () => updateControl({ paused: true }),
  resume: () => updateControl({ paused: false }),
  flatten: () => updateControl({ flatten: true }),
  run: () => updateControl({ runNow: true }),
  status: () => {
    const s = readState();
    return { control: readControl(), equity: s?.equity, dayPnl: s?.dayPnl, lastCycle: s?.ts && new Date(s.ts).toISOString(), skip: s?.skip, error: s?.error, orders: s?.orders?.map((o) => `${o.tag} ${o.coin} ${o.isBuy ? "buy" : "sell"} ${o.sz} (~$${o.ntl.toFixed(2)})`) };
  },
};
try {
  if (!actions[cmd]) throw new Error("usage: node src/ctl.js live on|off | pause | resume | flatten | run | status");
  console.log(JSON.stringify(actions[cmd](), null, 2));
} catch (e) { console.error(e.message); process.exitCode = 1; }
