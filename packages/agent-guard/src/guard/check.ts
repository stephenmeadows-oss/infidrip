import { Reason } from "../codes.js";
import { evaluate } from "../evaluate.js";
import { usdToMicros } from "../money.js";
import { readPairQuote, type PriceSource } from "../price/feeds.js";
import { BASE_MAINNET_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID } from "../providers/types.js";
import { parseTimeMs } from "../time.js";
import {
  isRecord,
  type Decision,
  type DecisionResult,
  type EvaluationInput,
  type RulesetAsset,
} from "../types.js";
import {
  RESERVATION_TTL_SECONDS,
  LedgerError,
  type Reservation,
  type SpendLedger,
  type StoredAttempt,
} from "./ledger.js";

export const GuardReason = {
  REPLAY: "REPLAY",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  LEDGER_ERROR: "LEDGER_ERROR",
  LOG_WRITE_FAILED: "LOG_WRITE_FAILED",
  GUARD_UNAVAILABLE: "GUARD_UNAVAILABLE",
  CHAIN_ID_MISMATCH: "CHAIN_ID_MISMATCH",
  DEDUPE: "DEDUPE",
} as const;

export type GuardReasonCode = (typeof GuardReason)[keyof typeof GuardReason];

/** Default dedupe window is off. Set it to escalate a repeat of the same payment. */
export const DEDUPE_WINDOW_SECONDS = 0;

export interface GuardInput {
  evaluation: EvaluationInput;
  fingerprint: string;
  payloadHash: string;
  idempotencyKey?: string;
  /** Chain id from the unsigned EVM transaction. 8453 is Base mainnet and is refused. */
  evmChainId?: number;
  nonce?: string;
  /** Recent blockhash from the unsigned Solana transaction. Required on Solana, and recorded. */
  blockhash?: string;
  /**
   * Decimals read from the chain (ERC-20 decimals() or the SPL mint, including transferChecked).
   * null means the read failed.
   */
  observedDecimals: number | null;
  intentId?: string;
}

export interface GuardCheck {
  result: DecisionResult;
  reasons: string[];
  reasonMessages: string[];
  decision: Decision | null;
  reservation: Reservation | null;
  logged: boolean;
  replayed: boolean;
  /** True only when the caller may send a provider approve for this fingerprint. */
  mayApprove: boolean;
}

export interface DecisionLogEntry {
  kind: "evaluate" | "guard";
  evaluation: EvaluationInput | null;
  intentId: string;
  payloadHash: string;
  fingerprint: string;
  agentId: string;
  result: DecisionResult;
  reasons: string[];
  reasonMessages: string[];
  at: string;
}

export interface DecisionLog {
  appendDecision(entry: DecisionLogEntry): void | Promise<void>;
}

export interface GuardServices {
  ledger: SpendLedger;
  prices: PriceSource;
  log: DecisionLog;
  /** When false, every check is denied before the ledger or the log is touched. */
  available?: boolean;
  reservationTtlSeconds?: number;
  /** Same recipient, asset, and amount inside this window escalates. 0 disables it. */
  dedupeWindowSeconds?: number;
  nextId?: () => string;
}

const PAYLOAD_STICKY = new Set<string>([
  GuardReason.REPLAY,
  GuardReason.IDEMPOTENCY_CONFLICT,
  GuardReason.CHAIN_ID_MISMATCH,
  Reason.DECIMALS_MISMATCH,
]);

let fallbackSeq = 0;

export async function checkPayment(input: GuardInput, services: GuardServices): Promise<GuardCheck> {
  if (services.available === false) {
    return block(GuardReason.GUARD_UNAVAILABLE, "Agent Guard is unavailable, so the payment is blocked.");
  }
  const agentId = readAgentId(input.evaluation?.intent);
  if (!agentId) {
    return block(Reason.EVAL_ERROR, "Payment intent is missing an agent id.");
  }
  try {
    return await services.ledger.exclusive(agentId, () => runLocked(input, services, agentId));
  } catch (error) {
    if (error instanceof LedgerError) {
      return block(GuardReason.LEDGER_ERROR, "The spend ledger is unavailable, so the payment is blocked.");
    }
    return block(Reason.EVAL_ERROR, "The guard check failed closed.");
  }
}

