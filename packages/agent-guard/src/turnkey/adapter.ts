import type { ProviderRef } from "../receipt.js";
import { buildBackstopPolicies } from "../providers/backstop.js";
import { auditStartup, chainsOf } from "../providers/startup.js";
import {
  AdapterError,
  PROVIDER_CAPABILITY_PRESETS,
  isTestnetChain,
  type ProviderAction,
  type ProviderOutcome,
  type SignerAdapter,
  type StartupReport,
  type TestnetChainId,
} from "../providers/types.js";
import type { Ruleset } from "../types.js";
import type { TurnkeyActivity, TurnkeyClient } from "./client.js";

export interface TurnkeyAdapterConfig {
  organizationId: string;
  agentUserId: string;
  approverUserId: string;
  wallets: readonly { walletId: string; chain: TestnetChainId }[];
  requireBackstops?: boolean;
  requireCanary?: boolean;
}

/** Turnkey approver adapter. approve and reject run only after startupCheck passes. */
export function createTurnkeyAdapter(client: TurnkeyClient, config: TurnkeyAdapterConfig): SignerAdapter & {
  startupCheck(): Promise<StartupReport>;
} {
  for (const wallet of config.wallets) {
    if (!isTestnetChain(wallet.chain)) {
      throw new AdapterError(`Refusing wallet chain ${wallet.chain}. v1 allows base-sepolia and solana-devnet only.`);
    }
  }
  let ready = false;
  const approved = new Set<string>();

  async function startupCheck(): Promise<StartupReport> {
    const [policies, users, canary] = await Promise.all([
      client.listPolicies(),
      client.listUsers(),
      client.submitCanary(),
    ]);
    const audit = auditStartup({
      agentUserId: config.agentUserId,
      approverUserId: config.approverUserId,
      policies,
      userIds: users.map((user) => user.userId),
      chains: chainsOf(config.wallets),
      wallets: config.wallets,
      canaryStatus: canary?.status ?? null,
      canaryVotes: canary?.votes ?? [],
      requireBackstops: config.requireBackstops,
      requireCanary: config.requireCanary,
    });
    ready = audit.ok;
    return {
      ok: audit.ok,
      reasons: audit.reasons,
      canaryStatus: canary?.status ?? null,
      canaryVerdict: audit.canaryVerdict,
    };
  }

  function assertReady(): void {
    if (!ready) {
      throw new AdapterError("Startup check has not passed. Refusing to approve or reject.");
    }
  }

  function requireFingerprint(ref: ProviderRef): string {
    if (typeof ref.fingerprint !== "string" || ref.fingerprint.length === 0) {
      throw new AdapterError("A Turnkey fingerprint is required.");
    }
    return ref.fingerprint;
  }

  return {
    provider: "turnkey",
    capabilities() {
      return { ...PROVIDER_CAPABILITY_PRESETS.turnkey, chains: ["base-sepolia", "solana-devnet"] };
    },
    async listPending() {
      const activities = await client.listPending();
      return activities.map(toAction);
    },
    async fetchAction(ref) {
      return toAction(await client.getActivity(ref));
    },
    async approve(ref, decisionId) {
      assertReady();
      const fingerprint = requireFingerprint(ref);
      if (approved.has(fingerprint)) {
        throw new AdapterError("This fingerprint was already approved. Refusing a second approval.");
      }
      const activity = await client.approveActivity(fingerprint);
      approved.add(fingerprint);
      return { action: "approve", ref, decisionId, activityStatus: activity.status };
    },
    async reject(ref, decisionId, reason) {
      assertReady();
      if (reason.trim().length === 0) throw new AdapterError("A reject reason is required.");
      const fingerprint = requireFingerprint(ref);
      if (approved.has(fingerprint)) {
        throw new AdapterError("This fingerprint was already approved. Refusing to reject it afterwards.");
      }
      const activity = await client.rejectActivity(fingerprint);
      return { action: "reject", ref, decisionId, activityStatus: activity.status };
    },
    async getOutcome(ref) {
      const activity = await client.getActivity(ref);
      return {
        ref,
        status: outcomeStatus(activity.status),
        txHash: null,
      };
    },
    async mirrorBackstop(ruleset: Ruleset, options?: { apply?: boolean }) {
      const policies = buildBackstopPolicies({
        ruleset,
        agentUserId: config.agentUserId,
        approverUserId: config.approverUserId,
        wallets: config.wallets,
      });
      const apply = options?.apply === true;
      if (!apply) return { policies, applied: false };
      if (!client.createPolicies) {
        throw new AdapterError(
          "This Turnkey client will not create policies. Review the generated policies and create them in the Turnkey dashboard.",
        );
      }
      await client.createPolicies(policies.map((policy) => ({ ...policy, policyId: null })));
      return { policies, applied: true };
    },
    async healthcheck() {
      const identity = await client.whoami();
      const orgMatch = identity.organizationId === config.organizationId;
      const userId = identity.userId;
      if (userId !== null && userId === config.agentUserId) {
        return {
          ok: false,
          provider: "turnkey" as const,
          organizationId: identity.organizationId,
          userId,
          message:
            "Turnkey whoami authenticated as the agent user. TURNKEY_API_KEY must be the approver user's API key. Do not use the agent key for the guard.",
        };
      }
      if (!orgMatch) {
        return {
          ok: false,
          provider: "turnkey" as const,
          organizationId: identity.organizationId,
          userId,
          message: "Turnkey whoami did not match the configured organization.",
        };
      }
      if (userId !== config.approverUserId) {
        return {
          ok: false,
          provider: "turnkey" as const,
          organizationId: identity.organizationId,
          userId,
          message:
            "Turnkey whoami did not authenticate as the configured approver user. TURNKEY_API_KEY must be that approver's API key.",
        };
      }
      return {
        ok: true,
        provider: "turnkey" as const,
        organizationId: identity.organizationId,
        userId,
        message: "Turnkey whoami matched the configured organization and approver user.",
      };
    },
    startupCheck,
  };
}

function toAction(activity: TurnkeyActivity): ProviderAction {
  return {
    ref: { activity_id: activity.id, fingerprint: activity.fingerprint },
    status: activity.status,
    chain: null,
    payloadHash: activity.payloadHash,
    raw: activity,
  };
}

function outcomeStatus(status: string): ProviderOutcome["status"] {
  if (status === "ACTIVITY_STATUS_COMPLETED") return "signed";
  if (status === "ACTIVITY_STATUS_REJECTED") return "rejected";
  if (status === "ACTIVITY_STATUS_FAILED") return "failed";
  if (status === "ACTIVITY_STATUS_CONSENSUS_NEEDED" || status === "ACTIVITY_STATUS_PENDING") return "pending";
  return "failed";
}
