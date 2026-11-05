import { test } from "node:test";
import assert from "node:assert/strict";
import { stopPlan, releaseReason, stopOrder, tighter } from "../src/stops.js";

const sc = { stopLossPct: 0.08, stopSlippage: 0.1, trailArmPct: 0.04, trailPct: 0.04, reentryWeightChange: 0.25 };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test("hard stop sits 8% adverse to entry", () => {
  close(stopPlan({ side: 1, entry: 100 }, 101, undefined, sc).stopPx, 92);
  close(stopPlan({ side: -1, entry: 100 }, 99, undefined, sc).stopPx, 108);
});

test("trail arms at +4% and floors at breakeven +0.1%", () => {
  const p = stopPlan({ side: 1, entry: 100 }, 104, undefined, sc);
  assert.equal(p.armed, true);
  close(p.stopPx, 100.1); // max(breakeven 100.1, 104·0.96 = 99.84)
  const s = stopPlan({ side: -1, entry: 100 }, 96, undefined, sc);
  assert.equal(s.armed, true);
  close(s.stopPx, 99.84); // short: tighter (lower) of breakeven 99.9 and 96·1.04 = 99.84
});

test("trail follows the best price 4% behind and only tightens", () => {
  let p = stopPlan({ side: 1, entry: 100 }, 110, undefined, sc);
  close(p.stopPx, 105.6);              // 110 · 0.96
  p = stopPlan({ side: 1, entry: 100 }, 106, p, sc);
  close(p.best, 110);                  // best is remembered
  close(p.stopPx, 105.6);              // pullback does not loosen
  p = stopPlan({ side: 1, entry: 100 }, 120, p, sc);
  close(p.stopPx, 115.2);              // new high tightens
});

test("not armed below +4%: hard stop only", () => {
  const p = stopPlan({ side: 1, entry: 100 }, 103.9, undefined, sc);
  assert.equal(p.armed, false);
  close(p.stopPx, 92);
});

test("a new entry (add) resets to the new hard stop; a side flip starts fresh", () => {
  const a = stopPlan({ side: 1, entry: 100 }, 110, undefined, sc);
  const b = stopPlan({ side: 1, entry: 105 }, 105, a, sc);
  assert.equal(b.armed, true);          // stays armed
  close(b.best, 110);
  const c = stopPlan({ side: -1, entry: 105 }, 105, a, sc);
  assert.equal(c.armed, false);
  close(c.stopPx, 113.4);
});

test("re-entry block lifts on flip, flat, gone, or >25% weight change", () => {
  const block = { side: -1, weight: -0.4 };
  assert.equal(releaseReason(block, -38, sc), null);
  assert.equal(releaseReason(block, -45, sc), null);           // 12.5% change
  assert.match(releaseReason(block, -55, sc), /weight moved/); // 37.5%
  assert.match(releaseReason(block, -25, sc), /weight moved/);
  assert.equal(releaseReason(block, 30, sc), "signal flipped");
  assert.equal(releaseReason(block, -10, sc), "signal went flat");
  assert.equal(releaseReason(block, null, sc), "left the signal");
});

test("stop order wire: reduce-only stop-market, slippage-capped, side-correct", () => {
  const short = stopOrder({ asset: 0, szDecimals: 5 }, -1, 0.00024, 86769.36, sc);
  assert.deepEqual(short, { a: 0, b: true, p: "95446", s: "0.00024", r: true, t: { trigger: { isMarket: true, triggerPx: "86769", tpsl: "sl" } } });
  const long = stopOrder({ asset: 214, szDecimals: 2 }, 1, 0.02, 1217.16, sc);
  assert.equal(long.b, false);
  assert.equal(long.t.trigger.triggerPx, "1217.2");
  assert.equal(long.p, "1095.4");
});

test("tighter picks the protective side", () => {
  assert.equal(tighter(1, 90, 95), 95);
  assert.equal(tighter(-1, 110, 105), 105);
});
