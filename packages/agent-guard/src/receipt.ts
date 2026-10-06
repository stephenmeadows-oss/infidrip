import * as ed from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { canonicalJson } from "./canonical.js";
import { b64Encode, concatBytes, hexDecode, hexEncode, isHex, jsonClone, utf8 } from "./encoding.js";
import { merkleRoot } from "./merkle.js";
import { hashRuleset, verifyRulesetSignature } from "./signature.js";
import { evaluate } from "./evaluate.js";
import { parseTimeMs } from "./time.js";
import { isRecord, type Decision, type EvaluationInput } from "./types.js";

ed.hashes.sha512 = sha512;

export const RECEIPT_DOMAIN = "agent-guard/receipt/v1";
export const CHECKPOINT_DOMAIN = "agent-guard/checkpoint/v1";
export const PROOF_FORMAT = "agent-guard/proof/1";
export const GENESIS_PREV_HASH = "00".repeat(32);
export const EMPTY_PAYLOAD_HASH = GENESIS_PREV_HASH;
export const DEFAULT_CHECKPOINT_EVERY = 256;
export const DEFAULT_CHECKPOINT_INTERVAL_MS = 600_000;

export const RECEIPT_TYPES = [
  "RULESET_ACTIVATED",
  "ATTEMPT",
  "DECISION",
  "APPROVE_SENT",
  "REJECT_SENT",
  "OUTCOME",
  "GAP",
  "KEY_ROTATION",
  "CHECKPOINT_REF",
] as const;

export type ReceiptType = (typeof RECEIPT_TYPES)[number];

export interface ProviderRef {
  activity_id: string | null;
  fingerprint: string | null;
}

export interface ReceiptSummary {
  to: string | null;
  asset_id: string | null;
  amount_base_units: string | null;
  decimals: number | null;
  usd_value: string | null;
  kind: string | null;
}

export interface PriceSnapshot {
  source: string;
  price: string;
  ts: string;
}

export interface ReceiptDecision {
  result: "allow" | "deny" | "escalate";
  reasons: string[];
  price_snapshot: PriceSnapshot | null;
}

export interface ReceiptOutcome {
  status: "signed" | "broadcast" | "confirmed" | "failed" | "expired" | "rejected";
  tx_hash: string | null;
}

/** Inputs needed to re-run evaluate. They are inside the entry hash. */
export interface EvaluationContext {
  ruleset: unknown;
  ownerSignature: string;
  ownerPublicKey: string;
  bodyHash?: string;
  activeVersion?: number | null;
  intent: unknown;
  ledger?: unknown;
  now: string;
  prices?: unknown;
  agentStatus?: string;
}

export interface ReceiptContext {
  evaluation?: EvaluationContext;
  checkpoint_ref?: { merkle_root: string; from_seq: number; to_seq: number };
  gap?: { note: string };
  rotation?: { new_key_id: string; public_key: string };
}

export interface ReceiptEntry {
  v: 1;
  seq: number;
  ts: string;
  type: ReceiptType;
  agent_id: string;
  intent_id: string | null;
  provider: string;
  provider_ref: ProviderRef;
  chain: string;
  payload_hash: string;
  summary: ReceiptSummary;
  ruleset_hash: string;
  decision: ReceiptDecision | null;
  outcome: ReceiptOutcome | null;
  context: ReceiptContext | null;
  prev_hash: string;
  entry_hash: string;
  sig: string;
  key_id: string;
}

export interface Checkpoint {
  from_seq: number;
  to_seq: number;
  tree_size: number;
  merkle_root: string;
  log_head_hash: string;
  ts: string;
  key_id: string;
  sig: string;
}

export interface PublicLogKey {
  key_id: string;
  public_key: string;
  valid_from: string;
  valid_until: string | null;
}

export interface StoredRuleset {
  body: unknown;
  body_hash: string;
  owner_signature: string;
  owner_public_key: string;
}

export interface ProofFile {
  format: typeof PROOF_FORMAT;
  checkpoint: Checkpoint | null;
  entry_count: number;
  checkpoint_count: number;
}

export interface KeysFile {
  log_keys: PublicLogKey[];
  owner_rules_public_key: string;
}

