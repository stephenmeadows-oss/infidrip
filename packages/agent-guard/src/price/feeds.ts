import type { PriceQuote, RulesetAsset } from "../types.js";

/**
 * Mainnet pair catalog for testnet assets.
 * Testnet tokens have no market. Base Sepolia and Solana devnet assets use the
 * mainnet ETH/USD, USDC/USD, or SOL/USD pair so caps see realistic numbers.
 *
 * Chainlink values are public proxy addresses. Pyth values are public price feed ids.
 * They are not API keys. This module does not open a socket.
 *
 * A live Pyth Hermes read needs PYTH_API_KEY (Bearer token, required since 2026-08-26).
 * That client is not implemented, and the variable is never read.
 * A live Chainlink read is an eth_call on a mainnet RPC and needs no API key.
 * That client is not implemented either. Callers pass a PriceSource. Tests use the mock.
 */

export type PairName = "ETH/USD" | "USDC/USD" | "SOL/USD";
export type FeedSourceName = "chainlink" | "pyth";

export interface FeedEndpoint {
  source: FeedSourceName;
  pair: PairName;
  /** Public Chainlink proxy or Pyth price feed id. Not a secret. */
  feedId: string;
  /** Where a Chainlink proxy is deployed. Pyth ids are not chain-specific. */
  network: "base" | "ethereum" | "pyth";
}

export interface MainnetPair {
  pair: PairName;
  stable: boolean;
  chainlink: FeedEndpoint;
  pyth: FeedEndpoint;
}

export interface SourceReading {
  priceUsd: string;
  observedAt: string;
}

export interface PriceSource {
  read(endpoint: FeedEndpoint): Promise<SourceReading | null>;
}

export const CHAINLINK_BASE_ETH_USD = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
export const CHAINLINK_BASE_USDC_USD = "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B";
export const CHAINLINK_ETH_SOL_USD = "0x4ffC43a60e009B551865A93d232E33Fce9f01507";

export const PYTH_ETH_USD = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
export const PYTH_USDC_USD = "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";
export const PYTH_SOL_USD = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

const PAIRS: Record<PairName, MainnetPair> = {
  "ETH/USD": {
    pair: "ETH/USD",
    stable: false,
    chainlink: {
      source: "chainlink",
      pair: "ETH/USD",
      feedId: CHAINLINK_BASE_ETH_USD,
      network: "base",
    },
    pyth: { source: "pyth", pair: "ETH/USD", feedId: PYTH_ETH_USD, network: "pyth" },
  },
  "USDC/USD": {
    pair: "USDC/USD",
    stable: true,
    chainlink: {
      source: "chainlink",
      pair: "USDC/USD",
      feedId: CHAINLINK_BASE_USDC_USD,
      network: "base",
    },
    pyth: { source: "pyth", pair: "USDC/USD", feedId: PYTH_USDC_USD, network: "pyth" },
  },
  "SOL/USD": {
    pair: "SOL/USD",
    stable: false,
    chainlink: {
      source: "chainlink",
      pair: "SOL/USD",
      feedId: CHAINLINK_ETH_SOL_USD,
      network: "ethereum",
    },
    pyth: { source: "pyth", pair: "SOL/USD", feedId: PYTH_SOL_USD, network: "pyth" },
  },
};

/** Well-known USDC contracts. EVM ids are matched in lowercase. Solana mints are case-sensitive. */
const CONTRACT_PAIRS: Record<string, PairName> = {
  "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC/USD",
  "base-sepolia:0x036cbd53842c5426634e7929541ec2318f3dcf7e": "USDC/USD",
  "solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC/USD",
  "solana-devnet:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": "USDC/USD",
};

const FEED_ID_RE = /^(chainlink|pyth):(ETH|USDC|SOL)\/USD$/;

/**
 * Resolve the mainnet pair for a ruleset asset.
 * A price_feed_id that names a known pair wins. An unknown price_feed_id does not fall through.
 * Otherwise a known contract, then a native asset, then the symbol.
 */
