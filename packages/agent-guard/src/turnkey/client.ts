import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { ProviderRef } from "../receipt.js";
import { isRecord } from "../types.js";

export interface TurnkeyPolicy {
  policyId: string | null;
  policyName: string;
  effect: string;
  consensus: string;
  condition: string;
  notes: string;
}

export interface TurnkeyUser {
  userId: string;
  userName: string;
  userTags: string[];
}

export interface TurnkeyActivity {
  id: string;
  status: string;
  type: string;
  fingerprint: string | null;
  organizationId: string | null;
  intent: unknown;
  unsignedTransactionHex: string | null;
  payloadHash: string | null;
}

export interface TurnkeyIdentity {
  organizationId: string | null;
  userId: string | null;
  username: string | null;
}

/** Injected Turnkey API. Unit tests use an in-memory implementation. */
export interface TurnkeyClient {
  whoami(): Promise<TurnkeyIdentity>;
  listPolicies(): Promise<TurnkeyPolicy[]>;
  listUsers(): Promise<TurnkeyUser[]>;
  listPending(): Promise<TurnkeyActivity[]>;
  getActivity(ref: ProviderRef): Promise<TurnkeyActivity>;
  approveActivity(fingerprint: string): Promise<TurnkeyActivity>;
  rejectActivity(fingerprint: string): Promise<TurnkeyActivity>;
  /**
   * Return the canary sign activity, or null when the operator has not supplied one.
   * Implementations must not create a signature request here.
   */
  submitCanary(): Promise<TurnkeyActivity | null>;
  createPolicies?(policies: TurnkeyPolicy[]): Promise<void>;
}

export function normalizePolicy(value: unknown): TurnkeyPolicy | null {
  if (!isRecord(value)) return null;
  const effect = typeof value.effect === "string" ? value.effect : "";
  if (effect.length === 0) return null;
  return {
    policyId: typeof value.policyId === "string" ? value.policyId : null,
    policyName: typeof value.policyName === "string" ? value.policyName : "",
    effect,
    consensus: typeof value.consensus === "string" ? value.consensus : "",
    condition: typeof value.condition === "string" ? value.condition : "",
    notes: typeof value.notes === "string" ? value.notes : "",
  };
}

export function normalizeUser(value: unknown): TurnkeyUser | null {
  if (!isRecord(value) || typeof value.userId !== "string" || value.userId.length === 0) return null;
  const tags = Array.isArray(value.userTags) ? value.userTags.filter((tag) => typeof tag === "string") : [];
  return {
    userId: value.userId,
    userName: typeof value.userName === "string" ? value.userName : "",
    userTags: tags as string[],
  };
}

export function normalizeActivity(value: unknown): TurnkeyActivity | null {
  const record = unwrapActivity(value);
  if (!record || typeof record.id !== "string" || record.id.length === 0) return null;
  const hex = findUnsignedHex(record.intent);
  return {
    id: record.id,
    status: typeof record.status === "string" ? record.status : "",
    type: typeof record.type === "string" ? record.type : "",
    fingerprint: typeof record.fingerprint === "string" ? record.fingerprint : null,
    organizationId: typeof record.organizationId === "string" ? record.organizationId : null,
    intent: record.intent ?? null,
    unsignedTransactionHex: hex,
    payloadHash: hex ? hashHexPayload(hex) : null,
  };
}

export function normalizeIdentity(value: unknown): TurnkeyIdentity {
  if (!isRecord(value)) return { organizationId: null, userId: null, username: null };
  return {
    organizationId: typeof value.organizationId === "string" ? value.organizationId : null,
    userId: typeof value.userId === "string" ? value.userId : null,
    username: typeof value.username === "string" ? value.username : null,
  };
}

export function hashHexPayload(hex: string): string | null {
  const stripped = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (stripped.length === 0 || stripped.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(stripped)) return null;
  return bytesToHex(sha256(hexToBytes(stripped.toLowerCase())));
}

function unwrapActivity(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.activity) && typeof value.activity.id === "string") return value.activity;
  if (typeof value.id === "string") return value;
  return null;
}

function findUnsignedHex(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = value.unsignedTransaction;
  if (typeof direct === "string" && direct.length > 0) return direct;
  for (const nested of Object.values(value)) {
    if (isRecord(nested)) {
      const found = findUnsignedHex(nested);
      if (found) return found;
    }
  }
  return null;
}
