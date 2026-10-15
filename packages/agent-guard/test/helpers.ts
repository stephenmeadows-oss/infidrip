import {
  generateRulesKeypair,
  signRuleset,
  type EvaluationInput,
  type LedgerState,
  type PaymentIntent,
  type PriceQuote,
  type Ruleset,
} from "../src/index.js";

export const NOW = "2026-10-10T12:00:00Z";
export const PRICE_AT = "2026-10-10T11:59:30Z";
export const AGENT = "agent007-research";
export const RECIPIENT = "0x1111111111111111111111111111111111111111";
export const SOL_RECIPIENT = "So11111111111111111111111111111111111111112";
export const USDC = "base-sepolia:0xusdc";
export const ETH = "base-sepolia:native";
export const SOL_USDC = "solana-devnet:USDC";

export const keys = generateRulesKeypair();

export function makeRuleset(): Ruleset {
  return {
    schema_version: "agent-guard/ruleset/1",
    ruleset_id: "01JABCDEFGHJKMNPQRSTVWXYZ0",
    version: 3,
    agent_id: AGENT,
    valid_from: "2026-10-06T00:00:00Z",
    expires_at: "2026-11-06T00:00:00Z",
    default_action: "deny",
    chains: ["base-sepolia", "solana-devnet"],
    assets: [
      {
        asset_id: ETH,
        symbol: "ETH",
        decimals: 18,
        max_per_tx_base_units: "2000000000000000",
        price_feed_id: "chainlink:ETH/USD",
      },
      {
        asset_id: USDC,
        symbol: "USDC",
        decimals: 6,
        max_per_tx_base_units: "5000000",
        max_per_period_base_units: "25000000",
        price_feed_id: "chainlink:USDC/USD",
      },
      {
        asset_id: SOL_USDC,
        symbol: "USDC",
        decimals: 6,
        max_per_tx_base_units: "5000000",
        price_feed_id: "pyth:USDC/USD",
      },
    ],
    allowlist: [
      {
        chain: "base-sepolia",
        address: RECIPIENT,
        label: "Data API vendor",
      },
      {
        chain: "solana-devnet",
        address: SOL_RECIPIENT,
        label: "Test merchant",
        expires_at: "2026-10-20T00:00:00Z",
      },
    ],
    caps: {
      max_per_tx_usd: "5.00",
      period_seconds: 86400,
      max_per_period_usd: "25.00",
      max_tx_count_per_period: 50,
      escalate_above_usd: "3.00",
      count_fees: false,
    },
    pricing: {
      max_price_age_seconds: 60,
      max_source_deviation_bps: 100,
      stable_depeg_tolerance_bps: 200,
    },
    allowed_kinds: ["native_transfer", "token_transfer"],
    notify: { on_deny: true, on_escalate: true, channel: "owner-console" },
  };
}

export function quote(assetId: string, priceUsd = "1.00", observedAt = PRICE_AT): PriceQuote {
  return { assetId, priceUsd, source: "test-fixture", observedAt };
}

export function usdcIntent(amount = "1000000", extra?: Partial<PaymentIntent>): PaymentIntent {
  return {
    agentId: AGENT,
    chain: "base-sepolia",
    to: RECIPIENT,
    assetId: USDC,
    amountBaseUnits: amount,
    decimals: 6,
    kind: "token_transfer",
    ...extra,
  };
}

export interface EvalOpts {
  ruleset?: Ruleset;
  intent?: PaymentIntent;
  now?: string;
  ledger?: LedgerState;
  prices?: Record<string, PriceQuote> | "none";
  agentStatus?: EvaluationInput["agentStatus"];
  activeVersion?: EvaluationInput["activeVersion"];
  ownerSignature?: unknown;
  ownerPublicKey?: unknown;
  omitBodyHash?: boolean;
  bodyHash?: unknown;
}

export function evaluation(opts: EvalOpts = {}): EvaluationInput {
  const ruleset = opts.ruleset ?? makeRuleset();
  const signed = signRuleset(ruleset, keys.secretKey);
  const prices =
    opts.prices === "none"
      ? undefined
      : (opts.prices ?? {
          [USDC]: quote(USDC, "1.00"),
          [ETH]: quote(ETH, "2000.00"),
          [SOL_USDC]: quote(SOL_USDC, "1.00"),
        });
  const input: EvaluationInput = {
    ruleset,
    ownerSignature: opts.ownerSignature ?? signed.signature,
    ownerPublicKey: opts.ownerPublicKey ?? signed.publicKey,
    intent: opts.intent ?? usdcIntent(),
    ledger: opts.ledger ?? { spends: [] },
    now: opts.now ?? NOW,
    agentStatus: "agentStatus" in opts ? opts.agentStatus : "active",
  };
  if (prices !== undefined) input.prices = prices;
  if (opts.activeVersion !== undefined) input.activeVersion = opts.activeVersion;
  if (!opts.omitBodyHash) input.bodyHash = opts.bodyHash ?? signed.bodyHash;
  return input;
}
