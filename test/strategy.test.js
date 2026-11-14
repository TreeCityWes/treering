import { test } from "node:test";
import assert from "node:assert/strict";
import { targetRows, buildOrders, drawdownCheck, formatPrice, formatSize } from "../src/strategy.js";

const cfg = { leverage: 3, minOrderUsd: 10, markets: ["BTC", "ETH", "ZEC"] };
const signal = { coins: [{ coin: "BTC", score: -31 }, { coin: "ETH", score: 10 }, { coin: "ZEC", score: 60 }] };
const markets = { BTC: { asset: 0, szDecimals: 5 }, ETH: { asset: 1, szDecimals: 4 }, ZEC: { asset: 214, szDecimals: 2 } };
const mids = { BTC: 80000, ETH: 2400, ZEC: 400 };

test("targets = equity × lev ÷ markets × score/100, deadband holds", () => {
  const rows = targetRows({ equity: 100, cfg, signal, current: { ETH: 50 } });
  const by = Object.fromEntries(rows.map((r) => [r.coin, r]));
  assert.equal(by.BTC.target, -31);           // 100*3/3 * -0.31
  assert.deepEqual(by.BTC.actions, ["OPEN"]);
  assert.equal(by.ETH.target, 50);            // |10| < 15 → hold current
  assert.deepEqual(by.ETH.actions, ["HOLD"]);
  assert.equal(by.ZEC.target, 60);
});

test("resize off: no adds or trims, but opens, closes, flips and loss-stop trims still happen", () => {
  const c = { ...cfg, rebalance: { minGapUsd: 15, minGapFrac: 0.2, resize: false }, flipMinScore: 25 };
  const sig = { coins: [{ coin: "BTC", score: -80 }, { coin: "ETH", score: 30 }, { coin: "ZEC", score: 60 }] };
  const by = Object.fromEntries(targetRows({ equity: 100, cfg: c, signal: sig, current: { BTC: -20, ETH: 90, ZEC: -40 } }).map((r) => [r.coin, r]));
  assert.deepEqual(by.BTC.actions, ["SKIP"]); // would ADD -20 → -80
  assert.equal(by.BTC.noResize, true);
  assert.deepEqual(by.ETH.actions, ["SKIP"]); // would REDUCE 90 → 30
  assert.deepEqual(by.ZEC.actions, ["FLIP-CLOSE", "FLIP-OPEN"]);
  const opened = targetRows({ equity: 100, cfg: c, signal: sig, current: {} });
  assert.deepEqual(opened.find((r) => r.coin === "BTC").actions, ["OPEN"]);
  const killed = targetRows({ equity: 100, cfg: c, signal: { coins: [{ coin: "ETH", score: 30 }] }, current: { ETH: 90 }, killed: true });
  assert.deepEqual(killed.find((r) => r.coin === "ETH").actions, ["REDUCE"]);
});

test("gaps under the minimum order are skipped", () => {
  const rows = targetRows({ equity: 100, cfg, signal, current: { BTC: -25 } });
  assert.deepEqual(rows.find((r) => r.coin === "BTC").actions, ["SKIP"]); // gap -6 < $10
});

test("flip closes then reopens", () => {
  const rows = targetRows({ equity: 100, cfg, signal, current: { ZEC: -40 } });
  assert.deepEqual(rows.find((r) => r.coin === "ZEC").actions, ["FLIP-CLOSE", "FLIP-OPEN"]);
});

test("loss stop never adds or flips, only reduces", () => {
  const rows = targetRows({ equity: 100, cfg, signal, current: { ZEC: -40, BTC: -10 }, killed: true });
  const by = Object.fromEntries(rows.map((r) => [r.coin, r]));
  assert.deepEqual(by.ZEC.actions, ["CLOSE"]);   // would flip → close only
  assert.equal(by.BTC.target, -10);              // would add → capped at current
  assert.deepEqual(by.BTC.actions, ["LOSS-STOP"]);
});

