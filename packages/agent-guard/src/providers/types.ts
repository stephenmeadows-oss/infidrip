import type { ProviderRef } from "../receipt.js";
import type { ChainId, DecisionResult, Ruleset } from "../types.js";

/** Providers the interface is shaped for. v1 implements Turnkey only. */
export type ProviderId = "turnkey" | "privy" | "coinbase-cdp" | "safe" | "crossmint";

/** v1 signs on these two networks only. Mainnet chain ids are refused. */
export const TESTNET_CHAINS = ["base-sepolia", "solana-devnet"] as const;
export type TestnetChainId = (typeof TESTNET_CHAINS)[number];

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_MAINNET_CHAIN_ID = 8453;

export interface ProviderCapabilities {
  provider: ProviderId;
  /** A second party must approve before the enclave or contract will sign. */
  coApprove: boolean;
  /** The provider can enforce a per-transaction cap inside its own policy engine. */
  nativeCaps: boolean;
  /** The provider can enforce a recipient allowlist inside its own policy engine. */
  nativeAllowlist: boolean;
  chains: readonly ChainId[];
  /** Enforcement runs in an on-chain contract rather than a vendor enclave. */
  onchainEnforced: boolean;
}

/**
 * How a later adapter would fill the same interface.
 * These presets are notes in data form. They are not implementations.
 */
export const PROVIDER_CAPABILITY_PRESETS: Record<ProviderId, ProviderCapabilities> = {
  turnkey: {
    provider: "turnkey",
    coApprove: true,
    nativeCaps: true,
    nativeAllowlist: true,
    chains: ["base-sepolia", "solana-devnet"],
    onchainEnforced: false,
  },
  privy: {
    provider: "privy",
    coApprove: true,
    nativeCaps: true,
    nativeAllowlist: true,
    chains: ["base-sepolia", "solana-devnet"],
    onchainEnforced: false,
  },
  "coinbase-cdp": {
    provider: "coinbase-cdp",
    coApprove: false,
    nativeCaps: true,
    nativeAllowlist: true,
    chains: ["base-sepolia", "solana-devnet"],
    onchainEnforced: false,
  },
  safe: {
    provider: "safe",
    coApprove: false,
    nativeCaps: true,
    nativeAllowlist: true,
    chains: ["base-sepolia"],
    onchainEnforced: true,
  },
  crossmint: {
    provider: "crossmint",
    coApprove: false,
    nativeCaps: true,
    nativeAllowlist: true,
    chains: ["base-sepolia", "solana-devnet"],
    onchainEnforced: true,
  },
};

export interface SignerAdapter {
  readonly provider: ProviderId;
  capabilities(): ProviderCapabilities;
  listPending(): Promise<ProviderAction[]>;
  fetchAction(ref: ProviderRef): Promise<ProviderAction>;
  approve(ref: ProviderRef, decisionId: string): Promise<ProviderCommand>;
  reject(ref: ProviderRef, decisionId: string, reason: string): Promise<ProviderCommand>;
  getOutcome(ref: ProviderRef): Promise<ProviderOutcome>;
  mirrorBackstop(ruleset: Ruleset, options?: { apply?: boolean }): Promise<BackstopPlan>;
  healthcheck(): Promise<ProviderHealth>;
  startupCheck(): Promise<StartupReport>;
}

export interface ProviderAction {
  ref: ProviderRef;
  status: string;
  chain: TestnetChainId | null;
  payloadHash: string | null;
  raw: unknown;
}

export interface ProviderCommand {
  action: "approve" | "reject";
  ref: ProviderRef;
  decisionId: string;
  activityStatus: string;
}

export interface ProviderOutcome {
  ref: ProviderRef;
  /** `pending` means the provider has not finished. It is not a receipt outcome yet. */
  status: "pending" | "signed" | "broadcast" | "confirmed" | "failed" | "expired" | "rejected";
  txHash: string | null;
}

export interface ProviderHealth {
  ok: boolean;
  provider: ProviderId;
  organizationId: string | null;
  /** Authenticated Turnkey user, when whoami returned one. */
  userId: string | null;
  message: string;
}

export interface StartupReason {
  code:
    | "AGENT_CAN_SIGN_ALONE"
    | "APPROVER_CAN_SIGN_ALONE"
    | "ROLE_OVERLAP"
    | "CONSENSUS_MISSING"
    | "BACKSTOP_MISSING"
    | "CANARY_NOT_RUN"
    | "CANARY_SIGNED"
    | "CANARY_NOT_CONSENSUS"
    | "MAINNET_CHAIN"
    | "AGENT_MISSING"
    | "APPROVER_MISSING"
    | "POLICY_UNREADABLE"
    | "POLICY_ALWAYS_ERRORS";
  message: string;
}

/**
 * `consensus_needed` is a pending canary.
 * `jointly_approved` is a completed canary that has approval votes from both the agent and the approver.
 * `agent_signed_alone` is a completed canary with no approver approval.
 */
export type CanaryVerdict =
  | "not_run"
  | "consensus_needed"
  | "jointly_approved"
  | "agent_signed_alone"
  | "not_consensus";

export interface StartupReport {
  ok: boolean;
  reasons: StartupReason[];
  canaryStatus: string | null;
  canaryVerdict: CanaryVerdict;
}

export interface BackstopPolicy {
  policyName: string;
  effect: "EFFECT_ALLOW" | "EFFECT_DENY";
  consensus: string;
  condition: string;
  notes: string;
}

export interface BackstopPlan {
  policies: BackstopPolicy[];
  applied: boolean;
}

export type GuardCommand = "approve" | "reject" | "hold";

export function commandForDecision(result: DecisionResult): GuardCommand {
  if (result === "allow") return "approve";
  if (result === "escalate") return "hold";
  return "reject";
}

export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterError";
  }
}

export function isTestnetChain(value: string): value is TestnetChainId {
  return (TESTNET_CHAINS as readonly string[]).includes(value);
}