/** In-memory export. `proof` is the small file a UI can offer as a download. */
export interface InMemoryBundle {
  entries: ReceiptEntry[];
  checkpoints: Checkpoint[];
  rulesets: StoredRuleset[];
  keys: KeysFile;
  proof: ProofFile;
}

export interface WriterOptions {
  keyId: string;
  secretKey: Uint8Array;
  ownerPublicKey: string;
  /** First instant the initial log key may sign. */
  validFrom: string;
  checkpointEvery?: number;
  checkpointIntervalMs?: number;
}

export interface PaymentLogArgs {
  evaluation: EvaluationInput;
  intentId: string;
  payloadHash: string;
  provider?: string;
  providerRef?: ProviderRef;
}

export interface OutcomeArgs {
  intentId: string;
  agentId: string;
  chain: string;
  payloadHash: string;
  rulesetHash: string;
  status: ReceiptOutcome["status"];
  txHash?: string | null;
  now: string;
  provider?: string;
  providerRef?: ProviderRef;
}

export interface NoticeArgs {
  intentId: string;
  agentId: string;
  chain: string;
  payloadHash: string;
  rulesetHash: string;
  now: string;
  provider?: string;
  providerRef?: ProviderRef;
}

export class ReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptError";
  }
}

interface ActiveKey {
  keyId: string;
  secretKey: Uint8Array;
  publicKeyHex: string;
}

interface WriterState {
  entries: ReceiptEntry[];
  checkpoints: Checkpoint[];
  rulesets: Map<string, StoredRuleset>;
  keys: PublicLogKey[];
  active: ActiveKey;
  ownerPublicKey: string;
  checkpointEvery: number;
  checkpointIntervalMs: number;
}

export interface ReceiptWriter {
  appendRulesetActivated(args: {
    ruleset: unknown;
    ownerSignature: string;
    ownerPublicKey: string;
    agentId: string;
    now: string;
  }): ReceiptEntry;
  appendAttempt(args: PaymentLogArgs): ReceiptEntry;
  appendDecision(args: PaymentLogArgs): ReceiptEntry;
  appendOutcome(args: OutcomeArgs): ReceiptEntry;
  appendApproveSent(args: NoticeArgs): ReceiptEntry;
  appendRejectSent(args: NoticeArgs): ReceiptEntry;
  appendGap(args: { agentId: string; now: string; note: string }): ReceiptEntry;
  appendCheckpointRef(now: string): ReceiptEntry;
  rotateKey(args: { keyId: string; secretKey: Uint8Array; now: string }): ReceiptEntry;
  checkpoint(now: string): Checkpoint;
  maybeCheckpoint(now: string): Checkpoint | null;
  exportBundle(now: string): InMemoryBundle;
}

/**
 * entry_hash = SHA-256(0x00 || prev_hash || JCS(entry without entry_hash and sig)).
 * prev_hash is the raw 32-byte digest, and it is also a field inside the JCS object.
 */
export function computeEntryHash(body: Record<string, unknown>): Uint8Array | null {
  if (typeof body.prev_hash !== "string" || !isHex(body.prev_hash, 32)) return null;
  const prev = hexDecode(body.prev_hash);
  const canonical = canonicalJson(body);
  if (!prev || canonical === null) return null;
  return sha256(concatBytes([Uint8Array.of(0x00), prev, utf8(canonical)]));
}

export function receiptSigningMessage(entryHash: Uint8Array): Uint8Array {
  return concatBytes([utf8(RECEIPT_DOMAIN), entryHash]);
}

/**
 * Signed bytes are the domain string plus SHA-256 of the canonical checkpoint without `sig`.
 * The spec names the checkpoint fields and requires a signature, and it does not define those bytes.
 */
export function checkpointSigningMessage(checkpoint: unknown): Uint8Array | null {
  const canonical = canonicalJson(checkpoint);
  if (canonical === null) return null;
  return concatBytes([utf8(CHECKPOINT_DOMAIN), sha256(utf8(canonical))]);
}

