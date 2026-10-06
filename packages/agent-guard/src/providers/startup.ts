import type { CanaryVerdict, StartupReason, TestnetChainId } from "./types.js";
import { isTestnetChain } from "./types.js";

export interface PolicyView {
  policyName?: string;
  effect: string;
  consensus: string;
  condition: string;
}

export interface CanaryVoteView {
  userId: string;
  selection: string;
}

export interface StartupAuditInput {
  agentUserId: string;
  approverUserId: string;
  policies: PolicyView[];
  /** When the client returned users, both roles must be present. An empty list skips this. */
  userIds?: string[];
  chains: readonly string[];
  canaryStatus: string | null;
  /** Votes from the canary activity. A completed canary needs an approval from the approver. */
  canaryVotes?: readonly CanaryVoteView[];
  requireBackstops?: boolean;
  requireCanary?: boolean;
}

export interface StartupAudit {
  ok: boolean;
  reasons: StartupReason[];
  canaryVerdict: CanaryVerdict;
}

const SIGN_RAW = "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD";

/**
 * Pure check of the documented Turnkey shape:
 * an ALLOW for signing must name both the agent and the approver.
 * A canary may stay in CONSENSUS_NEEDED, or complete only when both users approved.
 * A completed canary with no approver approval means the agent signed alone.
 * A condition that mixes chain payload namespaces always errors, because Turnkey evaluates every clause.
 * A DENY counts as a backstop only when its consensus names the agent or applies to everyone.
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
  let sawExportDeny = false;
  let sawPolicyChangeDeny = false;
  let sawUserChangeDeny = false;

  for (const policy of input.policies) {
    const effect = policy.effect.trim();
    const namespaces = chainNamespacesIn(policy.condition ?? "");
    if (namespaces.length > 1) {
      reasons.push({
        code: "POLICY_ALWAYS_ERRORS",
        message:
          `Policy ${label(policy)} mixes chain payload namespaces (${namespaces.join(", ")}). ` +
          "Turnkey evaluates every clause and does not short circuit, so a clause for a payload that is not in the activity errors the whole policy. " +
          "Split it into one policy per chain. It was not counted as a backstop.",
      });
    }
    if (effect !== "EFFECT_ALLOW" && effect !== "EFFECT_DENY") {
      if (policyMentions(policy, agent) || policyMentions(policy, approver)) {
        reasons.push({
          code: "POLICY_UNREADABLE",
          message: `Policy ${label(policy)} has an unrecognized effect.`,
        });
      }
      continue;
    }
    if (namespaces.length > 1) continue;
    if (effect === "EFFECT_DENY") {
      if (!consensusCoversAgent(policy.consensus ?? "", agent)) continue;
      const condition = policy.condition;
      if (condition.includes("address_table_lookups")) sawAddressTableDeny = true;
      if (condition.includes(SIGN_RAW)) sawRawDeny = true;
      if (condition.includes("eth.tx.to") || condition.includes("solana.tx.transfers")) sawAllowlistDeny = true;
      if (condition.includes("eth.tx.value")) sawValueDeny = true;
      if (isExportDeny(condition)) sawExportDeny = true;
      if (isPolicyChangeDeny(condition)) sawPolicyChangeDeny = true;
      if (isUserChangeDeny(condition)) sawUserChangeDeny = true;
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
    if (!sawExportDeny) missing.push("private key or wallet export");
    if (!sawPolicyChangeDeny) missing.push("policy changes");
    if (!sawUserChangeDeny) missing.push("user or credential changes");
    if (missing.length > 0) {
      reasons.push({
        code: "BACKSTOP_MISSING",
        message: `Missing DENY backstop policies: ${missing.join(", ")}.`,
      });
    }
  }

  const canaryVerdict = classifyCanary(input.canaryStatus, input.canaryVotes ?? [], agent, approver);
  if (requireCanary) {
    if (canaryVerdict === "not_run") {
      reasons.push({
        code: "CANARY_NOT_RUN",
        message:
          "No canary activity was supplied. Submit a 0-value testnet transfer as the agent. It must stay in ACTIVITY_STATUS_CONSENSUS_NEEDED, or complete with approval votes from both the agent and the guard approver.",
      });
    } else if (canaryVerdict === "agent_signed_alone") {
      reasons.push({
        code: "CANARY_SIGNED",
        message:
          "The canary activity completed without an approval vote from the guard approver. The agent was able to sign without the guard.",
      });
    } else if (canaryVerdict === "not_consensus") {
      reasons.push({
        code: "CANARY_NOT_CONSENSUS",
        message: canaryStatusMessage(input.canaryStatus, input.canaryVotes ?? [], agent, approver),
      });
    }
  }

  return { ok: reasons.length === 0, reasons, canaryVerdict };
}

const APPROVED = "VOTE_SELECTION_APPROVED";

/** A completed canary is jointly approved only when both roles cast VOTE_SELECTION_APPROVED. */
export function classifyCanary(
  status: string | null,
  votes: readonly CanaryVoteView[],
  agentUserId: string,
  approverUserId: string,
): CanaryVerdict {
  if (status === null) return "not_run";
  if (status === "ACTIVITY_STATUS_CONSENSUS_NEEDED") return "consensus_needed";
  if (status === "ACTIVITY_STATUS_COMPLETED") {
    const agentApproved = hasApproval(votes, agentUserId);
    const approverApproved = hasApproval(votes, approverUserId);
    if (agentApproved && approverApproved) return "jointly_approved";
    if (!approverApproved) return "agent_signed_alone";
    return "not_consensus";
  }
  return "not_consensus";
}

