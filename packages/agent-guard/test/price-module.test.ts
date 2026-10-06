import assert from "node:assert/strict";
import test from "node:test";
import { PriceFeedError } from "../src/price/mock.js";
import {
  CHAINLINK_BASE_ETH_USD,
  CHAINLINK_BASE_USDC_USD,
  CHAINLINK_ETH_SOL_USD,
  PYTH_ETH_USD,
  PYTH_SOL_USD,
  PYTH_USDC_USD,
  createLivePriceSource,
  createMockPriceSource,
  feedOrder,
  pairForAsset,
  readPairQuote,
} from "../src/index.js";
import { PRICE_AT } from "./helpers.js";

test("testnet assets map to the same mainnet feeds", () => {
  const base = pairForAsset({ asset_id: "base:native" });
  const sepolia = pairForAsset({ asset_id: "base-sepolia:native" });
  const sol = pairForAsset({ asset_id: "solana:native" });
  const solDev = pairForAsset({ asset_id: "solana-devnet:native" });
  assert.ok(base && sepolia && sol && solDev);
  assert.equal(base.chainlink.feedId, CHAINLINK_BASE_ETH_USD);
  assert.equal(sepolia.chainlink.feedId, base.chainlink.feedId);
  assert.equal(base.pyth.feedId, PYTH_ETH_USD);
  assert.equal(sepolia.pyth.feedId, PYTH_ETH_USD);
  assert.equal(sol.pyth.feedId, PYTH_SOL_USD);
  assert.equal(solDev.pyth.feedId, sol.pyth.feedId);
  assert.equal(sol.chainlink.feedId, CHAINLINK_ETH_SOL_USD);
  assert.equal(sol.chainlink.network, "ethereum");

  const usdc = pairForAsset({
    asset_id: "base-sepolia:0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  });
  assert.equal(usdc?.pair, "USDC/USD");
  assert.equal(usdc?.stable, true);
  assert.equal(usdc?.chainlink.feedId, CHAINLINK_BASE_USDC_USD);
  assert.equal(usdc?.pyth.feedId, PYTH_USDC_USD);

  const devnetMint = pairForAsset({
    asset_id: "solana-devnet:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  });
  assert.equal(devnetMint?.pair, "USDC/USD");
  assert.deepEqual(feedOrder({ asset_id: "solana-devnet:native" }), ["pyth", "chainlink"]);
  assert.deepEqual(feedOrder({ asset_id: "base-sepolia:native" }), ["chainlink", "pyth"]);
  assert.deepEqual(
    feedOrder({ asset_id: "base-sepolia:0xusdc", price_feed_id: "pyth:USDC/USD" }),
    ["pyth", "chainlink"],
  );
  assert.equal(pairForAsset({ asset_id: "base-sepolia:0xusdc", price_feed_id: "chainlink:DOGE/USD" }), null);
});

test("readPairQuote keeps both sources and drops a missing cross-check", async () => {
  const source = createMockPriceSource();
  source.set("chainlink:USDC/USD", { priceUsd: "1.00", observedAt: PRICE_AT });
  source.set("pyth:USDC/USD", { priceUsd: "1.01", observedAt: PRICE_AT });
  const asset = { asset_id: "base-sepolia:0xusdc", symbol: "USDC", price_feed_id: "chainlink:USDC/USD" };
  const quote = await readPairQuote(asset, source);
  assert.ok(quote);
  assert.equal(quote.source, "chainlink:USDC/USD");
  assert.equal(quote.second?.source, "pyth:USDC/USD");
  assert.equal(quote.second?.priceUsd, "1.01");
  assert.equal(quote.isStable, true);

  source.set("pyth:USDC/USD", null);
  assert.equal(await readPairQuote(asset, source), null);

  source.kill();
  await assert.rejects(source.read({ source: "pyth", pair: "USDC/USD", feedId: PYTH_USDC_USD, network: "pyth" }), PriceFeedError);
  await assert.rejects(createLivePriceSource().read({ source: "pyth", pair: "ETH/USD", feedId: PYTH_ETH_USD, network: "pyth" }), (error: unknown) => {
    assert.ok(error instanceof PriceFeedError);
    assert.match(error.message, /PYTH_API_KEY/);
    return true;
  });
});