test("orders: IOC through mid, closes sorted first, sizes rounded down", () => {
  const rows = targetRows({ equity: 100, cfg, signal, current: { ZEC: -40 } });
  const orders = buildOrders(rows, { markets, mids, positions: { ZEC: { szi: -0.1 } }, slippage: 0.01, minOrderUsd: 10 });
  assert.equal(orders[0].tag, "FLIP-CLOSE");
  assert.equal(orders[0].reduceOnly, true);
  assert.equal(orders[0].sz, "0.1");
  assert.equal(orders[0].wire.b, true);         // buy back the short
  const btc = orders.find((o) => o.coin === "BTC");
  assert.equal(btc.wire.b, false);
  assert.equal(btc.sz, "0.00038");              // 31/80000 = 0.0003875 → floor 5dp
  assert.equal(btc.px, "79200");                // 1% under mid
  assert.deepEqual(btc.wire.t, { limit: { tif: "Ioc" } });
});

test("orders near $10 are bumped to clear the minimum at the limit price", () => {
  const c = { leverage: 1, minOrderUsd: 10, markets: ["HYPE"] };
  const rows = targetRows({ equity: 10.5, cfg: c, signal: { coins: [{ coin: "HYPE", score: -100 }] }, current: {} });
  const [o] = buildOrders(rows, { markets: { HYPE: { asset: 159, szDecimals: 2 } }, mids: { HYPE: 83.35 }, positions: {}, slippage: 0.01, minOrderUsd: 10 });
  assert.equal(o.px, "82.516");
  assert.ok(Number(o.sz) * Number(o.px) >= 10, `${o.sz} × ${o.px} must be ≥ $10`);
  assert.equal(o.sz, "0.13");
});

test("orders far below $10 are skipped, not inflated", () => {
  const c = { leverage: 1, minOrderUsd: 10, markets: ["HYPE"] };
  const rows = targetRows({ equity: 8, cfg: c, signal: { coins: [{ coin: "HYPE", score: -100 }] }, current: {} });
  assert.deepEqual(rows[0].actions, ["SKIP"]);
  const rows2 = [{ ...rows[0], actions: ["OPEN"], target: -8, gap: -8 }];
  assert.equal(buildOrders(rows2, { markets: { HYPE: { asset: 159, szDecimals: 2 } }, mids: { HYPE: 83.35 }, positions: {}, slippage: 0.01, minOrderUsd: 10 }).length, 0);
});

test("price and size formatting follow Hyperliquid tick rules", () => {
  assert.equal(formatPrice(2424.567, 4), "2424.6");
  assert.equal(formatPrice(0.0123456, 0), "0.012346");
  assert.equal(formatPrice(123456, 5), "123456");
  assert.equal(formatSize(1.239, 2), "1.23");
});

test("partial reduce under $10 at the limit price is bumped to clear the minimum (SOL regression)", () => {
  const c = { leverage: 3, minOrderUsd: 10, markets: ["SOL"] };
  // Live case: short 0.31 SOL @ mid 94.4675, target -$19.15 → gap +$10.14 → 0.10 SOL ≈ $9.45 at the limit price.
  const rows = [{ coin: "SOL", score: -27, current: -29.284925, target: -19.14828403365, gap: 10.13664096635, actions: ["REDUCE"] }];
  const [o] = buildOrders(rows, { markets: { SOL: { asset: 5, szDecimals: 2 } }, mids: { SOL: 94.4675 }, positions: { SOL: { szi: -0.31 } }, slippage: 0.01, minOrderUsd: 10 });
  assert.equal(o.reduceOnly, true);
  assert.equal(o.isBuy, true);
  assert.ok(Number(o.sz) * Number(o.px) >= 10, `${o.sz} × ${o.px} must clear $10`);
  assert.equal(o.sz, "0.11");
});

test("a reduce is never bumped past the position size", () => {
  const rows = [{ coin: "SOL", score: -27, current: -9.5, target: 0.5, gap: 10, actions: ["REDUCE"] }];
  const out = buildOrders(rows, { markets: { SOL: { asset: 5, szDecimals: 2 } }, mids: { SOL: 95 }, positions: { SOL: { szi: -0.1 } }, slippage: 0.01, minOrderUsd: 10 });
  assert.equal(out.length, 0);
});