export function createReceiptWriter(options: WriterOptions): ReceiptWriter {
  if (typeof options.keyId !== "string" || options.keyId.length === 0) {
    throw new ReceiptError("Log key id is required.");
  }
  if (!(options.secretKey instanceof Uint8Array) || options.secretKey.length !== 32) {
    throw new ReceiptError("Log secret key must be 32 bytes.");
  }
  const publicKeyHex = hexEncode(ed.getPublicKey(options.secretKey));
  const owner = normalizeKeyHex(options.ownerPublicKey);
  if (!owner) throw new ReceiptError("Owner rules public key must be 32 bytes of hex.");
  if (parseTimeMs(options.validFrom) === null) {
    throw new ReceiptError("validFrom must be an RFC 3339 timestamp.");
  }
  const every = options.checkpointEvery ?? DEFAULT_CHECKPOINT_EVERY;
  const interval = options.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS;
  if (!Number.isSafeInteger(every) || every < 1) {
    throw new ReceiptError("checkpointEvery must be a positive integer.");
  }
  if (!Number.isSafeInteger(interval) || interval < 1) {
    throw new ReceiptError("checkpointIntervalMs must be a positive integer.");
  }
  const state: WriterState = {
    entries: [],
    checkpoints: [],
    rulesets: new Map(),
    keys: [
      {
        key_id: options.keyId,
        public_key: publicKeyHex,
        valid_from: options.validFrom,
        valid_until: null,
      },
    ],
    active: { keyId: options.keyId, secretKey: options.secretKey, publicKeyHex },
    ownerPublicKey: owner,
    checkpointEvery: every,
    checkpointIntervalMs: interval,
  };
  return {
    appendRulesetActivated(args) {
      const hash = rememberRuleset(state, args.ruleset, args.ownerSignature, args.ownerPublicKey, true);
      return appendEntry(state, baseDraft({
        type: "RULESET_ACTIVATED",
        agentId: args.agentId,
        intentId: null,
        chain: "",
        payloadHash: EMPTY_PAYLOAD_HASH,
        summary: emptySummary(),
        rulesetHash: hash,
        decision: null,
        outcome: null,
        context: null,
      }), args.now);
    },
    appendAttempt(args) {
      const { hash, context, summary, chain, agentId } = bindEvaluation(state, args, null);
      return appendEntry(state, baseDraft({
        type: "ATTEMPT",
        agentId,
        intentId: args.intentId,
        chain,
        payloadHash: args.payloadHash,
        summary,
        rulesetHash: hash,
        decision: null,
        outcome: null,
        context,
        provider: args.provider,
        providerRef: args.providerRef,
      }), clockOf(args.evaluation));
    },
    appendDecision(args) {
      const decision = evaluate(args.evaluation);
      const snapshot = receiptPriceSnapshot(args.evaluation.intent, args.evaluation.prices);
      const recorded: ReceiptDecision = {
        result: decision.result,
        reasons: [...decision.reasons],
        price_snapshot: snapshot,
      };
      const { hash, context, summary, chain, agentId } = bindEvaluation(state, args, decision);
      return appendEntry(state, baseDraft({
        type: "DECISION",
        agentId,
        intentId: args.intentId,
        chain,
        payloadHash: args.payloadHash,
        summary,
        rulesetHash: hash,
        decision: recorded,
        outcome: null,
        context,
        provider: args.provider,
        providerRef: args.providerRef,
      }), clockOf(args.evaluation));
    },
    appendOutcome(args) {
      requireHash(args.payloadHash, "payloadHash");
      requireHash(args.rulesetHash, "rulesetHash");
      if (!OUTCOME_STATUS.has(args.status)) throw new ReceiptError("Outcome status is not recognized.");
      return appendEntry(state, baseDraft({
        type: "OUTCOME",
        agentId: args.agentId,
        intentId: args.intentId,
        chain: args.chain,
        payloadHash: args.payloadHash,
        summary: emptySummary(),
        rulesetHash: args.rulesetHash,
        decision: null,
        outcome: { status: args.status, tx_hash: args.txHash ?? null },
        context: null,
        provider: args.provider,
        providerRef: args.providerRef,
      }), args.now);
    },
    appendApproveSent(args) {
      return appendNotice(state, "APPROVE_SENT", args);
    },
    appendRejectSent(args) {
      return appendNotice(state, "REJECT_SENT", args);
    },
    appendGap(args) {
      if (typeof args.note !== "string" || args.note.length === 0) {
        throw new ReceiptError("A gap note is required.");
      }
      return appendEntry(state, baseDraft({
        type: "GAP",
        agentId: args.agentId,
        intentId: null,
        chain: "",
        payloadHash: EMPTY_PAYLOAD_HASH,
        summary: emptySummary(),
        rulesetHash: EMPTY_PAYLOAD_HASH,
        decision: null,
        outcome: null,
        context: { gap: { note: args.note } },
      }), args.now);
    },
    appendCheckpointRef(now) {
      const latest = state.checkpoints[state.checkpoints.length - 1];
      if (!latest) throw new ReceiptError("No checkpoint exists to reference.");
      return appendEntry(state, baseDraft({
        type: "CHECKPOINT_REF",
        agentId: "",
        intentId: null,
        chain: "",
        payloadHash: EMPTY_PAYLOAD_HASH,
        summary: emptySummary(),
        rulesetHash: EMPTY_PAYLOAD_HASH,
        decision: null,
        outcome: null,
        context: {
          checkpoint_ref: {
            merkle_root: latest.merkle_root,
            from_seq: latest.from_seq,
            to_seq: latest.to_seq,
          },
        },
      }), now);
    },
    rotateKey(args) {
      if (typeof args.keyId !== "string" || args.keyId.length === 0) {
        throw new ReceiptError("The new log key id is required.");
      }
      if (state.keys.some((key) => key.key_id === args.keyId)) {
        throw new ReceiptError("That log key id is already in use.");
      }
      if (!(args.secretKey instanceof Uint8Array) || args.secretKey.length !== 32) {
        throw new ReceiptError("The new log secret key must be 32 bytes.");
      }
      const publicKeyHex = hexEncode(ed.getPublicKey(args.secretKey));
      const entry = appendEntry(state, baseDraft({
        type: "KEY_ROTATION",
        agentId: "",
        intentId: null,
        chain: "",
        payloadHash: EMPTY_PAYLOAD_HASH,
        summary: emptySummary(),
        rulesetHash: EMPTY_PAYLOAD_HASH,
        decision: null,
        outcome: null,
        context: { rotation: { new_key_id: args.keyId, public_key: publicKeyHex } },
      }), args.now);
      const current = state.keys.find((key) => key.key_id === state.active.keyId);
      if (current && current.valid_until === null) current.valid_until = args.now;
      state.keys.push({
        key_id: args.keyId,
        public_key: publicKeyHex,
        valid_from: args.now,
        valid_until: null,
      });
      state.active = { keyId: args.keyId, secretKey: args.secretKey, publicKeyHex };
      return entry;
    },
    checkpoint(now) {
      return makeCheckpoint(state, now);
    },
    maybeCheckpoint(now) {
      return maybeMakeCheckpoint(state, now);
    },
    exportBundle(now) {
      return exportState(state, now);
    },
  };
}