async function runLocked(input: GuardInput, services: GuardServices, agentId: string): Promise<GuardCheck> {
  const now = typeof input.evaluation?.now === "string" ? input.evaluation.now : "";
  const nowMs = now ? parseTimeMs(now) : null;
  const intentId = input.intentId && input.intentId.length > 0 ? input.intentId : (services.nextId?.() ?? nextFallbackId());
  const payloadHash = canonicalHash(input.payloadHash);
  const fingerprint = typeof input.fingerprint === "string" ? input.fingerprint : "";
  const identity = validateIdentity(fingerprint, payloadHash, input.idempotencyKey);
  if (identity || nowMs === null || payloadHash === null) {
    return identity ?? block(Reason.EVAL_ERROR, "now is not a usable timestamp.");
  }
  const hash = payloadHash;

  const prior = services.ledger.findAttempt(agentId, fingerprint);
  if (prior) {
    if (prior.payloadHash !== hash) {
      return persist(input, services, agentId, intentId, now, hash, block(
        GuardReason.REPLAY,
        "This fingerprint was already decided for a different payload.",
      ), emptyFlags(input, services, agentId, now, { cache: false, bindKey: false }));
    }
    return replay(services.ledger, prior, nowMs);
  }

  if (input.idempotencyKey) {
    const byKey = services.ledger.findIdempotency(agentId, input.idempotencyKey);
    if (byKey) {
      if (byKey.payloadHash !== hash) {
        return persist(input, services, agentId, intentId, now, hash, block(
          GuardReason.IDEMPOTENCY_CONFLICT,
          "This idempotency key was already used for a different payload.",
        ), emptyFlags(input, services, agentId, now, { cache: true, bindKey: false }));
      }
      return replay(services.ledger, byKey, nowMs);
    }
  }

  if (services.ledger.duplicatePayload(agentId, hash, fingerprint)) {
    return persist(input, services, agentId, intentId, now, hash, block(
      GuardReason.REPLAY,
      "This payload hash was already decided.",
    ), emptyFlags(input, services, agentId, now, { cache: true, bindKey: true }));
  }

  const chainBlock = chainGate(input, services, agentId, fingerprint);
  if (chainBlock) {
    return persist(input, services, agentId, intentId, now, hash, chainBlock, emptyFlags(
      input,
      services,
      agentId,
      now,
      { cache: true, bindKey: true },
    ));
  }

  const view = paymentView(input.evaluation.intent);
  const dedupeWindow = services.dedupeWindowSeconds ?? DEDUPE_WINDOW_SECONDS;
  if (view && services.ledger.findDedupe(agentId, view.chain, view.to, view.assetId, view.amountBaseUnits, nowMs, dedupeWindow)) {
    return persist(input, services, agentId, intentId, now, hash, escalate(
      GuardReason.DEDUPE,
      "The same recipient, asset, and amount was already reserved inside the dedupe window.",
    ), emptyFlags(input, services, agentId, now, { cache: Boolean(input.idempotencyKey), bindKey: true }));
  }

  const decimalsBlock = decimalsGate(input.evaluation.ruleset, input.evaluation.intent, input.observedDecimals);
  if (decimalsBlock) {
    return persist(input, services, agentId, intentId, now, hash, decimalsBlock, emptyFlags(
      input,
      services,
      agentId,
      now,
      { cache: true, bindKey: true },
    ));
  }

  const prices = await quotesFor(input.evaluation.ruleset, input.evaluation.intent, services.prices);
  const evaluation = snapshot(input, services.ledger, agentId, now, prices);
  let decision: Decision;
  try {
    decision = evaluate(evaluation);
  } catch {
    return persist(input, services, agentId, intentId, now, hash, block(
      Reason.EVAL_ERROR,
      "The rules engine failed closed.",
    ), { cache: Boolean(input.idempotencyKey), bindKey: true, kind: "guard", evaluation });
  }

  let reservation: Reservation | null = null;
  if (decision.result === "allow") {
    const usdMicros = decision.usdValue ? usdToMicros(decision.usdValue) : null;
    if (!view || usdMicros === null) {
      return persist(input, services, agentId, intentId, now, hash, block(
        Reason.EVAL_ERROR,
        "An allow decision had no USD value, so nothing was reserved.",
      ), { cache: false, bindKey: false, kind: "guard", evaluation });
    }
    const ttl = services.reservationTtlSeconds ?? RESERVATION_TTL_SECONDS;
    reservation = services.ledger.hold({
      reservationId: services.nextId?.() ?? nextFallbackId(),
      decisionId: services.nextId?.() ?? nextFallbackId(),
      agentId,
      assetId: view.assetId,
      amountBaseUnits: view.amountBaseUnits,
      usdMicros: usdMicros.toString(),
      at: now,
      expiresAt: plusSeconds(now, ttl),
      periodKey: periodKey(input.evaluation.ruleset),
      fingerprint,
      payloadHash: hash,
      idempotencyKey: input.idempotencyKey,
      to: view.to,
      chain: view.chain,
      nonce: input.nonce,
      blockhash: input.blockhash,
    });
  }

  const check: GuardCheck = {
    result: decision.result,
    reasons: [...decision.reasons],
    reasonMessages: [...decision.reasonMessages],
    decision,
    reservation,
    logged: false,
    replayed: false,
    mayApprove: false,
  };
  return persist(input, services, agentId, intentId, now, hash, check, {
    cache: shouldCache(input, check),
    bindKey: true,
    kind: "evaluate",
    evaluation,
  });
}

