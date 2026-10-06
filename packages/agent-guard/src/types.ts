import type { ReasonCode } from "./codes.js";

export const CHAINS = ["base", "base-sepolia", "solana", "solana-devnet"] as const;

export type ChainId = (typeof CHAINS)[number];

export type PaymentKind = "native_transfer" | "token_transfer";

export type AgentStatus = "active" | "paused" | "revoked";

export type SpendState = "held" | "committed" | "released";

export type DecisionResult = "allow" | "deny" | "escalate";

export interface RulesetAsset {
  asset_id: string;
  symbol?: string;
  decimals: number;
  max_per_tx_base_units?: string;
  max_per_period_base_units?: string;
  price_feed_id?: string;
  require_price?: boolean;
}

export interface RulesetAllowlistEntry {
  chain: ChainId;
  address: string;
  label?: string;
  expires_at?: string;
  max_per_tx_usd?: string;
  allowed_assets?: string[];
}

export interface RulesetCaps {
  max_per_tx_usd: string;
  period_seconds: number;
  max_per_period_usd: string;
  max_tx_count_per_period?: number;
  escalate_above_usd?: string;
  count_fees?: boolean;
}

export interface RulesetPricing {
  max_price_age_seconds?: number;
  max_source_deviation_bps?: number;
  stable_depeg_tolerance_bps?: number;
}

export interface Ruleset {
  schema_version: "agent-guard/ruleset/1";
  ruleset_id: string;
  version: number;
  agent_id: string;
  valid_from: string;
  expires_at: string;
  default_action: "deny";
  chains?: ChainId[];
  assets: RulesetAsset[];
  allowlist: RulesetAllowlistEntry[];
  caps: RulesetCaps;
  pricing?: RulesetPricing;
  allowed_kinds?: PaymentKind[];
  notify?: {
    on_deny?: boolean;
    on_escalate?: boolean;
    channel?: string;
  };
}

/** One proposed transfer. v1 denies every other kind. */
export interface PaymentIntent {
  agentId: string;
  chain: ChainId;
  to: string;
  assetId: string;
  amountBaseUnits: string;
  decimals: number;
  kind: PaymentKind | "unsupported" | string;
  fee?: FeeIntent;
}

/** Network fee counted toward USD caps only when the ruleset sets count_fees. */
export interface FeeIntent {
  assetId: string;
  amountBaseUnits: string;
  decimals: number;
}

/**
 * One prior spend or reservation.
 * `usdMicros` is an integer string of USD with 6 decimal places (1 USD = 1000000).
 * Released rows are ignored. Held and committed rows inside the rolling window count.
 */
export interface SpendRecord {
  assetId: string;
  amountBaseUnits: string;
  usdMicros?: string;
  at: string;
  state: SpendState;
}

export interface LedgerState {
  spends: SpendRecord[];
}

/**
 * USD quote. `readPairQuote` can fill this from a PriceSource.
 * The quote is data. This package does not retrieve prices from the network.
 */
export interface PriceQuote {
  assetId: string;
  /** Decimal USD string. More than 6 fractional digits are kept, then USD is rounded up. */
  priceUsd: string;
  source: string;
  /** RFC 3339 timestamp of the observation. */
  observedAt: string;
  /** Optional second source. When present, deviation is enforced. */
  second?: {
    priceUsd: string;
    source: string;
    observedAt: string;
  };
  /**
   * When true, the quote must sit inside the stablecoin depeg band.
   * The ruleset schema has no is_stable field. M4 sets this from asset registration.
   */
  isStable?: boolean;
}

export interface RuleCheck {
  code: string;
  passed: boolean;
  message: string;
}

export interface Decision {
  result: DecisionResult;
  /** Every rule evaluated, in the fixed order, including passes. Stops at the first failure. */
  rulesChecked: RuleCheck[];
  /** Failing codes. Empty when the result is allow. Contains ESCALATE when the result is escalate. */
  reasons: ReasonCode[];
  /** Human-readable sentences, one per reason, same order. */
  reasonMessages: string[];
  /** USD value of the payment plus fee when it was computed, always 6 decimal places. */
  usdValue?: string;
}

/**
 * Inputs to the pure evaluator.
 * `now` is the guard clock. The function does not read the system clock.
 * Fields are `unknown` so malformed caller data is denied instead of thrown.
 */
export interface EvaluationInput {
  ruleset: unknown;
  ownerSignature: unknown;
  ownerPublicKey: unknown;
  /** Lowercase hex SHA-256 of the canonical ruleset. Checked when provided. */
  bodyHash?: unknown;
  /** When set, ruleset.version must be strictly greater. */
  activeVersion?: unknown;
  intent: unknown;
  /** Omitted or `{ spends: [] }` means no prior spend. */
  ledger?: unknown;
  now: unknown;
  /** Map of asset id to quote. Omitted means no prices, which denies USD caps. */
  prices?: unknown;
  agentStatus?: unknown;
}

export interface SchemaIssue {
  path: string;
  message: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
