import {
  exceedsDeviationBps,
  isPositiveDecimal,
  outsideStableBand,
  parsePrice,
  type Decimal,
} from "./money.js";
import { parseTimeMs } from "./time.js";
import { isRecord } from "./types.js";

/** Prices more than this far in the future are rejected. */
export const PRICE_FUTURE_SKEW_MS = 5_000;

export interface PricingBounds {
  maxPriceAgeSeconds: number;
  maxSourceDeviationBps: number;
  stableDepegToleranceBps: number;
}

export interface AcceptedPrice {
  price: Decimal;
  source: string;
}

const QUOTE_KEYS = new Set(["assetId", "priceUsd", "source", "observedAt", "second", "isStable"]);
const SECOND_KEYS = new Set(["priceUsd", "source", "observedAt"]);

/**
 * Check one caller-supplied quote.
 * Missing feeds are the caller's concern. This only accepts or rejects a quote object.
 */
export function assessQuote(
  raw: unknown,
  expectedAssetId: string,
  bounds: PricingBounds,
  nowMs: number,
): { ok: true; price: AcceptedPrice } | { ok: false; message: string } {
  if (!isRecord(raw)) {
    return { ok: false, message: `Price for ${expectedAssetId} must be an object.` };
  }
  const extra = unexpectedKey(raw, QUOTE_KEYS);
  if (extra) {
    return { ok: false, message: `Price for ${expectedAssetId} has unknown field ${extra}.` };
  }
  if (raw.assetId !== expectedAssetId) {
    return {
      ok: false,
      message: `Price asset id does not match ${expectedAssetId}.`,
    };
  }
  if (typeof raw.source !== "string" || raw.source.length === 0) {
    return { ok: false, message: `Price for ${expectedAssetId} is missing a source.` };
  }
  if (typeof raw.priceUsd !== "string") {
    return { ok: false, message: `Price for ${expectedAssetId} must be a decimal string.` };
  }
  const price = parsePrice(raw.priceUsd);
  if (!price || !isPositiveDecimal(price)) {
    return { ok: false, message: `Price for ${expectedAssetId} must be greater than zero.` };
  }
  if (typeof raw.observedAt !== "string") {
    return { ok: false, message: `Price for ${expectedAssetId} is missing observedAt.` };
  }
  const observedAtMs = parseTimeMs(raw.observedAt);
  if (observedAtMs === null) {
    return { ok: false, message: `Price for ${expectedAssetId} has an unusable observedAt.` };
  }
  const freshness = freshnessError(observedAtMs, nowMs, bounds.maxPriceAgeSeconds);
  if (freshness) {
    return { ok: false, message: `${freshness} Asset ${expectedAssetId}.` };
  }

  const isStable = raw.isStable === true;
  if (raw.isStable !== undefined && typeof raw.isStable !== "boolean") {
    return { ok: false, message: `Price for ${expectedAssetId} has a non-boolean isStable flag.` };
  }
  if (isStable && outsideStableBand(price, bounds.stableDepegToleranceBps)) {
    return {
      ok: false,
      message: `Stablecoin price for ${expectedAssetId} is outside the depeg tolerance.`,
    };
  }

  if (raw.second !== undefined) {
    const second = assessSecond(raw.second, expectedAssetId, bounds, nowMs, price, isStable);
    if (!second.ok) return second;
  }

  return { ok: true, price: { price, source: raw.source } };
}

function assessSecond(
  raw: unknown,
  assetId: string,
  bounds: PricingBounds,
  nowMs: number,
  primary: Decimal,
  isStable: boolean,
): { ok: true } | { ok: false; message: string } {
  if (!isRecord(raw)) {
    return { ok: false, message: `Second price for ${assetId} must be an object.` };
  }
  const extra = unexpectedKey(raw, SECOND_KEYS);
  if (extra) {
    return { ok: false, message: `Second price for ${assetId} has unknown field ${extra}.` };
  }
  if (typeof raw.source !== "string" || raw.source.length === 0) {
    return { ok: false, message: `Second price for ${assetId} is missing a source.` };
  }
  if (typeof raw.priceUsd !== "string") {
    return { ok: false, message: `Second price for ${assetId} must be a decimal string.` };
  }
  const price = parsePrice(raw.priceUsd);
  if (!price || !isPositiveDecimal(price)) {
    return { ok: false, message: `Second price for ${assetId} must be greater than zero.` };
  }
  if (typeof raw.observedAt !== "string") {
    return { ok: false, message: `Second price for ${assetId} is missing observedAt.` };
  }
  const observedAtMs = parseTimeMs(raw.observedAt);
  if (observedAtMs === null) {
    return { ok: false, message: `Second price for ${assetId} has an unusable observedAt.` };
  }
  const freshness = freshnessError(observedAtMs, nowMs, bounds.maxPriceAgeSeconds);
  if (freshness) {
    return { ok: false, message: `Second source: ${freshness} Asset ${assetId}.` };
  }
  if (exceedsDeviationBps(primary, price, bounds.maxSourceDeviationBps)) {
    return {
      ok: false,
      message: `Price sources for ${assetId} differ by more than ${bounds.maxSourceDeviationBps} bps.`,
    };
  }
  if (isStable && outsideStableBand(price, bounds.stableDepegToleranceBps)) {
    return {
      ok: false,
      message: `Second stablecoin price for ${assetId} is outside the depeg tolerance.`,
    };
  }
  return { ok: true };
}

function freshnessError(observedAtMs: number, nowMs: number, maxAgeSeconds: number): string | null {
  if (observedAtMs > nowMs + PRICE_FUTURE_SKEW_MS) {
    return "Price timestamp is more than 5 seconds in the future.";
  }
  if (nowMs - observedAtMs > maxAgeSeconds * 1000) {
    return `Price is older than ${maxAgeSeconds} seconds.`;
  }
  return null;
}

function unexpectedKey(value: Record<string, unknown>, allowed: Set<string>): string | null {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return key;
  }
  return null;
}
