import assert from "node:assert/strict";
import test from "node:test";
import { isInRollingWindow, parseTimeMs } from "../src/time.js";

const samples = [
  "1970-01-01T00:00:00Z",
  "2000-01-01T00:00:00Z",
  "2024-02-29T12:30:45Z",
  "2026-10-06T00:00:00Z",
  "2026-10-06T00:00:00.123Z",
  "2026-10-06T00:00:00+00:00",
  "2026-10-06T05:00:00-05:00",
  "2026-11-05T23:59:59.999Z",
  "9999-12-31T23:59:59Z",
];

test("timestamps match the UTC instant Date.parse accepts", () => {
  for (const sample of samples) {
    assert.equal(parseTimeMs(sample), Date.parse(sample), sample);
  }
  assert.equal(parseTimeMs("2026-10-06T05:00:00-05:00"), parseTimeMs("2026-10-06T10:00:00Z"));
});

test("invalid calendar dates and loose formats are rejected", () => {
  for (const bad of [
    "2023-02-29T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-10-06T00:00:60Z",
    "2026-10-06 00:00:00Z",
    "2026-10-06T00:00:00z",
    "2026-10-06",
    "",
    "1969-12-31T23:59:59Z",
  ]) {
    assert.equal(parseTimeMs(bad), null, bad);
  }
});

test("rolling window is half-open on the old edge", () => {
  const now = parseTimeMs("2026-10-10T12:00:00Z");
  assert.ok(now !== null);
  const period = 86400;
  assert.equal(isInRollingWindow(now, now, period), true);
  assert.equal(isInRollingWindow(now - period * 1000 + 1, now, period), true);
  assert.equal(isInRollingWindow(now - period * 1000, now, period), false);
  assert.equal(isInRollingWindow(now + 1, now, period), false);
});
