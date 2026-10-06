import { normalizeAddress } from "../address.js";
import { parseTimeMs, isInRollingWindow } from "../time.js";
import type { ChainId, SpendRecord, SpendState } from "../types.js";

/** Held reservations expire after this many seconds. Same default as max_pending_seconds. */
export const RESERVATION_TTL_SECONDS = 300;

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

export interface Reservation {
  reservationId: string;
  decisionId: string;
  agentId: string;
  assetId: string;
  amountBaseUnits: string;
  usdMicros: string;
  at: string;
  expiresAt: string;
  state: SpendState;
  /** Rolling windows are not calendar buckets. This records the ruleset period only. */
  periodKey: string;
  fingerprint: string;
  payloadHash: string;
  idempotencyKey?: string;
  to: string;
  chain: string;
  nonce?: string;
  blockhash?: string;
}

export interface StoredAttempt {
  agentId: string;
  fingerprint: string;
  payloadHash: string;
  idempotencyKey?: string;
  result: "allow" | "deny" | "escalate";
  reasons: string[];
  reasonMessages: string[];
  usdValue?: string;
  reservationId: string | null;
  approved: boolean;
  at: string;
  to: string;
  chain: string;
  assetId: string;
  amountBaseUnits: string;
  nonce?: string;
  blockhash?: string;
}

export interface HoldInput {
  reservationId: string;
  decisionId: string;
  agentId: string;
  assetId: string;
  amountBaseUnits: string;
  usdMicros: string;
  at: string;
  expiresAt: string;
  periodKey: string;
  fingerprint: string;
  payloadHash: string;
  idempotencyKey?: string;
  to: string;
  chain: string;
  nonce?: string;
  blockhash?: string;
}

export interface SpendLedger {
  kill(): void;
  exclusive<T>(agentId: string, fn: () => Promise<T> | T): Promise<T>;
  spends(agentId: string, now: string): SpendRecord[];
  findAttempt(agentId: string, fingerprint: string): StoredAttempt | undefined;
  findIdempotency(agentId: string, key: string): StoredAttempt | undefined;
  saveAttempt(attempt: StoredAttempt, bindKey: boolean): void;
  markApproved(agentId: string, fingerprint: string): void;
  hold(input: HoldInput): Reservation;
  release(reservationId: string): void;
  commit(reservationId: string): void;
  getReservation(reservationId: string): Reservation | undefined;
  listReservations(agentId: string): Reservation[];
  duplicateNonce(agentId: string, chain: string, nonce: string, fingerprint: string): boolean;
  duplicatePayload(agentId: string, payloadHash: string, fingerprint: string): boolean;
  findDedupe(
    agentId: string,
    chain: string,
    to: string,
    assetId: string,
    amountBaseUnits: string,
    nowMs: number,
    windowSeconds: number,
  ): Reservation | undefined;
}

