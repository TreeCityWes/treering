import { test } from "node:test";
import assert from "node:assert/strict";
import { initPaper, stepPaper, paperSummary, PAPER_FEE } from "../src/paper.js";
import { errorAlerts } from "../src/alerts.js";

const cfg = { leverage: 2, markets: ["BTC", "ETH"], minOrderUsd: 10, flipMinScore: 25, rebalance: { minGapUsd: 15, minGapFrac: 0.2, resize: false },
  stops: { enabled: true, stopLossPct: 0.08, trailArmPct: 0.04, trailPct: 0.04, reentryWeightChange: 0.25 } };
const V = [
  { id: "live", label: "live" },
  { id: "old", label: "old", cfg: { leverage: 3, rebalance: { resize: true } } },
  { id: "fade", label: "fade", invert: true, flatStart: true },
  { id: "smooth", label: "smooth", smoothHours: 6 },
];
const start = (over = {}) => initPaper({ ts: 0, equity: 100, positions: { BTC: { szi: -0.001, entryPx: 50000 } }, mids: { BTC: 50000, ETH: 2000 }, trail: {}, scores: { BTC: -40, ETH: 0 }, variants: V, ...over });

test("variants start from the live account; fade starts flat", () => {
  const p = start();
  assert.equal(p.variants.live.pos.BTC.szi, -0.001);
  assert.deepEqual(p.variants.fade.pos, {});
  assert.equal(p.variants.smooth.ema.BTC, -40);
});

test("marks to market and charges fees on trades", () => {
  const p = start();
  stepPaper(p, { ts: 300e3, mids: { BTC: 49000, ETH: 2000 }, scores: { BTC: -60, ETH: 0 }, cfg, variants: V });
  // The short 0.001 BTC gained $1; live rules (no resizing) hold.
  assert.equal(p.variants.live.equity, 101);
  assert.equal(p.variants.live.trades, 0);
  // Old rules resize: target 101 × 3 / 2 × -0.6 = -90.9 vs current -49 → ADD.
  assert.equal(p.variants.old.trades, 1);
  assert.ok(p.variants.old.fees > 0);
  // Fade (flat start, so equity 100) opens long BTC: 100 × 2 / 2 × 0.6 = 60.
  const f = p.variants.fade;
  assert.ok(Math.abs(f.pos.BTC.szi * 49000 - 60) < 1e-9);
  assert.ok(Math.abs(f.equity - (100 - 60 * PAPER_FEE)) < 1e-9);
});

test("a stop crossing closes at the stop price and blocks re-entry", () => {
  const p = start();
  stepPaper(p, { ts: 300e3, mids: { BTC: 50000, ETH: 2000 }, scores: { BTC: -40, ETH: 0 }, cfg, variants: V });
  assert.equal(p.variants.live.trail.BTC.stopPx, 54000);
  stepPaper(p, { ts: 600e3, mids: { BTC: 55000, ETH: 2000 }, scores: null, cfg, variants: V });
  const s = p.variants.live;
  assert.equal(s.pos.BTC, undefined);
  assert.equal(s.stopsHit, 1);
  assert.ok(Math.abs(s.equity - (100 - 4 - 54 * PAPER_FEE)) < 1e-9); // loses $4 at the stop, not $5 at the mid
  assert.equal(s.blocks.BTC.side, -1);
  // Same score next cycle: still blocked, nothing reopened.
  stepPaper(p, { ts: 900e3, mids: { BTC: 55000, ETH: 2000 }, scores: { BTC: -40, ETH: 0 }, cfg, variants: V });
  assert.equal(s.pos.BTC, undefined);
});

test("a stop fires on the range between cycles even when the mid never reaches it", () => {
  const p = start();
  stepPaper(p, { ts: 300e3, mids: { BTC: 50000, ETH: 2000 }, scores: { BTC: -40, ETH: 0 }, cfg, variants: V });
  // Stop at 54000 (8% hard stop on the short). The mid only reaches 53000, but a spike traded 54100.
  stepPaper(p, { ts: 600e3, mids: { BTC: 53000, ETH: 2000 }, scores: null, ranges: { BTC: { lo: 52900, hi: 54100 } }, cfg, variants: V });
  assert.equal(p.variants.live.pos.BTC, undefined);
  assert.equal(p.variants.live.stopsHit, 1);
});