interface Draft {
  type: ReceiptType;
  agentId: string;
  intentId: string | null;
  chain: string;
  payloadHash: string;
  summary: ReceiptSummary;
  rulesetHash: string;
  decision: ReceiptDecision | null;
  outcome: ReceiptOutcome | null;
  context: ReceiptContext | null;
  provider?: string;
  providerRef?: ProviderRef;
}

const OUTCOME_STATUS = new Set<ReceiptOutcome["status"]>([
  "signed",
  "broadcast",
  "confirmed",
  "failed",
  "expired",
  "rejected",
]);

function baseDraft(draft: Draft): Draft {
  return draft;
}

function appendNotice(state: WriterState, type: "APPROVE_SENT" | "REJECT_SENT", args: NoticeArgs): ReceiptEntry {
  if (typeof args.intentId !== "string" || args.intentId.length === 0) {
    throw new ReceiptError("intentId is required.");
  }
  requireHash(args.payloadHash, "payloadHash");
  requireHash(args.rulesetHash, "rulesetHash");
  return appendEntry(state, baseDraft({
    type,
    agentId: args.agentId,
    intentId: args.intentId,
    chain: args.chain,
    payloadHash: args.payloadHash,
    summary: emptySummary(),
    rulesetHash: args.rulesetHash,
    decision: null,
    outcome: null,
    context: null,
    provider: args.provider,
    providerRef: args.providerRef,
  }), args.now);
}