interface PersistFlags {
  cache: boolean;
  bindKey: boolean;
  kind: "evaluate" | "guard";
  evaluation: EvaluationInput;
}

function emptyFlags(
  input: GuardInput,
  services: GuardServices,
  agentId: string,
  now: string,
  flags: { cache: boolean; bindKey: boolean },
): PersistFlags {
  return {
    ...flags,
    kind: "guard",
    evaluation: snapshot(input, services.ledger, agentId, now, {}),
  };
}

async function persist(
  input: GuardInput,
  services: GuardServices,
  agentId: string,
  intentId: string,
  now: string,
  payloadHash: string,
  check: GuardCheck,
  flags: PersistFlags,
): Promise<GuardCheck> {
  let logged = false;
  try {
    await services.log.appendDecision({
      kind: flags.kind,
      evaluation: flags.evaluation,
      intentId,
      payloadHash,
      fingerprint: input.fingerprint,
      agentId,
      result: check.result,
      reasons: check.reasons,
      reasonMessages: check.reasonMessages,
      at: now,
    });
    logged = true;
  } catch {
    logged = false;
  }
  if (!logged) {
    if (check.reservation) {
      try {
        services.ledger.release(check.reservation.reservationId);
      } catch {
        // Still a deny. A release failure must not become an approval.
      }
    }
    return block(GuardReason.LOG_WRITE_FAILED, "The decision log write failed, so the payment is blocked.");
  }

  if (flags.cache) {
    const view = paymentView(input.evaluation.intent);
    const attempt: StoredAttempt = {
      agentId,
      fingerprint: input.fingerprint,
      payloadHash,
      result: check.result,
      reasons: [...check.reasons],
      reasonMessages: [...check.reasonMessages],
      reservationId: check.reservation?.reservationId ?? null,
      approved: false,
      at: now,
      to: view?.to ?? "",
      chain: view?.chain ?? "",
      assetId: view?.assetId ?? "",
      amountBaseUnits: view?.amountBaseUnits ?? "0",
    };
    if (input.idempotencyKey && flags.bindKey) attempt.idempotencyKey = input.idempotencyKey;
    if (check.decision?.usdValue !== undefined) attempt.usdValue = check.decision.usdValue;
    if (input.nonce !== undefined) attempt.nonce = input.nonce;
    if (input.blockhash !== undefined) attempt.blockhash = input.blockhash;
    services.ledger.saveAttempt(attempt, flags.bindKey);
  }

  return {
    ...check,
    logged: true,
    mayApprove: check.result === "allow" && check.reservation?.state === "held",
  };
}

