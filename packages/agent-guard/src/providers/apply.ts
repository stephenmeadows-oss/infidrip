import type { ReceiptWriter, ProviderRef } from "../receipt.js";
import type { Decision } from "../types.js";
import { AdapterError, commandForDecision, isTestnetChain, type GuardCommand, type SignerAdapter, type TestnetChainId } from "./types.js";

export interface GuardDecisionInput {
  decision: Decision;
  ref: ProviderRef;
  decisionId: string;
  intentId: string;
  agentId: string;
  chain: TestnetChainId;
  payloadHash: string;
  rulesetHash: string;
  now: string;
  /** The DECISION receipt must already be durable. Allow does not proceed without it. */
  decisionLogged: boolean;
}

export interface GuardDecisionResult {
  command: GuardCommand;
  sent: boolean;
  activityStatus: string | null;
}

/**
 * Map an Agent Guard decision onto the provider.
 * allow approves by fingerprint, deny rejects, escalate leaves the activity pending.
 */
export async function applyGuardDecision(
  adapter: SignerAdapter,
  input: GuardDecisionInput,
  writer?: ReceiptWriter,
): Promise<GuardDecisionResult> {
  if (!isTestnetChain(input.chain)) {
    throw new AdapterError(`Refusing chain ${input.chain}. v1 allows base-sepolia and solana-devnet only.`);
  }
  const startup = await adapter.startupCheck();
  if (!startup.ok) {
    const detail = startup.reasons.map((reason) => reason.code).join(", ");
    throw new AdapterError(`Startup check failed (${detail}). No approve or reject was sent.`);
  }
  const command = commandForDecision(input.decision.result);
  if (command === "hold") {
    return { command, sent: false, activityStatus: null };
  }
  if (command === "approve" && input.decisionLogged !== true) {
    throw new AdapterError("Refusing to approve before the decision receipt is logged.");
  }
  if (command === "approve") {
    const sent = await adapter.approve(input.ref, input.decisionId);
    if (writer) {
      writer.appendApproveSent({
        intentId: input.intentId,
        agentId: input.agentId,
        chain: input.chain,
        payloadHash: input.payloadHash,
        rulesetHash: input.rulesetHash,
        now: input.now,
        provider: adapter.provider,
        providerRef: { activity_id: input.ref.activity_id, fingerprint: input.ref.fingerprint },
      });
    }
    return { command, sent: true, activityStatus: sent.activityStatus };
  }
  const reason = input.decision.reasons[0] ?? "deny";
  const sent = await adapter.reject(input.ref, input.decisionId, reason);
  if (writer) {
    writer.appendRejectSent({
      intentId: input.intentId,
      agentId: input.agentId,
      chain: input.chain,
      payloadHash: input.payloadHash,
      rulesetHash: input.rulesetHash,
      now: input.now,
      provider: adapter.provider,
      providerRef: { activity_id: input.ref.activity_id, fingerprint: input.ref.fingerprint },
    });
  }
  return { command, sent: true, activityStatus: sent.activityStatus };
}