test("full closes are exempt from the minimum", () => {
  const rows = [{ coin: "SOL", score: 10, current: -5, target: 0, gap: 5, actions: ["CLOSE"] }];
  const [o] = buildOrders(rows, { markets: { SOL: { asset: 5, szDecimals: 2 } }, mids: { SOL: 95 }, positions: { SOL: { szi: -0.05 } }, slippage: 0.01, minOrderUsd: 10 });
  assert.equal(o.sz, "0.05");
});

test("rebalance filter skips small adds/trims but never opens, closes or flips", () => {
  const c = { ...cfg, rebalance: { minGapUsd: 15, minGapFrac: 0.2 } };
  // BTC target −31: current −20 → gap −11 (< $15) skip; ZEC target 60: current 48 → gap 12 skip
  let by = Object.fromEntries(targetRows({ equity: 100, cfg: c, signal, current: { BTC: -20, ZEC: 48 } }).map((r) => [r.coin, r]));
  assert.deepEqual(by.BTC.actions, ["SKIP"]); assert.equal(by.BTC.small, true);
  assert.deepEqual(by.ZEC.actions, ["SKIP"]); assert.equal(by.ZEC.small, true);
  // gap $16 but under 20% of a $100 position → still skipped; gap $25 on $100 → trades
  const big = { coins: [{ coin: "BTC", score: -84 }, { coin: "ETH", score: 75 }, { coin: "ZEC", score: 60 }] };
  by = Object.fromEntries(targetRows({ equity: 100, cfg: c, signal: big, current: { BTC: -100, ETH: 100 } }).map((r) => [r.coin, r]));
  assert.deepEqual(by.BTC.actions, ["SKIP"]);   // gap +16 < 20
  assert.deepEqual(by.ETH.actions, ["REDUCE"]); // gap −25 ≥ 20
  // opens and flips are not filtered, even when small
  by = Object.fromEntries(targetRows({ equity: 100, cfg: c, signal, current: { ZEC: -12 } }).map((r) => [r.coin, r]));
  assert.deepEqual(by.BTC.actions, ["OPEN"]);
  assert.deepEqual(by.ZEC.actions, ["FLIP-CLOSE", "FLIP-OPEN"]);
  // without the config the old behaviour is unchanged
  assert.deepEqual(targetRows({ equity: 100, cfg, signal, current: { BTC: -20 } }).find((r) => r.coin === "BTC").actions, ["ADD"]);
});

test("rebalance filter is off while the daily loss stop is hit, so reductions still go through", () => {
  const c = { ...cfg, rebalance: { minGapUsd: 15, minGapFrac: 0.2 } };
  const r = targetRows({ equity: 100, cfg: c, signal, current: { ZEC: 72 }, killed: true }).find((x) => x.coin === "ZEC");
  assert.deepEqual(r.actions, ["REDUCE"]); // gap −12 would be "small" but killed exempts it
});

test("flip hysteresis: a weak opposite score holds, a strong one flips", () => {
  const c = { ...cfg, flipMinScore: 25 };
  const weak = { coins: [{ coin: "BTC", score: -18 }, { coin: "ETH", score: 10 }, { coin: "ZEC", score: 24 }] };
  const rows = targetRows({ equity: 100, cfg: c, signal: weak, current: { BTC: 30, ZEC: -40 } });
  const by = Object.fromEntries(rows.map((r) => [r.coin, r]));
  assert.deepEqual(by.BTC.actions, ["HOLD"]);
  assert.equal(by.BTC.target, 30);
  assert.equal(by.BTC.flipHeld, true);
  assert.deepEqual(by.ZEC.actions, ["HOLD"]);
  // at the threshold it flips
  const strong = { coins: [{ coin: "BTC", score: -25 }, { coin: "ETH", score: 0 }, { coin: "ZEC", score: 60 }] };
  const r2 = targetRows({ equity: 100, cfg: c, signal: strong, current: { BTC: 30 } });
  assert.deepEqual(r2.find((r) => r.coin === "BTC").actions, ["FLIP-CLOSE", "FLIP-OPEN"]);
});