function chainGate(input: GuardInput, services: GuardServices, agentId: string, fingerprint: string): GuardCheck | null {
  const chain = readChain(input.evaluation.intent);
  if (chain === "base" || chain === "solana") {
    return block(GuardReason.CHAIN_ID_MISMATCH, `Mainnet chain ${chain} is refused. Use a testnet chain.`);
  }
  if (input.evmChainId === BASE_MAINNET_CHAIN_ID) {
    return block(GuardReason.CHAIN_ID_MISMATCH, "EVM chain id 8453 is Base mainnet and is refused.");
  }
  if (chain === "base-sepolia") {
    if (input.evmChainId !== BASE_SEPOLIA_CHAIN_ID) {
      return block(
        GuardReason.CHAIN_ID_MISMATCH,
        `EVM chain id ${String(input.evmChainId)} does not match base-sepolia (${BASE_SEPOLIA_CHAIN_ID}).`,
      );
    }
    if (input.nonce !== undefined && services.ledger.duplicateNonce(agentId, chain, input.nonce, fingerprint)) {
      return block(GuardReason.REPLAY, "This Base Sepolia nonce was already used.");
    }
  }
  if (chain === "solana-devnet") {
    if (typeof input.blockhash !== "string" || input.blockhash.length === 0) {
      return block(GuardReason.REPLAY, "Solana payments must carry a recent blockhash.");
    }
  }
  return null;
}

function decimalsGate(ruleset: unknown, intent: unknown, observed: number | null): GuardCheck | null {
  if (!isRecord(intent) || typeof intent.assetId !== "string") return null;
  const asset = findAsset(ruleset, intent.assetId);
  if (!asset) return null;
  if (observed === null) {
    return block(Reason.DECIMALS_MISMATCH, `On-chain decimals for ${intent.assetId} could not be read.`);
  }
  if (!Number.isSafeInteger(observed) || observed < 0 || observed > 36) {
    return block(Reason.DECIMALS_MISMATCH, `On-chain decimals for ${intent.assetId} are not a usable integer.`);
  }
  if (observed !== asset.decimals) {
    return block(
      Reason.DECIMALS_MISMATCH,
      `On-chain decimals ${observed} do not match the pinned value ${asset.decimals}.`,
    );
  }
  if (typeof intent.decimals === "number" && intent.decimals !== observed) {
    return block(
      Reason.DECIMALS_MISMATCH,
      `Payment decimals ${intent.decimals} do not match the on-chain value ${observed}.`,
    );
  }
  return null;
}

async function quotesFor(ruleset: unknown, intent: unknown, source: PriceSource): Promise<Record<string, unknown>> {
  const ids: string[] = [];
  if (isRecord(intent) && typeof intent.assetId === "string") ids.push(intent.assetId);
  if (isRecord(intent) && isRecord(intent.fee) && typeof intent.fee.assetId === "string") ids.push(intent.fee.assetId);
  const prices: Record<string, unknown> = {};
  for (const assetId of ids) {
    const asset = findAsset(ruleset, assetId);
    if (!asset) continue;
    const quote = await readPairQuote(asset, source);
    if (quote) prices[assetId] = quote;
  }
  return prices;
}

function snapshot(
  input: GuardInput,
  ledger: SpendLedger,
  agentId: string,
  now: string,
  prices: Record<string, unknown>,
): EvaluationInput {
  return {
    ...input.evaluation,
    now,
    ledger: { spends: ledger.spends(agentId, now) },
    prices,
  };
}

