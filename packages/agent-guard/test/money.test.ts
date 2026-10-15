import assert from "node:assert/strict";
import test from "node:test";
import { ceilDiv, microsToUsd, parseUint, usdMicrosFromBaseUnits, usdToMicros } from "../src/index.js";
import { exceedsDeviationBps, outsideStableBand } from "../src/money.js";

test("uint strings reject floats, signs, and leading zeros", () => {
  assert.equal(parseUint("0"), 0n);
  assert.equal(parseUint("10"), 10n);
  assert.equal(parseUint("9007199254740993"), 9007199254740993n);
  assert.equal(parseUint("01"), null);
  assert.equal(parseUint("1.0"), null);
  assert.equal(parseUint("-1"), null);
  assert.equal(parseUint("1e18"), null);
  assert.equal(parseUint(""), null);
});

test("USD strings convert to micros exactly", () => {
  assert.equal(usdToMicros("0"), 0n);
  assert.equal(usdToMicros("5"), 5_000_000n);
  assert.equal(usdToMicros("5.00"), 5_000_000n);
  assert.equal(usdToMicros("5.1"), 5_100_000n);
  assert.equal(usdToMicros("0.000001"), 1n);
  assert.equal(usdToMicros("5.0000001"), null);
  assert.equal(microsToUsd(5_000_001n), "5.000001");
  assert.equal(microsToUsd(0n), "0.000000");
});

test("base-unit conversion matches the ceiling formula and keeps values above 2^53", () => {
  const price = { numerator: 1_000_000n, scale: 6 };
  assert.equal(usdMicrosFromBaseUnits(1_000_000n, 6, price), 1_000_000n);
  assert.equal(usdMicrosFromBaseUnits(1_000_001n, 6, price), 1_000_001n);
  assert.equal(usdMicrosFromBaseUnits(0n, 18, price), 0n);

  const eth = { numerator: 2000n, scale: 0 };
  assert.equal(usdMicrosFromBaseUnits(10n ** 15n, 18, eth), 2_000_000n);
  assert.equal(usdMicrosFromBaseUnits(10n ** 15n + 1n, 18, eth), 2_000_001n);
  assert.equal(usdMicrosFromBaseUnits(1n, 18, eth), 1n);

  const huge = 9007199254740993n;
  assert.equal(usdMicrosFromBaseUnits(huge, 0, { numerator: 1n, scale: 6 }), huge);
});

test("extra price digits round the USD total up and do not hide a low-side depeg", () => {
  const dusty = { numerator: 10000001n, scale: 7 };
  assert.equal(usdMicrosFromBaseUnits(1_000_000n, 6, dusty), 1_000_001n);
  assert.equal(outsideStableBand({ numerator: 102n, scale: 2 }, 200), false);
  assert.equal(outsideStableBand({ numerator: 10200001n, scale: 7 }, 200), true);
  assert.equal(outsideStableBand({ numerator: 97n, scale: 2 }, 200), true);
  assert.equal(outsideStableBand({ numerator: 98n, scale: 2 }, 200), false);
});

test("source deviation treats the limit as inclusive", () => {
  const one = { numerator: 1n, scale: 0 };
  const onePercent = { numerator: 101n, scale: 2 };
  const over = { numerator: 10101n, scale: 4 };
  assert.equal(exceedsDeviationBps(one, onePercent, 100), false);
  assert.equal(exceedsDeviationBps(one, over, 100), true);
});

test("ceilDiv is exact on the boundary", () => {
  assert.equal(ceilDiv(10n, 5n), 2n);
  assert.equal(ceilDiv(11n, 5n), 3n);
  assert.equal(ceilDiv(0n, 5n), 0n);
});