function appendEntry(state: WriterState, draft: Draft, now: string): ReceiptEntry {
  const ts = parseTimeMs(now);
  if (ts === null) throw new ReceiptError("Receipt time must be an RFC 3339 timestamp.");
  const prev = state.entries[state.entries.length - 1];
  if (prev) {
    const prevTs = parseTimeMs(prev.ts);
    if (prevTs === null || ts < prevTs) throw new ReceiptError("Receipt time moves backwards.");
  }
  assertKeyCovers(state, state.active.keyId, now);
  requireHash(draft.payloadHash, "payloadHash");
  requireHash(draft.rulesetHash, "rulesetHash");
  const body: Record<string, unknown> = {
    v: 1,
    seq: prev ? prev.seq + 1 : 0,
    ts: now,
    type: draft.type,
    agent_id: draft.agentId,
    intent_id: draft.intentId,
    provider: draft.provider ?? "turnkey",
    provider_ref: draft.providerRef ?? { activity_id: null, fingerprint: null },
    chain: draft.chain,
    payload_hash: draft.payloadHash.toLowerCase(),
    summary: draft.summary,
    ruleset_hash: draft.rulesetHash.toLowerCase(),
    decision: draft.decision,
    outcome: draft.outcome,
    context: draft.context,
    prev_hash: prev ? prev.entry_hash : GENESIS_PREV_HASH,
    key_id: state.active.keyId,
  };
  const entryHash = computeEntryHash(body);
  if (!entryHash) throw new ReceiptError("Receipt entry could not be hashed.");
  const sig = ed.sign(receiptSigningMessage(entryHash), state.active.secretKey);
  const entry = {
    ...(body as unknown as Omit<ReceiptEntry, "entry_hash" | "sig">),
    entry_hash: hexEncode(entryHash),
    sig: b64Encode(sig),
  } as ReceiptEntry;
  state.entries.push(entry);
  maybeMakeCheckpoint(state, now);
  return entry;
}

function makeCheckpoint(state: WriterState, now: string): Checkpoint {
  if (state.entries.length === 0) throw new ReceiptError("Cannot checkpoint an empty log.");
  const ts = parseTimeMs(now);
  if (ts === null) throw new ReceiptError("Checkpoint time must be an RFC 3339 timestamp.");
  const last = state.entries[state.entries.length - 1];
  if (!last) throw new ReceiptError("Cannot checkpoint an empty log.");
  const lastTs = parseTimeMs(last.ts);
  if (lastTs === null || ts < lastTs) {
    throw new ReceiptError("Checkpoint time is earlier than the log head.");
  }
  const existing = state.checkpoints.find((item) => item.from_seq === 0 && item.to_seq === last.seq);
  if (existing) return existing;
  assertKeyCovers(state, state.active.keyId, now);
  const leaves = state.entries.map((entry) => {
    const bytes = hexDecode(entry.entry_hash);
    if (!bytes) throw new ReceiptError("Entry hash is not hex.");
    return bytes;
  });
  const unsigned = {
    from_seq: 0,
    to_seq: last.seq,
    tree_size: state.entries.length,
    merkle_root: hexEncode(merkleRoot(leaves)),
    log_head_hash: last.entry_hash,
    ts: now,
    key_id: state.active.keyId,
  };
  const message = checkpointSigningMessage(unsigned);
  if (!message) throw new ReceiptError("Checkpoint could not be canonicalized.");
  const sig = ed.sign(message, state.active.secretKey);
  const checkpoint: Checkpoint = { ...unsigned, sig: b64Encode(sig) };
  state.checkpoints.push(checkpoint);
  return checkpoint;
}

function maybeMakeCheckpoint(state: WriterState, now: string): Checkpoint | null {
  if (state.entries.length === 0) return null;
  const nowMs = parseTimeMs(now);
  if (nowMs === null) return null;
  const last = state.entries[state.entries.length - 1];
  if (!last) return null;
  if (state.checkpoints.some((item) => item.from_seq === 0 && item.to_seq === last.seq)) return null;
  const coveredThrough = latestCoveredSeq(state);
  const uncovered = state.entries.length - (coveredThrough + 1);
  const dueByCount = uncovered >= state.checkpointEvery;
  const anchorMs = lastCheckpointMs(state) ?? parseTimeMs(state.entries[0]?.ts ?? "");
  const dueByTime = anchorMs !== null && nowMs - anchorMs >= state.checkpointIntervalMs;
  if (!dueByCount && !dueByTime) return null;
  return makeCheckpoint(state, now);
}

