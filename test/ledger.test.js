import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, ledgerFlow } from "../src/ledger.js";

const owner = "0x7949ebdb79c3eb302bf854579b4e3f373d6aa21b";
const other = "0x00000000000000000000000000000000000000aa";
const start = { since: 1000, equity: 100, upnl: 0 };

test("P&L reconciles: equity change = realized − fees + funding + open", () => {
  const fills = [
    { coin: "BTC", px: "100", sz: "0.5", closedPnl: "0", fee: "0.04", builderFee: "0.02", time: 1100 },
    { coin: "BTC", px: "110", sz: "0.5", closedPnl: "5", fee: "0.05", builderFee: "0.03", time: 1200 },
    { coin: "ETH", px: "10", sz: "1", closedPnl: "-1", fee: "0.01", builderFee: "0", time: 1300 },
    { coin: "SOL", px: "1", sz: "1", closedPnl: "9", fee: "1", time: 500 }, // before start: ignored
  ];
  const funding = [{ time: 1150, delta: { coin: "BTC", usdc: "-0.1" } }];
  const p = summarize({ fills, funding, ledger: [], owner, unified: true, start, equity: 103.8, upnl: 0, now: 1000 + 864e5 });
  assert.equal(p.trades, 3);
  assert.ok(Math.abs(p.realized - 4) < 1e-9);
  assert.ok(Math.abs(p.fees - 0.1) < 1e-9);
  assert.ok(Math.abs(p.builderFees - 0.05) < 1e-9);
  assert.ok(Math.abs(p.total - 3.8) < 1e-9);
  assert.ok(Math.abs(p.residual) < 1e-9);       // 4 − 0.1 − 0.1 + 0 = 3.8
  assert.ok(Math.abs(p.byCoin.BTC.funding + 0.1) < 1e-9);
  assert.ok(Math.abs(p.totalPct - 3.8) < 1e-9);
  assert.ok(Math.abs(p.days - 1) < 1e-9);
});

test("deposits and withdrawals are not profit", () => {
  const ledger = [
    { time: 1100, delta: { type: "deposit", usdc: "50" } },
    { time: 1200, delta: { type: "withdraw", usdc: "20", fee: "1" } },
  ];
  const p = summarize({ fills: [], funding: [], ledger, owner, unified: true, start, equity: 129, upnl: 0 });
  assert.equal(p.flows, 29);
  assert.equal(p.total, 0);
});

test("ledger flows: USDC only, direction by destination, class transfers ignored in unified mode", () => {
  assert.equal(ledgerFlow({ type: "spotTransfer", token: "USDC", amount: "10", user: other, destination: owner, fee: "1", feeToken: "USDC" }, owner, true), 10);
  assert.equal(ledgerFlow({ type: "spotTransfer", token: "USDC", amount: "10", user: owner, destination: other, fee: "1", feeToken: "USDC" }, owner, true), -11);
  assert.equal(ledgerFlow({ type: "spotTransfer", token: "USOL", amount: "1.4", usdcValue: "139", user: other, destination: owner, fee: "1", feeToken: "USDC" }, owner, true), 0);
  assert.equal(ledgerFlow({ type: "accountClassTransfer", usdc: "5", toPerp: true }, owner, true), 0);
  assert.equal(ledgerFlow({ type: "accountClassTransfer", usdc: "5", toPerp: false }, owner, false), -5);
  assert.equal(ledgerFlow({ type: "internalTransfer", usdc: "7", user: other, destination: owner, fee: "1" }, owner, true), 7);
  assert.equal(ledgerFlow({ type: "somethingNew", usdc: "7" }, owner, true), 0);
});

test("unknown ledger types are reported, not silently counted", () => {
  const p = summarize({ fills: [], funding: [], ledger: [{ time: 1100, delta: { type: "rewardsClaim", amount: "1" } }], owner, unified: true, start, equity: 101, upnl: 0 });
  assert.deepEqual(p.unknownLedgerTypes, ["rewardsClaim"]);
  assert.equal(p.residual, 1);
});

