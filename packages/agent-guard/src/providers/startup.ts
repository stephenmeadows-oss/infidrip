import type { StartupReason, TestnetChainId } from "./types.js";
import { isTestnetChain } from "./types.js";

export interface PolicyView {
  policyName?: string;
  effect: string;
  consensus: string;
  condition: string;
}

export interface StartupAuditInput {
  agentUserId: string;
  approverUserId: string;
  policies: PolicyView[];
  /** When the client returned users, both roles must be present. An empty list skips this. */
  userIds?: string[];
  chains: readonly string[];
  canaryStatus: string | null;
  requireBackstops?: boolean;
  requireCanary?: boolean;
}

export interface StartupAudit {
  ok: boolean;
  reasons: StartupReason[];
}

const SIGN_RAW = "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD";

/**
 * Pure check of the documented Turnkey shape:
 * an ALLOW for signing must name both the agent and the approver,
 * and a canary sign must sit in CONSENSUS_NEEDED rather than complete.
 * This is not a full policy-language interpreter.
 */
export function auditStartup(input: StartupAuditInput): StartupAudit {
  const reasons: StartupReason[] = [];
  const requireBackstops = input.requireBackstops !== false;
  const requireCanary = input.requireCanary !== false;
  const agent = input.agentUserId.trim();
  const approver = input.approverUserId.trim();

  if (agent.length === 0) {
    reasons.push({ code: "AGENT_MISSING", message: "The agent user id is empty." });
  }
  if (approver.length === 0) {
    reasons.push({ code: "APPROVER_MISSING", message: "The approver user id is empty." });
  }
  if (agent.length > 0 && agent === approver) {
    reasons.push({
      code: "ROLE_OVERLAP",
      message: "The agent user and the guard approver must be different users.",
    });
  }
  for (const chain of input.chains) {
    if (!isTestnetChain(chain)) {
      reasons.push({
        code: "MAINNET_CHAIN",
        message: `Chain ${chain} is not a v1 testnet. Allowed chains are base-sepolia and solana-devnet.`,
      });
    }
  }
  if (input.userIds && input.userIds.length > 0) {
    if (!input.userIds.includes(agent)) {
      reasons.push({ code: "AGENT_MISSING", message: "The agent user id is not in the organization user list." });
    }
    if (!input.userIds.includes(approver)) {
      reasons.push({
        code: "APPROVER_MISSING",
        message: "The approver user id is not in the organization user list.",
      });
    }
  }

  let joint = false;
  let sawAddressTableDeny = false;
  let sawRawDeny = false;
  let sawAllowlistDeny = false;
  let sawValueDeny = false;

  for (const policy of input.policies) {
    const effect = policy.effect.trim();
    if (effect !== "EFFECT_ALLOW" && effect !== "EFFECT_DENY") {
      if (policyMentions(policy, agent) || policyMentions(policy, approver)) {
        reasons.push({
          code: "POLICY_UNREADABLE",
          message: `Policy ${label(policy)} has an unrecognized effect.`,
        });
      }
      continue;
    }
    if (effect === "EFFECT_DENY") {
      const condition = policy.condition;
      if (condition.includes("address_table_lookups")) sawAddressTableDeny = true;
      if (condition.includes(SIGN_RAW)) sawRawDeny = true;
      if (condition.includes("eth.tx.to") || condition.includes("solana.tx.transfers")) sawAllowlistDeny = true;
      if (condition.includes("eth.tx.value")) sawValueDeny = true;
      continue;
    }
    if (isApproveOnly(policy.condition)) continue;
    if (isJointSignAllow(policy, agent, approver)) {
      joint = true;
      continue;
    }
    if (agentCanSignAlone(policy, agent, approver)) {
      reasons.push({
        code: "AGENT_CAN_SIGN_ALONE",
        message: `Policy ${label(policy)} lets the agent sign without the guard approver.`,
      });
    } else if (approverCanSignAlone(policy, agent, approver)) {
      reasons.push({
        code: "APPROVER_CAN_SIGN_ALONE",
        message: `Policy ${label(policy)} lets the approver sign. The approver may only approve or reject.`,
      });
    }
  }

  if (!joint && agent.length > 0 && approver.length > 0 && agent !== approver) {
    reasons.push({
      code: "CONSENSUS_MISSING",
      message:
        "No ALLOW policy requires both the agent and the guard approver before a signature. The documented consensus is approvers.any(user, user.id == agent) && approvers.any(user, user.id == approver).",
    });
  }
  if (requireBackstops) {
    const wantsEvm = input.chains.length === 0 || input.chains.includes("base-sepolia");
    const wantsSolana = input.chains.length === 0 || input.chains.includes("solana-devnet");
    const missing: string[] = [];
    if (!sawAllowlistDeny) missing.push("recipient allowlist");
    if (wantsEvm && !sawValueDeny) missing.push("native value cap");
    if (wantsSolana && !sawAddressTableDeny) missing.push("Solana address table lookups");
    if (!sawRawDeny) missing.push("raw payload signing");
    if (missing.length > 0) {
      reasons.push({
        code: "BACKSTOP_MISSING",
        message: `Missing DENY backstop policies: ${missing.join(", ")}.`,
      });
    }
  }

  if (requireCanary) {
    if (input.canaryStatus === null) {
      reasons.push({
        code: "CANARY_NOT_RUN",
        message:
          "No canary activity was supplied. Submit a 0-value testnet transfer as the agent and confirm it stays in ACTIVITY_STATUS_CONSENSUS_NEEDED.",
      });
    } else if (input.canaryStatus === "ACTIVITY_STATUS_COMPLETED") {
      reasons.push({
        code: "CANARY_SIGNED",
        message: "The canary activity completed. The agent was able to sign without the guard.",
      });
    } else if (input.canaryStatus !== "ACTIVITY_STATUS_CONSENSUS_NEEDED") {
      reasons.push({
        code: "CANARY_NOT_CONSENSUS",
        message: `The canary status is ${input.canaryStatus}. The only passing status is ACTIVITY_STATUS_CONSENSUS_NEEDED.`,
      });
    }
  }

  return { ok: reasons.length === 0, reasons };
}