function latestCoveredSeq(state: WriterState): number {
  let covered = -1;
  for (const checkpoint of state.checkpoints) {
    if (checkpoint.from_seq === 0 && checkpoint.to_seq > covered) covered = checkpoint.to_seq;
  }
  return covered;
}

function lastCheckpointMs(state: WriterState): number | null {
  const latest = state.checkpoints[state.checkpoints.length - 1];
  if (!latest) return null;
  return parseTimeMs(latest.ts);
}

function exportState(state: WriterState, now: string): InMemoryBundle {
  if (state.entries.length > 0) {
    const last = state.entries[state.entries.length - 1];
    if (last && !state.checkpoints.some((item) => item.from_seq === 0 && item.to_seq === last.seq)) {
      makeCheckpoint(state, now);
    }
  }
  const latest = state.checkpoints[state.checkpoints.length - 1] ?? null;
  return {
    entries: state.entries.map((entry) => jsonClone(entry)),
    checkpoints: state.checkpoints.map((checkpoint) => jsonClone(checkpoint)),
    rulesets: [...state.rulesets.values()].map((ruleset) => jsonClone(ruleset)),
    keys: {
      log_keys: state.keys.map((key) => jsonClone(key)),
      owner_rules_public_key: state.ownerPublicKey,
    },
    proof: {
      format: PROOF_FORMAT,
      checkpoint: latest ? jsonClone(latest) : null,
      entry_count: state.entries.length,
      checkpoint_count: state.checkpoints.length,
    },
  };
}

function bindEvaluation(
  state: WriterState,
  args: PaymentLogArgs,
  decision: Decision | null,
): { hash: string; context: ReceiptContext; summary: ReceiptSummary; chain: string; agentId: string } {
  if (typeof args.intentId !== "string" || args.intentId.length === 0) {
    throw new ReceiptError("intentId is required.");
  }
  requireHash(args.payloadHash, "payloadHash");
  const evaluation = args.evaluation;
  if (!isRecord(evaluation)) throw new ReceiptError("Evaluation input must be an object.");
  const clock = clockOf(evaluation);
  if (typeof evaluation.ownerSignature !== "string" || typeof evaluation.ownerPublicKey !== "string") {
    throw new ReceiptError("Evaluation input is missing the owner signature.");
  }
  const owner = normalizeKeyHex(evaluation.ownerPublicKey);
  if (owner !== state.ownerPublicKey) {
    throw new ReceiptError("Evaluation owner key does not match the log owner key.");
  }
  const verified = verifyRulesetSignature(evaluation.ruleset, evaluation.ownerSignature, evaluation.ownerPublicKey);
  const hashed = hashRuleset(evaluation.ruleset);
  let hash = EMPTY_PAYLOAD_HASH;
  if (hashed && verified.ok) {
    hash = rememberRuleset(state, evaluation.ruleset, evaluation.ownerSignature, evaluation.ownerPublicKey, false);
  } else if (hashed) {
    hash = hashed;
    rememberUnsigned(state, evaluation.ruleset, evaluation.ownerSignature, evaluation.ownerPublicKey, hashed);
  }
  const intent = evaluation.intent;
  const agentId = isRecord(intent) && typeof intent.agentId === "string" ? intent.agentId : "";
  const chain = isRecord(intent) && typeof intent.chain === "string" ? intent.chain : "";
  const context: ReceiptContext = { evaluation: toContext(evaluation, clock) };
  return {
    hash,
    context,
    summary: summaryFrom(intent, decision?.usdValue ?? null),
    chain,
    agentId,
  };
}

function toContext(evaluation: EvaluationInput, now: string): EvaluationContext {
  const cloned = jsonClone(evaluation) as unknown as EvaluationContext;
  cloned.now = now;
  return cloned;
}

