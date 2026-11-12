// Telegram alerts. Reads TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID from .env.alerts (or the environment).
// Every send is best-effort: it never throws and never blocks trading for more than a few seconds.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, DATA_DIR } from "./config.js";
import { readJson, writeJson } from "./control.js";

const ENV_FILE = process.env.TREERING_ALERTS_FILE ?? process.env.MOODRING_ALERTS_FILE ?? join(ROOT, ".env.alerts");
export const ALERT_STATE = join(DATA_DIR, "alerts.json");

function creds() {
  const env = { ...process.env };
  if (existsSync(ENV_FILE)) for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\s]*)"?\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
  const token = env.TELEGRAM_BOT_TOKEN, chat = env.TELEGRAM_CHAT_ID;
  return token && chat ? { token, chat } : null;
}

export const muted = () => (process.env.TREERING_ALERTS ?? process.env.MOODRING_ALERTS) === "off";
export const alertsEnabled = () => !!creds() && !muted();

/** Send one message. Returns true on success. */
export async function notify(text) {
  const c = creds();
  if (!c || muted()) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${c.token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: c.chat, text: text.slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) console.error(`alert not delivered: ${body.description ?? res.status}`);
    return !!body.ok;
  } catch (e) {
    console.error(`alert not delivered: ${e.message}`);
    return false;
  }
}

/** Small persisted memory so alerts fire on transitions, not every cycle. */
export const alertState = () => readJson(ALERT_STATE, {});
export const saveAlertState = (s) => writeJson(ALERT_STATE, s);

/**
 * Cycle-error alerts. One failed cycle (usually a single API timeout) is not reported: the first
 * alert goes out on the second failure in a row, another at six (~30 min), and "recovered" only
 * follows an alert that was sent. Mutates the alert state A; returns the messages to send.
 */
export function errorAlerts(A, out) {
  const msgs = [];
  if (out.error) {
    A.errorSince ??= out.ts;
    A.errorCount = (A.errorCount ?? 0) + 1;
    if (A.errorCount === 2) msgs.push(`⚠️ Cycle error, 2 cycles in a row: ${out.error}`);
    else if (A.errorCount === 6) msgs.push(`⚠️ Still failing after 6 cycles (~30 min): ${out.error}`);
  } else if (A.errorSince) {
    if (A.errorCount >= 2) msgs.push(`✅ Recovered after ${A.errorCount} failed cycles`);
    delete A.errorSince; delete A.errorCount;
  }
  return msgs;
}

export const money = (n, sign = false) => (n == null || !Number.isFinite(n) ? "—" : `${n < 0 ? "-" : sign && n > 0 ? "+" : ""}$${Math.abs(n).toFixed(2)}`);