export function createMemoryLedger(): SpendLedger {
  const reservations = new Map<string, Reservation>();
  const attempts = new Map<string, StoredAttempt>();
  const idempotency = new Map<string, string>();
  const tails = new Map<string, Promise<void>>();
  let killed = false;

  function requireLive(): void {
    if (killed) {
      throw new LedgerError("Spend ledger is unavailable.");
    }
  }

  function attemptKey(agentId: string, fingerprint: string): string {
    return `${agentId}\n${fingerprint}`;
  }

  return {
    kill(): void {
      killed = true;
    },
    exclusive<T>(agentId: string, fn: () => Promise<T> | T): Promise<T> {
      requireLive();
      const prev = tails.get(agentId) ?? Promise.resolve();
      const run = prev.then(() => {
        requireLive();
        return fn();
      });
      tails.set(
        agentId,
        run.then(
          () => undefined,
          () => undefined,
        ),
      );
      return run;
    },
    spends(agentId: string, now: string): SpendRecord[] {
      requireLive();
      const nowMs = parseTimeMs(now);
      if (nowMs === null) {
        throw new LedgerError("Ledger clock is not a usable timestamp.");
      }
      const rows: SpendRecord[] = [];
      for (const row of reservations.values()) {
        if (row.agentId !== agentId || !countsTowardCap(row, nowMs)) continue;
        rows.push({
          assetId: row.assetId,
          amountBaseUnits: row.amountBaseUnits,
          usdMicros: row.usdMicros,
          at: row.at,
          state: row.state,
        });
      }
      return rows;
    },
    findAttempt(agentId: string, fingerprint: string): StoredAttempt | undefined {
      requireLive();
      const found = attempts.get(attemptKey(agentId, fingerprint));
      return found ? copyAttempt(found) : undefined;
    },
    findIdempotency(agentId: string, key: string): StoredAttempt | undefined {
      requireLive();
      const fingerprint = idempotency.get(`${agentId}\n${key}`);
      if (!fingerprint) return undefined;
      const found = attempts.get(attemptKey(agentId, fingerprint));
      return found ? copyAttempt(found) : undefined;
    },
    saveAttempt(attempt: StoredAttempt, bindKey: boolean): void {
      requireLive();
      const key = attemptKey(attempt.agentId, attempt.fingerprint);
      if (attempts.has(key)) return;
      attempts.set(key, copyAttempt(attempt));
      if (bindKey && attempt.idempotencyKey) {
        const idemKey = `${attempt.agentId}\n${attempt.idempotencyKey}`;
        if (!idempotency.has(idemKey)) idempotency.set(idemKey, attempt.fingerprint);
      }
    },
    markApproved(agentId: string, fingerprint: string): void {
      requireLive();
      const found = attempts.get(attemptKey(agentId, fingerprint));
      if (!found) {
        throw new LedgerError("No stored decision for that fingerprint.");
      }
      found.approved = true;
    },
    hold(input: HoldInput): Reservation {
      requireLive();
      if (reservations.has(input.reservationId)) {
        throw new LedgerError("Reservation id already exists.");
      }
      const row: Reservation = { ...input, state: "held" };
      reservations.set(row.reservationId, row);
      return copyReservation(row);
    },
    release(reservationId: string): void {
      requireLive();
      const row = reservations.get(reservationId);
      if (!row) throw new LedgerError("Reservation does not exist.");
      row.state = "released";
    },
    commit(reservationId: string): void {
      requireLive();
      const row = reservations.get(reservationId);
      if (!row) throw new LedgerError("Reservation does not exist.");
      row.state = "committed";
    },
    getReservation(reservationId: string): Reservation | undefined {
      requireLive();
      const row = reservations.get(reservationId);
      return row ? copyReservation(row) : undefined;
    },
    listReservations(agentId: string): Reservation[] {
      requireLive();
      return [...reservations.values()].filter((row) => row.agentId === agentId).map(copyReservation);
    },
    duplicateNonce(agentId: string, chain: string, nonce: string, fingerprint: string): boolean {
      requireLive();
      for (const attempt of attempts.values()) {
        if (attempt.agentId !== agentId || attempt.fingerprint === fingerprint) continue;
        if (attempt.result !== "allow") continue;
        if (attempt.chain === chain && attempt.nonce === nonce) return true;
      }
      return false;
    },
    duplicatePayload(agentId: string, payloadHash: string, fingerprint: string): boolean {
      requireLive();
      for (const attempt of attempts.values()) {
        if (attempt.agentId !== agentId || attempt.fingerprint === fingerprint) continue;
        if (attempt.payloadHash === payloadHash) return true;
      }
      return false;
    },
    findDedupe(agentId, chain, to, assetId, amountBaseUnits, nowMs, windowSeconds): Reservation | undefined {
      requireLive();
      if (windowSeconds <= 0) return undefined;
      const target = normalizeTo(chain, to);
      for (const row of reservations.values()) {
        if (row.agentId !== agentId || row.state === "released") continue;
        if (!countsTowardCap(row, nowMs)) continue;
        if (row.chain !== chain || row.assetId !== assetId || row.amountBaseUnits !== amountBaseUnits) continue;
        if (normalizeTo(row.chain, row.to) !== target) continue;
        const atMs = parseTimeMs(row.at);
        if (atMs === null || !isInRollingWindow(atMs, nowMs, windowSeconds)) continue;
        return copyReservation(row);
      }
      return undefined;
    },
  };
}

export function applyOutcome(
  ledger: SpendLedger,
  reservationId: string,
  status: "confirmed" | "failed" | "rejected" | "expired",
): void {
  if (status === "confirmed") ledger.commit(reservationId);
  else ledger.release(reservationId);
}

function countsTowardCap(row: Reservation, nowMs: number): boolean {
  if (row.state === "released") return false;
  if (row.state === "committed") return true;
  const expiresAt = parseTimeMs(row.expiresAt);
  if (expiresAt !== null && expiresAt <= nowMs) return false;
  return true;
}

function normalizeTo(chain: string, to: string): string {
  const normalized = normalizeAddress(chain as ChainId, to);
  return normalized ?? to;
}

function copyReservation(row: Reservation): Reservation {
  return { ...row };
}

function copyAttempt(row: StoredAttempt): StoredAttempt {
  return {
    ...row,
    reasons: [...row.reasons],
    reasonMessages: [...row.reasonMessages],
  };
}