function clockOf(evaluation: EvaluationInput): string {
  if (typeof evaluation.now !== "string" || parseTimeMs(evaluation.now) === null) {
    throw new ReceiptError("Evaluation now must be an RFC 3339 timestamp.");
  }
  return evaluation.now;
}

function rememberRuleset(
  state: WriterState,
  body: unknown,
  signature: string,
  publicKey: string,
  requireValid: boolean,
): string {
  const owner = normalizeKeyHex(publicKey);
  if (owner !== state.ownerPublicKey) {
    throw new ReceiptError("Ruleset owner key does not match the log owner key.");
  }
  const check = verifyRulesetSignature(body, signature, publicKey);
  if (requireValid && !check.ok) throw new ReceiptError(check.message);
  const hash = check.bodyHash || hashRuleset(body);
  if (!hash) throw new ReceiptError("Ruleset body cannot be hashed.");
  storeRuleset(state, body, signature, owner, hash);
  return hash;
}

function rememberUnsigned(
  state: WriterState,
  body: unknown,
  signature: string,
  publicKey: string,
  hash: string,
): void {
  const owner = normalizeKeyHex(publicKey);
  if (!owner) return;
  storeRuleset(state, body, signature, owner, hash);
}

function storeRuleset(
  state: WriterState,
  body: unknown,
  signature: string,
  publicKey: string,
  hash: string,
): void {
  const existing = state.rulesets.get(hash);
  const canonical = canonicalJson(body);
  if (existing) {
    if (canonicalJson(existing.body) !== canonical) {
      throw new ReceiptError("Ruleset hash collision with a different body.");
    }
    return;
  }
  state.rulesets.set(hash, {
    body: jsonClone(body),
    body_hash: hash,
    owner_signature: signature,
    owner_public_key: publicKey,
  });
}

function summaryFrom(intent: unknown, usd: string | null): ReceiptSummary {
  if (!isRecord(intent)) return { ...emptySummary(), usd_value: usd };
  return {
    to: typeof intent.to === "string" ? intent.to : null,
    asset_id: typeof intent.assetId === "string" ? intent.assetId : null,
    amount_base_units: typeof intent.amountBaseUnits === "string" ? intent.amountBaseUnits : null,
    decimals: typeof intent.decimals === "number" ? intent.decimals : null,
    usd_value: usd,
    kind: typeof intent.kind === "string" ? intent.kind : null,
  };
}

function emptySummary(): ReceiptSummary {
  return {
    to: null,
    asset_id: null,
    amount_base_units: null,
    decimals: null,
    usd_value: null,
    kind: null,
  };
}

/** Quote recorded on a decision: the payment asset only, under the names the spec uses. */
export function receiptPriceSnapshot(intent: unknown, prices: unknown): PriceSnapshot | null {
  if (!isRecord(intent) || typeof intent.assetId !== "string" || !isRecord(prices)) return null;
  const quote = prices[intent.assetId];
  if (!isRecord(quote)) return null;
  if (typeof quote.source !== "string" || typeof quote.priceUsd !== "string" || typeof quote.observedAt !== "string") {
    return null;
  }
  return { source: quote.source, price: quote.priceUsd, ts: quote.observedAt };
}

function assertKeyCovers(state: WriterState, keyId: string, now: string): void {
  const key = state.keys.find((item) => item.key_id === keyId);
  if (!key || !keyCovers(key, now)) {
    throw new ReceiptError(`Log key ${keyId} is not valid at ${now}.`);
  }
}

export function keyCovers(key: PublicLogKey, ts: string): boolean {
  const at = parseTimeMs(ts);
  const from = parseTimeMs(key.valid_from);
  if (at === null || from === null || at < from) return false;
  if (key.valid_until === null) return true;
  const until = parseTimeMs(key.valid_until);
  return until !== null && at <= until;
}

function requireHash(value: string, label: string): void {
  if (typeof value !== "string" || !isHex(value.toLowerCase(), 32)) {
    throw new ReceiptError(`${label} must be 32 bytes of hex.`);
  }
}

function normalizeKeyHex(value: string): string | null {
  if (typeof value !== "string") return null;
  const bytes = hexDecode(value.trim());
  if (!bytes || bytes.length !== 32) return null;
  return hexEncode(bytes);
}
