import { test } from "node:test";
import assert from "node:assert/strict";
import { targetRows, buildOrders, formatPrice, formatSize } from "../src/strategy.js";

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