export function pairForAsset(asset: Pick<RulesetAsset, "asset_id" | "symbol" | "price_feed_id">): MainnetPair | null {
  if (asset.price_feed_id !== undefined) {
    const named = pairFromFeedId(asset.price_feed_id);
    return named ? PAIRS[named] : null;
  }
  const byContract = CONTRACT_PAIRS[contractKey(asset.asset_id)];
  if (byContract) return PAIRS[byContract];
  const native = nativePair(asset.asset_id);
  if (native) return PAIRS[native];
  const bySymbol = symbolPair(asset.symbol);
  return bySymbol ? PAIRS[bySymbol] : null;
}

/**
 * Chainlink is the primary source for Base assets. Pyth is the primary source for Solana assets.
 * A price_feed_id prefix overrides that default. The other source is the cross-check.
 */
export function feedOrder(asset: Pick<RulesetAsset, "asset_id" | "price_feed_id">): [FeedSourceName, FeedSourceName] {
  const id = asset.price_feed_id ?? "";
  if (id.startsWith("pyth:")) return ["pyth", "chainlink"];
  if (id.startsWith("chainlink:")) return ["chainlink", "pyth"];
  if (asset.asset_id.startsWith("solana")) return ["pyth", "chainlink"];
  return ["chainlink", "pyth"];
}

/**
 * Read both sources and build a quote. Staleness, deviation, and the depeg band are
 * enforced later by assessQuote. A missing or thrown read returns null.
 */
export async function readPairQuote(
  asset: Pick<RulesetAsset, "asset_id" | "symbol" | "price_feed_id">,
  source: PriceSource,
): Promise<PriceQuote | null> {
  const pair = pairForAsset(asset);
  if (!pair) return null;
  const [primaryName, secondName] = feedOrder(asset);
  const primaryEndpoint = pair[primaryName];
  const secondEndpoint = pair[secondName];
  let primary: SourceReading | null;
  let second: SourceReading | null;
  try {
    primary = await source.read(primaryEndpoint);
    second = await source.read(secondEndpoint);
  } catch {
    return null;
  }
  if (!usable(primary) || !usable(second)) return null;
  return {
    assetId: asset.asset_id,
    priceUsd: primary.priceUsd,
    source: `${primaryEndpoint.source}:${primaryEndpoint.pair}`,
    observedAt: primary.observedAt,
    second: {
      priceUsd: second.priceUsd,
      source: `${secondEndpoint.source}:${secondEndpoint.pair}`,
      observedAt: second.observedAt,
    },
    isStable: pair.stable,
  };
}

function usable(reading: SourceReading | null): reading is SourceReading {
  return reading !== null && typeof reading.priceUsd === "string" && reading.priceUsd.length > 0 && typeof reading.observedAt === "string";
}

function pairFromFeedId(value: string): PairName | null {
  const match = FEED_ID_RE.exec(value);
  if (!match) return null;
  return `${match[2]}/USD` as PairName;
}

function symbolPair(symbol: string | undefined): PairName | null {
  if (symbol === "ETH") return "ETH/USD";
  if (symbol === "USDC") return "USDC/USD";
  if (symbol === "SOL") return "SOL/USD";
  return null;
}

function nativePair(assetId: string): PairName | null {
  if (!assetId.endsWith(":native")) return null;
  if (assetId.startsWith("base")) return "ETH/USD";
  if (assetId.startsWith("solana")) return "SOL/USD";
  return null;
}

function contractKey(assetId: string): string {
  const index = assetId.indexOf(":");
  if (index <= 0) return assetId;
  const chain = assetId.slice(0, index);
  const rest = assetId.slice(index + 1);
  if (chain === "solana" || chain === "solana-devnet") return assetId;
  return `${chain}:${rest.toLowerCase()}`;
}
