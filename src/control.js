// Tiny file-based control channel between the bot service, the TUI and `npm run ctl`.
import { readFileSync, writeFileSync, renameSync, existsSync, appendFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { PATHS, ensureDataDir } from "./config.js";

export const DEFAULT_CONTROL = { paused: false, live: false, flatten: false, runNow: false };

export function writeJson(path, value) {
  ensureDataDir();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function readJson(path, fallback) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback; } catch { return fallback; }
}

export const readControl = () => ({ ...DEFAULT_CONTROL, ...readJson(PATHS.control, {}) });
export function updateControl(patch) { const next = { ...readControl(), ...patch }; writeJson(PATHS.control, next); return next; }
export const readState = () => readJson(PATHS.state, null);

export function logEvent(event) {
  ensureDataDir();
  const line = { ts: Date.now(), ...event };
  appendFileSync(PATHS.log, JSON.stringify(line) + "\n", { mode: 0o600 });
  return line;
}

/** Last n events without reading the whole log. */
export function tailEvents(n = 30) {
  if (!existsSync(PATHS.log)) return [];
  const size = statSync(PATHS.log).size, len = Math.min(size, 64 * 1024);
  const buf = Buffer.alloc(len), fd = openSync(PATHS.log, "r");
  try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
  return buf.toString("utf8").split("\n").filter(Boolean).slice(-n).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}
