#!/usr/bin/env node
// Treering dashboard. Zero-dependency ANSI TUI that reads the bot's state file,
// pulls the public Mood Ring signal itself, and controls the bot via data/control.json.
import { fetchSignal } from "./hl.js";
import { readControl, updateControl, readState, tailEvents } from "./control.js";
import { DATA_DIR, loadConfig } from "./config.js";
import { ESC, setColorMode, bold } from "./tui/ansi.js";
import { C } from "./tui/widgets.js";
import { draw as compose } from "./tui/view.js";

const out = process.stdout;
const PLAIN = process.argv.includes("--plain") || !out.isTTY;
// Color depth: TREERING_COLOR=truecolor|256|none. Truecolor only when the terminal says so
// (watch -c and many SSH/tmux setups only handle 256 colors).
setColorMode(process.env.NO_COLOR || process.argv.includes("--no-color") ? "none"
  : process.env.TREERING_COLOR ?? process.env.MOODRING_COLOR ?? (/truecolor|24bit/i.test(process.env.COLORTERM ?? "") && !PLAIN ? "truecolor" : "256"));

function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }

const ui = { frame: 0, signal: null, signalErr: null, prompt: null, flash: null };
let cfg; try { cfg = loadConfig(); } catch (e) { cfg = null; ui.flash = C.down(`config error: ${e.message}`); }

async function refreshSignal() {
  try { ui.signal = await fetchSignal(); ui.signalErr = null; } catch (e) { ui.signalErr = e.message; }
}

function render() {
  try { out.write(`${ESC}H` + draw().map((l) => l + `${ESC}K`).join("\n") + `${ESC}J`); }
  catch (e) { out.write(`${ESC}H${ESC}2J render error: ${e.message}\n press q to quit`); }
}

function draw() {
  // `watch` passes its size via COLUMNS/LINES; leave 2 rows for watch's own header in plain mode.
  const W = Math.max(60, out.columns || Number(process.env.COLUMNS) || 120);
  const H = Math.max(20, (out.rows || Number(process.env.LINES) || 42) - (PLAIN ? 2 : 0));
  const s = readState();
  const frame = compose({ s, ctl: readControl(), events: tailEvents(200), signal: ui.signal, signalErr: ui.signalErr, cfg, running: alive(s?.pid), now: Date.now(), dataDir: DATA_DIR }, { W, H, ui });
  ui.frame++;
  return frame;
}

function flash(msg) { ui.flash = msg; setTimeout(() => { if (ui.flash === msg) ui.flash = null; }, 4000); }

function onKey(k) {
  if (k === "\u0003" || (k === "q" && !ui.prompt)) return quit();
  if (ui.prompt) {
    const action = ui.pending; ui.prompt = ui.pending = null;
    if (k === "y" || k === "Y") action(); else flash(C.soft("cancelled"));
    return render();
  }
  const ctl = readControl();
  const ask = (q, fn) => { ui.prompt = q; ui.pending = fn; };
  if (k === "p") { updateControl({ paused: !ctl.paused }); flash(C.warn(ctl.paused ? "resumed" : "paused — no orders until resumed")); }
  else if (k === "l") {
    if (ctl.live) { updateControl({ live: false }); flash(C.warn("dry-run: orders are planned, never sent")); }
    else ask(`Go LIVE? The bot will send REAL orders on ${readState()?.network ?? cfg?.network ?? "mainnet"} with your API wallet.`, () => { updateControl({ live: true }); flash(bold(C.down("LIVE trading on"))); });
  } else if (k === "r") { updateControl({ runNow: true }); flash(C.info("cycle requested")); }
  else if (k === "f") ask("FLATTEN? Market-close every position the bot can trade, then pause.", () => { updateControl({ flatten: true }); flash(C.warn("flatten requested")); });
  render();
}

function quit() { out.write(`${ESC}?25h${ESC}?1049l`); process.exit(0); }

// `npm run tui -- --plain` prints one frame to stdout and exits (diagnostics / non-TTY use).
if (PLAIN) {
  await refreshSignal();
  const frame = draw().join("\n").replace(/(\x1b\[0m)?(\n\x1b\[0m)+$/, "");
  console.log(frame);
  process.exit(0);
}
process.on("uncaughtException", (e) => { out.write(`${ESC}?25h${ESC}?1049l`); console.error("treering tui crashed:", e); process.exit(1); });
out.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
process.on("exit", () => out.write(`${ESC}?25h${ESC}?1049l`));
process.on("SIGTERM", quit);
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", onKey);
out.on("resize", () => { out.write(`${ESC}2J`); render(); });
// Draw immediately; the signal fills in when the first fetch returns.
render();
refreshSignal().then(render);
setInterval(render, 250);
setInterval(refreshSignal, 30_000);
