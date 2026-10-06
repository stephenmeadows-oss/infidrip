import type { ProviderRef } from "../receipt.js";
import { simulateCanaryStatus } from "../providers/startup.js";
import { AdapterError } from "../providers/types.js";
import {
  hashHexPayload,
  type TurnkeyActivity,
  type TurnkeyClient,
  type TurnkeyIdentity,
  type TurnkeyPolicy,
  type TurnkeyUser,
  type TurnkeyVote,
} from "./client.js";

export interface MemoryTurnkeyOptions {
  organizationId: string;
  agentUserId: string;
  approverUserId: string;
  policies: TurnkeyPolicy[];
  users?: TurnkeyUser[];
  activities?: TurnkeyActivity[];
  /** When set, submitCanary returns this status instead of simulating the policies. */
  canaryStatus?: string | null;
  /** Votes attached to the canary. When omitted, a completed or pending canary carries the agent's approval only. */
  canaryVotes?: TurnkeyVote[];
}

/** In-memory Turnkey stand-in for tests. It does not open a socket. */
export function createMemoryTurnkeyClient(options: MemoryTurnkeyOptions): TurnkeyClient & {
  calls: string[];
  policies: TurnkeyPolicy[];
} {
  const calls: string[] = [];
  const policies = options.policies.map((policy) => ({ ...policy }));
  const users = (options.users ?? [
    { userId: options.agentUserId, userName: "agent", userTags: [] },
    { userId: options.approverUserId, userName: "guard-approver", userTags: [] },
  ]).map((user) => ({ ...user, userTags: [...user.userTags] }));
  const activities = (options.activities ?? []).map((activity) => ({ ...activity }));
  const identity: TurnkeyIdentity = {
    organizationId: options.organizationId,
    userId: options.approverUserId,
    username: "guard-approver",
  };

  function requireActivity(ref: ProviderRef): TurnkeyActivity {
    const found = activities.find((activity) =>
      (ref.activity_id !== null && activity.id === ref.activity_id) ||
      (ref.fingerprint !== null && activity.fingerprint === ref.fingerprint)
    );
    if (!found) throw new AdapterError("Activity was not found in the fixture.");
    return found;
  }

  const client: TurnkeyClient & { calls: string[]; policies: TurnkeyPolicy[] } = {
    calls,
    policies,
    async whoami() {
      calls.push("whoami");
      return { ...identity };
    },
    async listPolicies() {
      calls.push("listPolicies");
      return policies.map((policy) => ({ ...policy }));
    },
    async listUsers() {
      calls.push("listUsers");
      return users.map((user) => ({ ...user, userTags: [...user.userTags] }));
    },
    async listPending() {
      calls.push("listPending");
      return activities
        .filter((activity) => activity.status === "ACTIVITY_STATUS_CONSENSUS_NEEDED")
        .map((activity) => copyActivity(activity));
    },
    async getActivity(ref) {
      calls.push("getActivity");
      return copyActivity(requireActivity(ref));
    },
    async approveActivity(fingerprint) {
      calls.push(`approve:${fingerprint}`);
      const target = activities.find((activity) => activity.fingerprint === fingerprint);
      if (!target) throw new AdapterError("Cannot approve an unknown fingerprint.");
      if (target.status !== "ACTIVITY_STATUS_CONSENSUS_NEEDED") {
        throw new AdapterError(`Cannot approve an activity in status ${target.status}.`);
      }
      target.status = "ACTIVITY_STATUS_COMPLETED";
      return copyActivity(target);
    },
    async rejectActivity(fingerprint) {
      calls.push(`reject:${fingerprint}`);
      const target = activities.find((activity) => activity.fingerprint === fingerprint);
      if (!target) throw new AdapterError("Cannot reject an unknown fingerprint.");
      target.status = "ACTIVITY_STATUS_REJECTED";
      return copyActivity(target);
    },
    async submitCanary() {
      calls.push("submitCanary");
      if (options.canaryStatus === null) return null;
      const status = options.canaryStatus ?? simulateCanaryStatus(policies, options.agentUserId, options.approverUserId);
      const votes = options.canaryVotes ?? defaultCanaryVotes(status, options.agentUserId);
      return {
        id: "canary",
        status,
        type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
        fingerprint: "canary-fingerprint",
        organizationId: options.organizationId,
        intent: null,
        unsignedTransactionHex: null,
        payloadHash: null,
        votes: votes.map((vote) => ({ ...vote })),
      };
    },
    async createPolicies(next) {
      calls.push("createPolicies");
      for (const policy of next) policies.push({ ...policy });
    },
  };
  return client;
}

export function fixtureActivity(extra?: Partial<TurnkeyActivity>): TurnkeyActivity {
  const hex = extra?.unsignedTransactionHex ?? "01";
  return {
    id: extra?.id ?? "activity-1",
    status: extra?.status ?? "ACTIVITY_STATUS_CONSENSUS_NEEDED",
    type: extra?.type ?? "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
    fingerprint: extra?.fingerprint ?? "fingerprint-1",
    organizationId: extra?.organizationId ?? "org-test",
    intent: extra?.intent ?? { signTransactionIntent: { unsignedTransaction: hex } },
    unsignedTransactionHex: hex,
    payloadHash: extra?.payloadHash ?? hashHexPayload(hex),
    votes: extra?.votes?.map((vote) => ({ ...vote })) ?? [],
  };
}

function copyActivity(activity: TurnkeyActivity): TurnkeyActivity {
  return { ...activity, votes: activity.votes.map((vote) => ({ ...vote })) };
}

function defaultCanaryVotes(status: string, agentUserId: string): TurnkeyVote[] {
  if (status === "ACTIVITY_STATUS_COMPLETED" || status === "ACTIVITY_STATUS_CONSENSUS_NEEDED") {
    return [{ userId: agentUserId, selection: "VOTE_SELECTION_APPROVED" }];
  }
  return [];
}
