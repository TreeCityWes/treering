import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFill, simulate } from "../src/replay.js";

test("applyFill averages entries, realizes on reductions, and re-bases on a cross", () => {
  let r = applyFill(null, 2, 100);
  assert.deepEqual(r, { pos: { szi: 2, entryPx: 100 }, realized: 0 });
  r = applyFill(r.pos, 2, 110);
  assert.equal(r.pos.entryPx, 105);
  r = applyFill(r.pos, -1, 115);
  assert.equal(r.realized, 10);
  assert.deepEqual(r.pos, { szi: 3, entryPx: 105 });
  r = applyFill(r.pos, -5, 100);
  assert.equal(r.realized, -15);
  assert.deepEqual(r.pos, { szi: -2, entryPx: 100 });
  assert.equal(applyFill({ szi: -2, entryPx: 100 }, 2, 90).pos, null);
  assert.equal(applyFill({ szi: -2, entryPx: 100 }, 2, 90).realized, 20);
});

const cfg = { leverage: 3, markets: ["BTC"], killPct: 0.5, maxDrawdownPct: 0, minOrderUsd: 10, slippage: 0.01, rebalance: { minGapUsd: 15, minGapFrac: 0.2 }, flipMinScore: 0, builderFee: false, stops: { enabled: true, stopLossPct: 0.08, stopSlippage: 0.1, trailArmPct: 0.04, trailPct: 0.04, reentryWeightChange: 0.25 } };
const rec = (i, px, score) => ({ ts: 1e12 + i * 300_000, signalTs: 1e12 + i * 300_000, live: true, paused: false, cfg, equity: 100, mids: { BTC: px }, signal: [{ coin: "BTC", score }], positions: {}, stops: [], blocks: null });
const free = { feeRate: 0, builderRate: 0, fillSlipBps: 0, stopSlipBps: 0 };

test("simulate follows the signal and marks P&L to the last price", () => {
  // Long $150 (100 × 3 × 50%) at 100, price to 102: +$3.
  const out = simulate([rec(0, 100, 50), rec(1, 102, 50)], { sim: free });
  assert.equal(out.trades, 1);
  assert.ok(Math.abs(out.pnl - 3) < 1e-6, `pnl ${out.pnl}`);
});

test("simulate fills a hard stop and blocks re-entry while the signal is unchanged", () => {
  const out = simulate([rec(0, 100, 50), rec(1, 91, 50), rec(2, 91, 50)], { sim: free });
  assert.equal(out.stopOuts, 1);
  assert.equal(out.trades, 2); // the open and the stop, no re-entry
  assert.ok(Math.abs(out.pnl - -13.5) < 1e-6, `pnl ${out.pnl}`); // gap through 92: filled at the 91 mid
  const reopened = simulate([rec(0, 100, 50), rec(1, 91, 50), rec(2, 91, 50)], { sim: { ...free, reentryBlock: false } });
  assert.equal(reopened.trades, 3);
});

test("simulate triggers a stop inside a cycle when candles show the price touched it", () => {
  const recs = [rec(0, 100, 50), rec(1, 99, 50)];
  const candles = { BTC: [{ t: recs[0].ts + 60_000, h: 100, l: 91.5 }] };
  assert.equal(simulate(recs, { sim: free }).stopOuts, 0);
  const out = simulate(recs, { sim: free }, candles);
  assert.equal(out.stopOuts, 1);
  assert.ok(Math.abs(out.pnl - -12) < 1e-6, `pnl ${out.pnl}`); // filled at the 92 trigger
});
