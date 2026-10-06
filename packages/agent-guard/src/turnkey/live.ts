import type { ProviderRef } from "../receipt.js";
import { AdapterError } from "../providers/types.js";
import { isTestnetChain, type TestnetChainId } from "../providers/types.js";
import {
  normalizeActivity,
  normalizeIdentity,
  normalizePolicy,
  normalizeUser,
  type TurnkeyActivity,
  type TurnkeyClient,
  type TurnkeyIdentity,
  type TurnkeyPolicy,
  type TurnkeyUser,
} from "./client.js";
import { stampRequest } from "./stamp.js";

export interface LiveTurnkeyOptions {
  organizationId: string;
  apiPublicKey: string;
  apiPrivateKey: string;
  baseUrl?: string;
}

const DEFAULT_BASE = "https://api.turnkey.com";

/**
 * Live Turnkey client. This is the only module that opens a socket.
 * Callers must pass credentials at runtime. This module does not read files or embed secrets.
 * It does not submit signature requests.
 */
export function createLiveTurnkeyClient(options: LiveTurnkeyOptions): TurnkeyClient {
  const organizationId = options.organizationId.trim();
  const apiPublicKey = options.apiPublicKey.trim();
  const apiPrivateKey = options.apiPrivateKey.trim();
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  if (organizationId.length === 0 || apiPublicKey.length === 0 || apiPrivateKey.length === 0) {
    throw new AdapterError("Live Turnkey client needs an organization id, API public key, and API private key.");
  }

  async function post(path: string, body: unknown): Promise<unknown> {
    const payload = JSON.stringify(body);
    const stamp = stampRequest(payload, apiPublicKey, apiPrivateKey);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Stamp": stamp,
        },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "request failed";
      throw new AdapterError(`Turnkey request failed: ${message}`);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new AdapterError(`Turnkey responded ${response.status} for ${path}: ${summarize(text)}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AdapterError(`Turnkey response for ${path} was not JSON.`);
    }
  }

  return {
    async whoami() {
      const body = await post("/public/v1/query/whoami", { organizationId });
      return normalizeIdentity(body);
    },
    async listPolicies() {
      const body = await post("/public/v1/query/list_policies", { organizationId });
      return listOf(body, "policies", normalizePolicy);
    },
    async listUsers() {
      const body = await post("/public/v1/query/list_users", { organizationId });
      return listOf(body, "users", normalizeUser);
    },
    async listPending() {
      const body = await post("/public/v1/query/list_activities", {
        organizationId,
        filterByStatus: ["ACTIVITY_STATUS_CONSENSUS_NEEDED"],
      });
      return listOf(body, "activities", normalizeActivity);
    },
    async getActivity(ref: ProviderRef) {
      if (ref.activity_id) {
        const body = await post("/public/v1/query/get_activity", {
          organizationId,
          activityId: ref.activity_id,
        });
        const activity = normalizeActivity(body);
        if (!activity) throw new AdapterError("Turnkey activity response was not usable.");
        return activity;
      }
      if (ref.fingerprint) {
        const pending = await this.listPending();
        const found = pending.find((activity) => activity.fingerprint === ref.fingerprint);
        if (!found) throw new AdapterError("No pending activity matched that fingerprint.");
        return found;
      }
      throw new AdapterError("An activity id or fingerprint is required.");
    },
    async approveActivity(fingerprint: string) {
      const body = await post("/public/v1/submit/approve_activity", envelope("ACTIVITY_TYPE_APPROVE_ACTIVITY", organizationId, fingerprint));
      const activity = normalizeActivity(body);
      if (!activity) throw new AdapterError("Turnkey approve response was not usable.");
      return activity;
    },
    async rejectActivity(fingerprint: string) {
      const body = await post("/public/v1/submit/reject_activity", envelope("ACTIVITY_TYPE_REJECT_ACTIVITY", organizationId, fingerprint));
      const activity = normalizeActivity(body);
      if (!activity) throw new AdapterError("Turnkey reject response was not usable.");
      return activity;
    },
    async submitCanary() {
      const activityId = process.env.TURNKEY_CANARY_ACTIVITY_ID?.trim();
      if (!activityId) return null;
      const body = await post("/public/v1/query/get_activity", { organizationId, activityId });
      const activity = normalizeActivity(body);
      if (!activity) throw new AdapterError("Turnkey canary activity response was not usable.");
      return activity;
    },
  };
}

export interface LiveEnv {
  client: TurnkeyClient;
  organizationId: string;
  agentUserId: string;
  approverUserId: string;
  wallets: { walletId: string; chain: TestnetChainId }[];
}

/** Returns null when TURNKEY_ORG_ID or TURNKEY_API_KEY is absent. Does not print secrets. */
export function liveTurnkeyFromEnv(): LiveEnv | null {
  const organizationId = process.env.TURNKEY_ORG_ID?.trim() ?? "";
  const apiPublicKey = (process.env.TURNKEY_API_KEY ?? process.env.TURNKEY_API_PUBLIC_KEY)?.trim() ?? "";
  if (organizationId.length === 0 || apiPublicKey.length === 0) return null;
  const apiPrivateKey = process.env.TURNKEY_API_PRIVATE_KEY?.trim() ?? "";
  if (apiPrivateKey.length === 0) {
    throw new AdapterError("TURNKEY_API_PRIVATE_KEY is required when TURNKEY_ORG_ID and TURNKEY_API_KEY are set.");
  }
  const agentUserId = process.env.TURNKEY_AGENT_USER_ID?.trim() ?? "";
  const approverUserId = process.env.TURNKEY_APPROVER_USER_ID?.trim() ?? "";
  if (agentUserId.length === 0 || approverUserId.length === 0) {
    throw new AdapterError("TURNKEY_AGENT_USER_ID and TURNKEY_APPROVER_USER_ID are required for the live startup check.");
  }
  return {
    client: createLiveTurnkeyClient({
      organizationId,
      apiPublicKey,
      apiPrivateKey,
      baseUrl: process.env.TURNKEY_API_BASE_URL?.trim() || DEFAULT_BASE,
    }),
    organizationId,
    agentUserId,
    approverUserId,
    wallets: parseWallets(process.env.TURNKEY_WALLETS ?? ""),
  };
}

function envelope(type: string, organizationId: string, fingerprint: string): Record<string, unknown> {
  return {
    type,
    timestampMs: Date.now().toString(),
    organizationId,
    parameters: { fingerprint },
  };
}

function listOf<T>(body: unknown, key: string, normalize: (value: unknown) => T | null): T[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const rows = (body as Record<string, unknown>)[key];
  if (!Array.isArray(rows)) return [];
  const out: T[] = [];
  for (const row of rows) {
    const parsed = normalize(row);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseWallets(value: string): { walletId: string; chain: TestnetChainId }[] {
  if (value.trim().length === 0) return [];
  const wallets: { walletId: string; chain: TestnetChainId }[] = [];
  for (const part of value.split(",")) {
    const [chain, walletId] = part.split(":").map((item) => item.trim());
    if (!chain || !walletId) throw new AdapterError("TURNKEY_WALLETS entries must look like base-sepolia:<wallet id>.");
    if (!isTestnetChain(chain)) {
      throw new AdapterError(`TURNKEY_WALLETS refused chain ${chain}. Use base-sepolia or solana-devnet.`);
    }
    wallets.push({ chain, walletId });
  }
  return wallets;
}

function summarize(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").slice(0, 180);
  return collapsed.length === 0 ? "empty body" : collapsed;
}

export type { TurnkeyActivity, TurnkeyIdentity, TurnkeyPolicy, TurnkeyUser };