function replay(ledger: SpendLedger, prior: StoredAttempt, nowMs: number): GuardCheck {
  const reservation = prior.reservationId ? ledger.getReservation(prior.reservationId) : undefined;
  const expiresAt = reservation ? parseTimeMs(reservation.expiresAt) : null;
  const usable = reservation !== undefined && reservation.state === "held" && (expiresAt === null || expiresAt > nowMs);
  const decision: Decision | null = prior.usdValue
    ? {
        result: prior.result,
        rulesChecked: [],
        reasons: [],
        reasonMessages: [...prior.reasonMessages],
        usdValue: prior.usdValue,
      }
    : null;
  return {
    result: prior.result,
    reasons: [...prior.reasons],
    reasonMessages: [...prior.reasonMessages],
    decision,
    reservation: usable ? reservation : null,
    logged: true,
    replayed: true,
    mayApprove: prior.result === "allow" && usable && !prior.approved,
  };
}

function shouldCache(input: GuardInput, check: GuardCheck): boolean {
  if (input.idempotencyKey) return true;
  if (check.result === "allow") return true;
  return check.reasons.some((code) => PAYLOAD_STICKY.has(code));
}

function validateIdentity(fingerprint: string, payloadHash: string | null, idempotencyKey: string | undefined): GuardCheck | null {
  if (fingerprint.length === 0 || fingerprint.length > 256) {
    return block(Reason.EVAL_ERROR, "Fingerprint must be a non-empty string.");
  }
  if (!payloadHash) {
    return block(Reason.EVAL_ERROR, "payloadHash must be 32 bytes of hex.");
  }
  if (idempotencyKey !== undefined && (idempotencyKey.length === 0 || idempotencyKey.length > 200)) {
    return block(Reason.EVAL_ERROR, "idempotencyKey must be a non-empty string.");
  }
  return null;
}

function block(code: string, message: string): GuardCheck {
  return {
    result: "deny",
    reasons: [code],
    reasonMessages: [message],
    decision: null,
    reservation: null,
    logged: false,
    replayed: false,
    mayApprove: false,
  };
}

function escalate(code: string, message: string): GuardCheck {
  return {
    result: "escalate",
    reasons: [code],
    reasonMessages: [message],
    decision: null,
    reservation: null,
    logged: false,
    replayed: false,
    mayApprove: false,
  };
}

function paymentView(intent: unknown): { chain: string; to: string; assetId: string; amountBaseUnits: string } | null {
  if (!isRecord(intent)) return null;
  if (typeof intent.chain !== "string" || typeof intent.to !== "string") return null;
  if (typeof intent.assetId !== "string" || typeof intent.amountBaseUnits !== "string") return null;
  return { chain: intent.chain, to: intent.to, assetId: intent.assetId, amountBaseUnits: intent.amountBaseUnits };
}

function findAsset(ruleset: unknown, assetId: string): RulesetAsset | null {
  if (!isRecord(ruleset) || !Array.isArray(ruleset.assets)) return null;
  for (const asset of ruleset.assets) {
    if (isRecord(asset) && asset.asset_id === assetId && typeof asset.decimals === "number") {
      return asset as unknown as RulesetAsset;
    }
  }
  return null;
}

function readAgentId(intent: unknown): string | null {
  if (!isRecord(intent) || typeof intent.agentId !== "string" || intent.agentId.length === 0) return null;
  return intent.agentId;
}

function readChain(intent: unknown): string | null {
  if (!isRecord(intent) || typeof intent.chain !== "string") return null;
  return intent.chain;
}

function periodKey(ruleset: unknown): string {
  if (isRecord(ruleset) && isRecord(ruleset.caps) && typeof ruleset.caps.period_seconds === "number") {
    return `rolling:${ruleset.caps.period_seconds}`;
  }
  return "rolling";
}

function canonicalHash(value: unknown): string | null {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) return null;
  return value.toLowerCase();
}

function plusSeconds(iso: string, seconds: number): string {
  const ms = parseTimeMs(iso);
  if (ms === null) throw new LedgerError("Reservation timestamp is not usable.");
  return new Date(ms + seconds * 1000).toISOString();
}

function nextFallbackId(): string {
  fallbackSeq += 1;
  return `ag${fallbackSeq.toString(16)}`;
}