test("pageByTime follows pages past the per-response cap and de-duplicates edges", async () => {
  const rows = Array.from({ length: 1234 }, (_, i) => ({ time: 1000 + Math.floor(i / 3), id: i })); // 3 rows share each ms
  const calls = [];
  const fetchPage = async (s, e) => { calls.push(s); return rows.filter((r) => r.time >= s && r.time <= e).slice(0, 500); };
  const { pageByTime } = await import("../src/ledger.js");
  const got = await pageByTime(fetchPage, 1000, 5000, (r) => r.id);
  assert.equal(got.length, 1234);
  assert.ok(calls.length >= 3 && calls.length <= 5, `calls ${calls.length}`);
});

test("checkpoint: sums before the mark plus live rows equal a full recompute, across advances", async () => {
  const { aggregate, finish, checkpointBase, applyCheckpoint, CKPT_LAG, CKPT_EVERY, CKPT_FULL } = await import("../src/ledger.js");
  const owner = "0xabc0000000000000000000000000000000000001", H = 3600e3, t0 = 1_794_000_000_000;
  const start = { since: t0, equity: 100, upnl: 0 };
  const all = { fills: [], funding: [], ledger: [] };
  for (let h = 0; h < 40; h++) {
    all.fills.push({ time: t0 + h * H + 5, coin: h % 2 ? "BTC" : "SOL", px: "100", sz: "0.5", fee: "0.05", builderFee: "0.025", closedPnl: String((h % 5) - 2), tid: h, oid: h });
    all.funding.push({ time: t0 + h * H, hash: `f${h}`, delta: { coin: "BTC", usdc: "0.01" } });
  }
  all.ledger.push({ time: t0 + 3 * H, hash: "d1", delta: { type: "deposit", usdc: "25" } });
  const upTo = (rows, asOf) => Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.filter((x) => x.time <= asOf)]));
  const since = (rows, from) => Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.filter((x) => x.time >= from)]));
  let cache = null, saves = 0;
  for (let h = 1; h <= 40; h++) {
    const asOf = t0 + h * H + 10;
    const base = checkpointBase(cache, { start, owner, unified: true, asOf });
    // Only rows from the checkpoint onward are "fetched", as the bot does.
    const { total, next } = applyCheckpoint(base, since(upTo(all, asOf), base.upTo), { asOf });
    const full = aggregate({ ...upTo(all, asOf), owner, unified: true, from: start.since });
    const a = finish(total, { start, equity: 130, upnl: 1, now: asOf }), b = finish(full, { start, equity: 130, upnl: 1, now: asOf });
    for (const k of ["realized", "fees", "builderFees", "funding", "flows", "trades", "volume", "total", "residual"]) assert.ok(Math.abs(a[k] - b[k]) < 1e-9, `${k} at hour ${h}`);
    assert.ok(Math.abs(a.byCoin.BTC.funding - b.byCoin.BTC.funding) < 1e-9);
    if (next) { assert.ok(next.upTo === asOf - CKPT_LAG); cache = next; saves++; }
  }
  assert.ok(saves >= 4 && saves <= 6, `checkpoint advanced ${saves} times in 40h`); // every ~6h, not every cycle
  assert.ok(CKPT_EVERY > CKPT_LAG && CKPT_FULL > CKPT_EVERY);
});

test("checkpoint is discarded when the start point, account or mode changes, or when it is a day old", async () => {
  const { checkpointBase, CKPT_FULL } = await import("../src/ledger.js");
  const owner = "0xAbC0000000000000000000000000000000000001", t0 = 1_794_000_000_000, asOf = t0 + 10 * 3600e3;
  const start = { since: t0, equity: 100 };
  const good = { v: 1, since: t0, owner: owner.toLowerCase(), unified: true, upTo: t0 + 8 * 3600e3, fullAt: t0 + 7 * 3600e3, agg: { realized: 1 } };
  assert.equal(checkpointBase(good, { start, owner, unified: true, asOf }), good);
  const fresh = (c, o = {}) => checkpointBase(c, { start, owner, unified: true, asOf, ...o }).upTo === t0;
  assert.ok(fresh(null));
  assert.ok(fresh({ ...good, since: t0 - 1 }));                 // P&L start re-based
  assert.ok(fresh(good, { unified: false }));                    // account mode changed
  assert.ok(fresh(good, { owner: "0x" + "1".repeat(40) }));      // different account
  assert.ok(fresh({ ...good, upTo: asOf + 1 }));                 // mark in the future
  assert.ok(fresh(good, { asOf: good.fullAt + CKPT_FULL + 1 })); // daily full rebuild
});