test("with size decimals, paper orders round like real ones", () => {
  const p = start({ positions: {}, scores: { BTC: 0, ETH: 0 } });
  // A coarse 0.01 ETH step ($20 at 2000): a $16 target (100 × 2 / 2 × 0.16) rounds up to one step.
  const markets = { BTC: { szDecimals: 5 }, ETH: { szDecimals: 2 } };
  stepPaper(p, { ts: 300e3, mids: { BTC: 50000, ETH: 2000 }, scores: { BTC: 0, ETH: 16 }, cfg: { ...cfg, slippage: 0.01 }, markets, variants: V });
  assert.equal(p.variants.live.pos.ETH.szi, 0.01);
  // Without size decimals the paper fills the exact notional.
  const q = start({ positions: {}, scores: { BTC: 0, ETH: 0 } });
  stepPaper(q, { ts: 300e3, mids: { BTC: 50000, ETH: 2000 }, scores: { BTC: 0, ETH: 16 }, cfg: { ...cfg, slippage: 0.01 }, variants: V });
  assert.ok(Math.abs(q.variants.live.pos.ETH.szi - 0.008) < 1e-12);
});

test("without a signal positions are only marked, never traded", () => {
  const p = start();
  stepPaper(p, { ts: 300e3, mids: { BTC: 50000, ETH: 2000 }, scores: null, cfg, variants: V });
  assert.equal(p.variants.fade.trades, 0);
  assert.equal(p.variants.old.trades, 0);
});

test("smoothing moves toward the new score at the 6h time constant", () => {
  const p = start();
  stepPaper(p, { ts: 6 * 3600e3, mids: { BTC: 50000, ETH: 2000 }, scores: { BTC: 60, ETH: 0 }, cfg, variants: V });
  const want = -40 + (1 - Math.exp(-1)) * 100;
  assert.ok(Math.abs(p.variants.smooth.ema.BTC - want) < 1e-9);
});

test("a variant added later starts from the live account", () => {
  const p = start();
  const more = [...V, { id: "lev1", label: "lev1", cfg: { leverage: 1 } }];
  stepPaper(p, { ts: 300e3, mids: { BTC: 50000, ETH: 2000 }, scores: { BTC: -40 }, cfg, equity: 97, positions: {}, variants: more });
  assert.equal(p.variants.lev1.equity, 97);
  assert.equal(paperSummary(p, more).length, 5);
});

test("one failed cycle is silent; two alert; recovery follows only a sent alert", () => {
  const A = {};
  assert.deepEqual(errorAlerts(A, { ts: 1, error: "timeout" }), []);
  assert.deepEqual(errorAlerts(A, { ts: 2, error: null }), []);
  assert.equal(A.errorSince, undefined);
  errorAlerts(A, { ts: 3, error: "timeout" });
  assert.match(errorAlerts(A, { ts: 4, error: "timeout" })[0], /2 cycles in a row/);
  for (let i = 0; i < 3; i++) errorAlerts(A, { ts: 5 + i, error: "timeout" });
  assert.match(errorAlerts(A, { ts: 9, error: "timeout" })[0], /6 cycles/);
  assert.match(errorAlerts(A, { ts: 10, error: null })[0], /Recovered after 6/);
});

test("with score sets, each variant trades on its own smoothing length", () => {
  const vs = [{ id: "live", label: "live" }, { id: "raw", label: "raw", smoothHours: 0 }];
  const p = start({ positions: {}, scores: { BTC: 0, ETH: 0 }, variants: vs });
  const c12 = { ...cfg, smoothHours: 12 };
  // Raw score 60 but the 12h average only 10 (inside the deadband): raw opens, live holds flat.
  stepPaper(p, { ts: 300e3, mids: { BTC: 50000, ETH: 2000 }, scores: { BTC: 60, ETH: 0 }, scoreSets: { 0: { BTC: 60, ETH: 0 }, 12: { BTC: 10, ETH: 0 } }, cfg: c12, variants: vs });
  assert.ok(p.variants.raw.pos.BTC.szi > 0);
  assert.equal(p.variants.live.pos.BTC, undefined);
});