test("flip hysteresis never blocks opens, same-side sizing, or loss-stop closes", () => {
  const c = { ...cfg, flipMinScore: 25 };
  const sig = { coins: [{ coin: "BTC", score: -18 }, { coin: "ETH", score: 20 }, { coin: "ZEC", score: 20 }] };
  const by = Object.fromEntries(targetRows({ equity: 100, cfg: c, signal: sig, current: { ETH: 50 } }).map((r) => [r.coin, r]));
  assert.deepEqual(by.BTC.actions, ["OPEN"]);       // flat → open at weak score is unchanged
  assert.deepEqual(by.ETH.actions, ["REDUCE"]);     // same side → normal resize
  assert.equal(by.ETH.flipHeld, undefined);
  const killed = targetRows({ equity: 100, cfg: c, signal: sig, current: { BTC: 30 }, killed: true });
  assert.deepEqual(killed.find((r) => r.coin === "BTC").actions, ["CLOSE"]);
});

test("drawdown check tracks the high-water mark and trips at the limit", () => {
  assert.deepEqual(drawdownCheck(undefined, 100, 0.15), { peak: 100, dd: 0, hit: false }); // first reading
  assert.equal(drawdownCheck(100, 120, 0.15).peak, 120);                                    // new high
  const down = drawdownCheck(120, 105, 0.15);
  assert.equal(down.peak, 120);
  assert.ok(Math.abs(down.dd - 0.125) < 1e-12);
  assert.equal(down.hit, false);
  assert.equal(drawdownCheck(120, 102, 0.15).hit, true);                                    // exactly 15%
  assert.equal(drawdownCheck(120, 60, 0).hit, false);                                       // 0 = off
});

test("no signal: every row holds and nothing is ordered", () => {
  const rows = targetRows({ equity: 100, cfg: { ...cfg, flipMinScore: 25 }, signal: { coins: [] }, current: { BTC: -30, ZEC: 40 } });
  assert.deepEqual(rows.map((r) => r.actions[0]), ["HOLD", "SKIP", "HOLD"]);
  assert.deepEqual(buildOrders(rows, { markets, mids, positions: { BTC: { szi: -0.000375 }, ZEC: { szi: 0.1 } }, slippage: 0.01, minOrderUsd: 10 }), []);
});

test("a small open is not rounded up past 1.5x its target (ZEC regression)", () => {
  const zec = { ZEC: { asset: 214, szDecimals: 2 } };
  // Live case: $10.70 target at mid 944.28; one 0.01 step is under $10, two would be $18.90.
  const small = [{ coin: "ZEC", score: 23, current: 0, target: 10.7, gap: 10.7, actions: ["OPEN"] }];
  assert.equal(buildOrders(small, { markets: zec, mids: { ZEC: 944.28 }, positions: {}, slippage: 0.01, minOrderUsd: 10 }).length, 0);
  // $14: rounding to 0.02 is 1.35x the target, so it goes through.
  const ok = [{ ...small[0], target: 14, gap: 14 }];
  assert.equal(buildOrders(ok, { markets: zec, mids: { ZEC: 944.28 }, positions: {}, slippage: 0.01, minOrderUsd: 10 })[0].sz, "0.02");
});

test("smoothSignal averages each coin's points over the window and keeps the raw score", async () => {
  const { smoothSignal } = await import("../src/strategy.js");
  const H = 3600e3, now = 100 * H;
  const signal = { timestamp: now, coins: [
    { coin: "BTC", score: 40, points: [[now - 13 * H, -90], [now - 11 * H, 10], [now - 6 * H, 20], [now, 40]] },
    { coin: "ETH", score: null, points: [[now, 30]] },
    { coin: "SOL", score: -20, points: [] },
  ] };
  const s = smoothSignal(signal, 12);
  assert.equal(s.coins[0].score, 23.3);        // (10 + 20 + 40) / 3; the 13h-old point is outside
  assert.equal(s.coins[0].rawScore, 40);
  assert.equal(s.coins[1].score, null);        // no current reading: still unknown
  assert.equal(s.coins[2].score, -20);         // no points: raw score
  assert.equal(smoothSignal(signal, 0), signal);
  // Sizing uses the averaged score.
  const [row] = targetRows({ equity: 100, cfg: { leverage: 1, markets: ["BTC"], minOrderUsd: 10 }, signal: s, current: {} });
  assert.ok(Math.abs(row.target - 23.3) < 1e-9);
});
