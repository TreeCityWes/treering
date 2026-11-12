import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.TREERING_DATA_DIR ?? process.env.MOODRING_DATA_DIR ?? join(ROOT, "data");
export const PATHS = {
  env: process.env.TREERING_ENV_FILE ?? process.env.MOODRING_ENV_FILE ?? join(ROOT, ".env.agent"),
  config: process.env.TREERING_CONFIG_FILE ?? join(ROOT, "config.json"),
  state: join(DATA_DIR, "state.json"),
  control: join(DATA_DIR, "control.json"),
  stops: join(DATA_DIR, "stops.json"),
  log: join(DATA_DIR, "events.jsonl"),
  pnl: join(DATA_DIR, "pnl.json"),
  pnlCache: join(DATA_DIR, "pnl-cache.json"),
  paper: join(DATA_DIR, "paper.json"),
  history: join(DATA_DIR, "history"),
};

// File modes for the data directory. Owner-only by default. When the bot runs as its own system user
// (deploy/system), TREERING_SHARED_GROUP=1 makes files group-readable/writable so an operator in the
// bot's group can use the dashboard and `ctl` without being able to read the bot's secrets.
const SHARED = process.env.TREERING_SHARED_GROUP === "1";
export const FILE_MODE = SHARED ? 0o660 : 0o600;
export const DIR_MODE = SHARED ? 0o770 : 0o700;

export const SIGNAL_URL = "https://wxnt-sale-sim.vercel.app/api/daytraders?view=sent";
// X1's builder code. Your owner account approved it on the terminal's /API page.
export const X1_BUILDER = { b: "0x95e1642b6c06e06e6ad9412a90e908dcb09f6c1a", f: 50 };
// The markets the hosted executor trades. xyz:* are HIP-3 stock/commodity perps.
export const ALL_MARKETS = ["BTC", "ETH", "SOL", "HYPE", "ZEC", "NEAR", "xyz:GOOGL", "xyz:NVDA", "xyz:BRENTOIL", "xyz:GOLD", "xyz:MU", "xyz:INTC"];
export const DEADBAND = 15;

export const DEFAULT_CONFIG = {
  network: "mainnet",
  // Replays of Nov 6–12 history: leverage 2 without resizing beat leverage 3 with resizing in every
  // quarter of the period, with about 40% of the fees and half the drawdown. Changed 2026-11-13.
  leverage: 2,
  killPct: 0.1,
  // Drawdown stop: pause the bot (positions keep their stops) when equity falls this far below its
  // highest value seen. The daily loss stop resets every UTC midnight; this one does not. 0 = off.
  maxDrawdownPct: 0.15,
  minOrderUsd: 10,
  // xyz markets are left out by default: in "default" account mode they need
  // USDC moved onto the xyz dex, which an API wallet cannot do.
  markets: ["BTC", "ETH", "SOL", "HYPE", "ZEC", "NEAR"],
  intervalSec: 300,
  slippage: 0.01,
  maxSignalAgeSec: 600,
  builderFee: true,
  // Skip small adds/trims to an existing position: trade only when the gap to target is at least
  // minGapUsd AND at least minGapFrac of the position. Opens, closes and flips are never filtered.
  // resize: false skips every add and trim: a position keeps its opening size until closed or flipped.
  // Resizing was 54% of traded volume (and of fees) in Nov 6–10 and lost money in replays.
  rebalance: { minGapUsd: 15, minGapFrac: 0.2, resize: false },
  // Flip hysteresis: only reverse an open position when |score| >= this. Weaker opposite scores hold.
  // Replay of Nov 6–8 history: 20–30 avoided 2 losing HYPE flips; 40 also blocked good ones.
  flipMinScore: 25,
  // Protective stops, as in the X1 copybot whitepaper (Blue Bear's settings).
  stops: {
    enabled: true,
    stopLossPct: 0.08,        // hard stop 8% adverse to entry, resting on the exchange
    stopSlippage: 0.10,       // worst fill accepted when the stop triggers
    trailArmPct: 0.04,        // arm the trail once 4% in favour…
    trailPct: 0.04,           // …then trail 4% behind the best price (breakeven +0.1% floor)
    reentryWeightChange: 0.25, // lift a re-entry block when the weight moves >25% (or flips/flat/gone)
    whenNotLive: true,        // keep protecting open positions even in dry-run or paused
  },
};

function parseEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export function loadCredentials() {
  const env = existsSync(PATHS.env) ? { ...parseEnvFile(PATHS.env), ...process.env } : process.env;
  const owner = env.X1_ACCOUNT_ADDRESS, key = env.X1_AGENT_PRIVATE_KEY;
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner ?? "") || !/^0x[0-9a-fA-F]{64}$/.test(key ?? ""))
    throw new Error(`Set X1_ACCOUNT_ADDRESS and X1_AGENT_PRIVATE_KEY in ${PATHS.env}`);
  return { owner, key, network: env.X1_NETWORK ?? null };
}

/** The owner account address only (public), for read-only tools that must not need the agent key. */
export function loadOwner() {
  let env = process.env;
  try { if (existsSync(PATHS.env)) env = { ...parseEnvFile(PATHS.env), ...process.env }; } catch { /* unreadable: fall back to the environment */ }
  return /^0x[0-9a-fA-F]{40}$/.test(env.X1_ACCOUNT_ADDRESS ?? "") ? { owner: env.X1_ACCOUNT_ADDRESS, network: env.X1_NETWORK ?? null } : null;
}

export function loadConfig() {
  const user = existsSync(PATHS.config) ? JSON.parse(readFileSync(PATHS.config, "utf8")) : {};
  const cfg = { ...DEFAULT_CONFIG, ...user, stops: { ...DEFAULT_CONFIG.stops, ...(user.stops ?? {}) }, rebalance: { ...DEFAULT_CONFIG.rebalance, ...(user.rebalance ?? {}) } };
  if (!(cfg.flipMinScore >= 0 && cfg.flipMinScore <= 100)) throw new Error("config.flipMinScore must be in [0, 100]");
  const rb = cfg.rebalance;
  if (!(rb.minGapUsd >= 0 && rb.minGapUsd <= 1e6)) throw new Error("config.rebalance.minGapUsd must be >= 0");
  if (!(rb.minGapFrac >= 0 && rb.minGapFrac < 1)) throw new Error("config.rebalance.minGapFrac must be in [0, 1)");
  if (typeof rb.resize !== "boolean") throw new Error("config.rebalance.resize must be true or false");
  const st = cfg.stops;
  if (!(st.stopLossPct > 0 && st.stopLossPct <= 0.5)) throw new Error("config.stops.stopLossPct must be in (0, 0.5]");
  if (!(st.stopSlippage > 0 && st.stopSlippage <= 0.2)) throw new Error("config.stops.stopSlippage must be in (0, 0.2]");
  if (!(st.trailArmPct > 0 && st.trailPct > 0 && st.trailPct <= 0.5)) throw new Error("config.stops trail settings must be positive");
  if (!Number.isInteger(cfg.leverage) || cfg.leverage < 1 || cfg.leverage > 5) throw new Error("config.leverage must be an integer 1-5");
  if (!(cfg.killPct > 0 && cfg.killPct <= 0.5)) throw new Error("config.killPct must be in (0, 0.5]");
  if (!(cfg.maxDrawdownPct >= 0 && cfg.maxDrawdownPct <= 0.9)) throw new Error("config.maxDrawdownPct must be in [0, 0.9] (0 = off)");
  if (!(cfg.minOrderUsd >= 10)) throw new Error("config.minOrderUsd must be >= 10 (Hyperliquid minimum)");
  if (!(cfg.slippage > 0 && cfg.slippage <= 0.05)) throw new Error("config.slippage must be in (0, 0.05]");
  if (!(cfg.intervalSec >= 60)) throw new Error("config.intervalSec must be >= 60");
  const bad = cfg.markets.filter((m) => !ALL_MARKETS.includes(m));
  if (bad.length || !cfg.markets.length) throw new Error(`config.markets must be a non-empty subset of ${ALL_MARKETS.join(", ")}`);
  return cfg;
}

export function ensureDataDir() { mkdirSync(DATA_DIR, { recursive: true, mode: DIR_MODE }); }