function hasApproval(votes: readonly CanaryVoteView[], userId: string): boolean {
  const id = userId.trim();
  if (id.length === 0) return false;
  return votes.some((vote) => vote.userId.trim() === id && vote.selection.trim() === APPROVED);
}

function canaryStatusMessage(
  status: string | null,
  votes: readonly CanaryVoteView[],
  agentUserId: string,
  approverUserId: string,
): string {
  if (status === "ACTIVITY_STATUS_COMPLETED" && hasApproval(votes, approverUserId) && !hasApproval(votes, agentUserId)) {
    return "The canary activity completed with an approver vote but no approval vote from the agent.";
  }
  const shown = status && status.length > 0 ? status : "empty";
  return `The canary status is ${shown}. A passing canary is ACTIVITY_STATUS_CONSENSUS_NEEDED, or ACTIVITY_STATUS_COMPLETED with VOTE_SELECTION_APPROVED from both the agent and the guard approver.`;
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

function isExportDeny(condition: string): boolean {
  return (
    condition.includes("ACTIVITY_TYPE_EXPORT_") ||
    condition.includes("activity.action == 'EXPORT'") ||
    condition.includes('activity.action == "EXPORT"')
  );
}

function isPolicyChangeDeny(condition: string): boolean {
  return (
    condition.includes("ACTIVITY_TYPE_CREATE_POLICY") ||
    condition.includes("ACTIVITY_TYPE_UPDATE_POLICY") ||
    condition.includes("ACTIVITY_TYPE_DELETE_POLICY") ||
    condition.includes("ACTIVITY_TYPE_CREATE_POLICIES") ||
    condition.includes("ACTIVITY_TYPE_DELETE_POLICIES") ||
    condition.includes("activity.resource == 'POLICY'") ||
    condition.includes('activity.resource == "POLICY"') ||
    condition.includes("'POLICY'")
  );
}

function isUserChangeDeny(condition: string): boolean {
  return (
    condition.includes("ACTIVITY_TYPE_CREATE_USERS") ||
    condition.includes("ACTIVITY_TYPE_CREATE_API_ONLY_USERS") ||
    condition.includes("ACTIVITY_TYPE_UPDATE_USER") ||
    condition.includes("ACTIVITY_TYPE_DELETE_USERS") ||
    condition.includes("ACTIVITY_TYPE_CREATE_API_KEYS") ||
    condition.includes("ACTIVITY_TYPE_DELETE_API_KEYS") ||
    condition.includes("activity.resource == 'USER'") ||
    condition.includes('activity.resource == "USER"') ||
    condition.includes("activity.resource == 'CREDENTIAL'") ||
    condition.includes('activity.resource == "CREDENTIAL"') ||
    condition.includes("'USER'") ||
    condition.includes("'CREDENTIAL'")
  );
}

function isApproveOnly(condition: string): boolean {
  const text = condition ?? "";
  if (text.includes("activity.action == 'SIGN'") || text.includes('activity.action == "SIGN"')) return false;
  if (text.includes("ACTIVITY_TYPE_SIGN")) return false;
  return text.includes("ACTIVITY_TYPE_APPROVE_ACTIVITY") || text.includes("ACTIVITY_TYPE_REJECT_ACTIVITY");
}

/**
 * Payload keywords from the Turnkey condition table. Each is present for only one
 * activity shape, so two of them in one condition make every evaluation error.
 */
const CHAIN_NAMESPACES = [
  "eth.eip_7702_authorization",
  "eth.eip_712",
  "eth.tx",
  "solana.tx",
  "tron.tx",
  "bitcoin.tx",
  "tempo.tx",
] as const;

export function chainNamespacesIn(condition: string): string[] {
  const text = stripSingleQuoted(condition ?? "");
  return CHAIN_NAMESPACES.filter((namespace) => namespacePresent(text, namespace));
}

function stripSingleQuoted(condition: string): string {
  return condition.replace(/'(?:\\.|[^'])*'/g, "''");
}

function namespacePresent(text: string, namespace: string): boolean {
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf(namespace, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : text.charAt(at - 1);
    const after = text.charAt(at + namespace.length);
    if (isNamespaceBoundary(before) && isNamespaceBoundary(after)) return true;
    from = at + namespace.length;
  }
  return false;
}

function isNamespaceBoundary(char: string): boolean {
  return char.length === 0 || /[^A-Za-z0-9_]/.test(char);
}

/** A DENY applies to the agent's sign request when consensus names that user, or when it applies to everyone. */
function consensusCoversAgent(consensus: string, agentUserId: string): boolean {
  if (isBroadConsensus(consensus)) return true;
  return mentions(consensus, agentUserId);
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