export function agentCanSignAlone(policy: PolicyView, agentUserId: string, approverUserId: string): boolean {
  if (policy.effect.trim() !== "EFFECT_ALLOW" || isApproveOnly(policy.condition)) return false;
  const consensus = policy.consensus ?? "";
  if (isBroadConsensus(consensus)) return true;
  return mentions(consensus, agentUserId) && !mentions(consensus, approverUserId);
}

export function approverCanSignAlone(policy: PolicyView, agentUserId: string, approverUserId: string): boolean {
  if (policy.effect.trim() !== "EFFECT_ALLOW" || isApproveOnly(policy.condition)) return false;
  const consensus = policy.consensus ?? "";
  if (isBroadConsensus(consensus)) return true;
  return mentions(consensus, approverUserId) && !mentions(consensus, agentUserId);
}

export function isJointSignAllow(policy: PolicyView, agentUserId: string, approverUserId: string): boolean {
  if (policy.effect.trim() !== "EFFECT_ALLOW" || isApproveOnly(policy.condition)) return false;
  const consensus = policy.consensus ?? "";
  if (isBroadConsensus(consensus)) return false;
  return mentions(consensus, agentUserId) && mentions(consensus, approverUserId);
}

/** Fixture model of a canary sign. A payload inside the backstops is assumed. */
export function simulateCanaryStatus(policies: PolicyView[], agentUserId: string, approverUserId: string): string {
  if (policies.some((policy) => agentCanSignAlone(policy, agentUserId, approverUserId))) {
    return "ACTIVITY_STATUS_COMPLETED";
  }
  if (policies.some((policy) => isJointSignAllow(policy, agentUserId, approverUserId))) {
    return "ACTIVITY_STATUS_CONSENSUS_NEEDED";
  }
  return "ACTIVITY_STATUS_FAILED";
}

export function chainsOf(wallets: readonly { chain: string }[]): TestnetChainId[] {
  const out: TestnetChainId[] = [];
  for (const wallet of wallets) {
    if (isTestnetChain(wallet.chain) && !out.includes(wallet.chain)) out.push(wallet.chain);
  }
  return out;
}

function isApproveOnly(condition: string): boolean {
  const text = condition ?? "";
  if (text.includes("activity.action == 'SIGN'") || text.includes('activity.action == "SIGN"')) return false;
  if (text.includes("ACTIVITY_TYPE_SIGN")) return false;
  return text.includes("ACTIVITY_TYPE_APPROVE_ACTIVITY") || text.includes("ACTIVITY_TYPE_REJECT_ACTIVITY");
}

function isBroadConsensus(consensus: string): boolean {
  const trimmed = consensus.trim();
  if (trimmed.length === 0 || trimmed === "true") return true;
  return /^approvers\.count\(\)\s*>=\s*1$/.test(trimmed);
}

function mentions(consensus: string, userId: string): boolean {
  return userId.length > 0 && consensus.includes(userId);
}

function policyMentions(policy: PolicyView, userId: string): boolean {
  return mentions(policy.consensus ?? "", userId) || mentions(policy.condition ?? "", userId);
}

function label(policy: PolicyView): string {
  return policy.policyName && policy.policyName.length > 0 ? policy.policyName : "unnamed";
}
