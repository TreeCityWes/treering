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
