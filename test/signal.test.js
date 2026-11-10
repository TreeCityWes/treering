import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSignal } from "../src/hl.js";

const now = 1_794_000_600_000;

test("signal timestamp is the newest history point, not the server clock", () => {
  const sig = parseSignal({ now, coins: [
    { coin: "BTC", score: -19, history: [[now - 400_000, -15], [now - 220_000, -19]] },
    { coin: "ETH", score: 6, history: [[now - 400_000, 2], [now - 215_000, 6]] },
  ] });
  assert.equal(sig.timestamp, now - 215_000);
  assert.equal(sig.timestampFrom, "history");
  assert.equal(sig.serverNow, now);
  assert.deepEqual(sig.coins[0].history, [-15, -19]);
});

test("a frozen feed looks old even though the server clock is current", () => {
  const sig = parseSignal({ now, coins: [{ coin: "BTC", score: 40, history: [[now - 3_600_000, 40]] }] });
  assert.equal((now - sig.timestamp) / 1000, 3600);
});

test("without history the server clock is the fallback, and it is labelled", () => {
  const sig = parseSignal({ now, coins: [{ coin: "BTC", score: 40 }, { coin: "ETH", score: 5, history: "n/a" }] });
  assert.equal(sig.timestamp, now);
  assert.equal(sig.timestampFrom, "server");
});

test("bad payloads and out-of-range scores are rejected", () => {
  assert.throws(() => parseSignal({ now }), /no coins/);
  assert.throws(() => parseSignal(null), /no coins/);
  const sig = parseSignal({ now, coins: [{ coin: "BTC", score: 140 }, { coin: "ETH", score: null }, null] });
  assert.deepEqual(sig.coins.map((c) => c.coin), ["ETH"]);
});
