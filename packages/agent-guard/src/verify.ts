import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { readBundle } from "./bundle.js";
import { canonicalJson } from "./canonical.js";
import { b64Decode, hexDecode, hexEncode, isHex } from "./encoding.js";
import { evaluate } from "./evaluate.js";
import { merkleRoot } from "./merkle.js";
import {
  EMPTY_PAYLOAD_HASH,
  GENESIS_PREV_HASH,
  PROOF_FORMAT,
  RECEIPT_TYPES,
  checkpointSigningMessage,
  computeEntryHash,
  keyCovers,
  receiptPriceSnapshot,
  receiptSigningMessage,
  type Checkpoint,
  type InMemoryBundle,
  type PublicLogKey,
  type StoredRuleset,
} from "./receipt.js";
import { hashRuleset, verifyRulesetSignature } from "./signature.js";
import { parseTimeMs } from "./time.js";
import { isRecord } from "./types.js";

ed.hashes.sha512 = sha512;

const RECEIPT_TYPE_SET = new Set<string>(RECEIPT_TYPES);
const DECISION_RESULTS = new Set(["allow", "deny", "escalate"]);
const OUTCOME_STATUS = new Set(["signed", "broadcast", "confirmed", "failed", "expired", "rejected"]);
const HEAD_NOTE =
  "External anchors are not checked. A shortened log that still ends on an older signed checkpoint is accepted unless a previously saved head hash is supplied.";

export interface VerifyIssue {
  code: string;
  message: string;
  seq?: number;
}

export interface VerifyStats {
  attempts: number;
  decisions: number;
  allowed: number;
  denied: number;
  escalated: number;
}

export interface VerifyReport {
  ok: boolean;
  errors: VerifyIssue[];
  summary: string;
  stats: VerifyStats;
  notes: string[];
}

export interface VerifyOptions {
  expectedHeadHash?: string;
  expectedTreeSize?: number;
  notes?: string[];
}

/** Check an in-memory export. Tamper findings are reported. This function does not throw for a bad log. */
export function verifyBundle(input: unknown, options: VerifyOptions = {}): VerifyReport {
  const errors: VerifyIssue[] = [];
  const notes = [...(options.notes ?? []), HEAD_NOTE];
  const stats: VerifyStats = { attempts: 0, decisions: 0, allowed: 0, denied: 0, escalated: 0 };
  const bundle = asBundle(input, errors);
  if (!bundle) return finish(errors, stats, notes);

  const keys = parseKeys(bundle.keys, errors);
  const rulesets = parseRulesets(bundle.rulesets, bundle.keys, errors);
  const entries = bundle.entries;
  let activeKeyId: string | null = null;
  const introduced = new Set<string>();
  const activeAfter: string[] = [];
  const intents = new Map<string, string>();
  let previousHash = GENESIS_PREV_HASH;
  let previousMs: number | null = null;

  for (let index = 0; index < entries.length; index += 1) {
    const raw = entries[index];
    if (!isRecord(raw)) {
      errors.push({ code: "ENTRY_SHAPE", message: `Entry ${index} is not an object.`, seq: index });
      previousHash = "";
      activeAfter[index] = activeKeyId ?? "";
      continue;
    }
    const seq = readSeq(raw, index, errors);
    const digest = checkEntryHash(raw, seq, errors);
    checkSignature(raw, digest, keys, seq, errors);
    checkLinks(raw, index, previousHash, previousMs, errors);
    const entryMs = typeof raw.ts === "string" ? parseTimeMs(raw.ts) : null;
    if (entryMs !== null) previousMs = entryMs;
    if (typeof raw.entry_hash === "string" && isHex(raw.entry_hash, 32)) previousHash = raw.entry_hash;

    const keyId = typeof raw.key_id === "string" ? raw.key_id : "";
    if (activeKeyId === null) activeKeyId = keyId;
    if (keyId !== activeKeyId) {
      errors.push({
        code: "KEY_WINDOW",
        message: `Entry ${seq} is signed by ${keyId || "an empty key id"}, which is not the active log key ${activeKeyId}.`,
        seq,
      });
    }
    const key = keys.get(keyId);
    if (!key) {
      errors.push({ code: "KEY_UNKNOWN", message: `Entry ${seq} names an unknown log key.`, seq });
    } else if (typeof raw.ts === "string" && !keyCovers(key, raw.ts)) {
      errors.push({
        code: "KEY_WINDOW",
        message: `Log key ${keyId} does not cover ${raw.ts}.`,
        seq,
      });
    }

    const type = typeof raw.type === "string" ? raw.type : "";
    countStats(raw, type, stats);
    if (type !== "DECISION" && raw.decision !== null) {
      errors.push({ code: "ENTRY_SHAPE", message: `Entry ${seq} must not carry a decision.`, seq });
    }
    if (type !== "OUTCOME" && raw.outcome !== null) {
      errors.push({ code: "ENTRY_SHAPE", message: `Entry ${seq} must not carry an outcome.`, seq });
    }
    if (typeof raw.ruleset_hash === "string" && raw.ruleset_hash !== EMPTY_PAYLOAD_HASH && !rulesets.has(raw.ruleset_hash)) {
      errors.push({ code: "RULESET_MISSING", message: `Entry ${seq} ruleset ${raw.ruleset_hash} is not in the bundle.`, seq });
    }
    if (type === "ATTEMPT" || type === "DECISION") {
      checkPaymentEntry(raw, type, rulesets, intents, seq, errors);
    } else if (type === "RULESET_ACTIVATED") {
      checkActivated(raw, rulesets, seq, errors);
    } else if (type === "OUTCOME" || type === "APPROVE_SENT" || type === "REJECT_SENT") {
      checkIntentSeen(raw, intents, seq, errors);
      if (type === "OUTCOME") checkOutcome(raw, seq, errors);
    } else if (type === "GAP") {
      checkGap(raw, seq, errors);
    } else if (type === "KEY_ROTATION") {
      const next = checkRotation(raw, keys, activeKeyId, introduced, seq, errors);
      if (next) {
        introduced.add(next);
        activeKeyId = next;
      }
    } else if (type === "CHECKPOINT_REF") {
      checkCheckpointRef(raw, bundle.checkpoints, seq, errors);
    }
    activeAfter[index] = activeKeyId ?? "";
  }

  if (entries.length > 0 && activeKeyId !== null) {
    const initial = typeof entries[0] === "object" && entries[0] && isRecord(entries[0]) && typeof entries[0].key_id === "string"
      ? entries[0].key_id
      : "";
    const known = new Set<string>([initial, ...introduced]);
    for (const key of keys.values()) {
      if (!known.has(key.key_id)) {
        errors.push({
          code: "KEY_UNKNOWN",
          message: `Log key ${key.key_id} is not the initial key and was not introduced by a rotation.`,
        });
      }
    }
  }

  checkCheckpoints(bundle, keys, activeAfter, errors);
  checkProof(bundle, errors);
  checkExpectations(bundle, options, errors);
  return finish(errors, stats, notes);
}

export function verifyDirectory(dir: string, options: VerifyOptions = {}): VerifyReport {
  const read = readBundle(dir);
  if (!read.bundle) {
    const errors = read.errors.map((message) => ({ code: "BUNDLE_READ", message }));
    return finish(errors, { attempts: 0, decisions: 0, allowed: 0, denied: 0, escalated: 0 }, [
      ...read.notes,
      ...(options.notes ?? []),
      HEAD_NOTE,
    ]);
  }
  return verifyBundle(read.bundle, { ...options, notes: [...read.notes, ...(options.notes ?? [])] });
}

function finish(errors: VerifyIssue[], stats: VerifyStats, notes: string[]): VerifyReport {
  const shown = stats.attempts > 0 ? stats.attempts : stats.decisions;
  const summary = errors.length === 0
    ? `${shown} payment attempts, ${stats.allowed} allowed, ${stats.denied} denied, ${stats.escalated} escalated; chain intact.`
    : `${shown} payment attempts, ${stats.allowed} allowed, ${stats.denied} denied, ${stats.escalated} escalated; chain check failed.`;
  return { ok: errors.length === 0, errors, summary, stats, notes };
}

function asBundle(input: unknown, errors: VerifyIssue[]): InMemoryBundle | null {
  if (!isRecord(input)) {
    errors.push({ code: "BUNDLE_SHAPE", message: "Bundle must be an object." });
    return null;
  }
  if (!Array.isArray(input.entries) || !Array.isArray(input.checkpoints) || !Array.isArray(input.rulesets)) {
    errors.push({ code: "BUNDLE_SHAPE", message: "Bundle is missing entries, checkpoints, or rulesets." });
    return null;
  }
  if (!isRecord(input.keys) || !isRecord(input.proof)) {
    errors.push({ code: "BUNDLE_SHAPE", message: "Bundle is missing keys or proof." });
    return null;
  }
  return input as unknown as InMemoryBundle;
}

function parseKeys(keys: InMemoryBundle["keys"], errors: VerifyIssue[]): Map<string, PublicLogKey> {
  const map = new Map<string, PublicLogKey>();
  if (!isRecord(keys) || !Array.isArray(keys.log_keys) || typeof keys.owner_rules_public_key !== "string") {
    errors.push({ code: "KEY_UNKNOWN", message: "keys.json must list log keys and the owner rules public key." });
    return map;
  }
  if (!isHex(normalizeHex(keys.owner_rules_public_key), 32)) {
    errors.push({ code: "KEY_UNKNOWN", message: "Owner rules public key must be 32 bytes of hex." });
  }
  for (const item of keys.log_keys) {
    if (!isRecord(item) || typeof item.key_id !== "string" || item.key_id.length === 0) {
      errors.push({ code: "KEY_UNKNOWN", message: "A log key is missing its id." });
      continue;
    }
    if (typeof item.public_key !== "string" || !isHex(item.public_key, 32)) {
      errors.push({ code: "KEY_UNKNOWN", message: `Log key ${item.key_id} public key must be lowercase hex.` });
      continue;
    }
    if (typeof item.valid_from !== "string" || parseTimeMs(item.valid_from) === null) {
      errors.push({ code: "KEY_WINDOW", message: `Log key ${item.key_id} has an invalid valid_from.` });
      continue;
    }
    if (item.valid_until !== null && (typeof item.valid_until !== "string" || parseTimeMs(item.valid_until) === null)) {
      errors.push({ code: "KEY_WINDOW", message: `Log key ${item.key_id} has an invalid valid_until.` });
      continue;
    }
    if (map.has(item.key_id)) {
      errors.push({ code: "KEY_UNKNOWN", message: `Log key ${item.key_id} is listed more than once.` });
      continue;
    }
    map.set(item.key_id, item as unknown as PublicLogKey);
  }
  return map;
}

function parseRulesets(
  rulesets: StoredRuleset[],
  keys: InMemoryBundle["keys"],
  errors: VerifyIssue[],
): Map<string, StoredRuleset> {
  const map = new Map<string, StoredRuleset>();
  const owner = isRecord(keys) && typeof keys.owner_rules_public_key === "string"
    ? normalizeHex(keys.owner_rules_public_key)
    : "";
  for (const ruleset of rulesets) {
    if (!isRecord(ruleset) || typeof ruleset.body_hash !== "string" || !isHex(ruleset.body_hash, 32)) {
      errors.push({ code: "RULESET_HASH", message: "A stored ruleset is missing a lowercase body hash." });
      continue;
    }
    const hashed = hashRuleset(ruleset.body);
    if (hashed !== ruleset.body_hash) {
      errors.push({
        code: "RULESET_HASH",
        message: `Stored ruleset ${ruleset.body_hash} does not hash to that id.`,
      });
      continue;
    }
    if (typeof ruleset.owner_public_key !== "string" || normalizeHex(ruleset.owner_public_key) !== owner) {
      errors.push({
        code: "RULESET_SIGNATURE",
        message: `Stored ruleset ${ruleset.body_hash} owner key does not match keys.json.`,
      });
    }
    const existing = map.get(ruleset.body_hash);
    if (existing && canonicalJson(existing.body) !== canonicalJson(ruleset.body)) {
      errors.push({ code: "RULESET_HASH", message: `Two different ruleset bodies share ${ruleset.body_hash}.` });
      continue;
    }
    map.set(ruleset.body_hash, ruleset);
  }
  return map;
}

function readSeq(entry: Record<string, unknown>, index: number, errors: VerifyIssue[]): number {
  if (typeof entry.seq !== "number" || !Number.isSafeInteger(entry.seq) || entry.seq !== index) {
    errors.push({
      code: "ENTRY_SEQ",
      message: `Entry at position ${index} must have seq ${index}.`,
      seq: index,
    });
    return index;
  }
  return entry.seq;
}

function checkEntryHash(entry: Record<string, unknown>, seq: number, errors: VerifyIssue[]): Uint8Array | null {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === "entry_hash" || key === "sig") continue;
    body[key] = value;
  }
  const digest = computeEntryHash(body);
  const claimed = typeof entry.entry_hash === "string" && isHex(entry.entry_hash, 32)
    ? hexDecode(entry.entry_hash)
    : null;
  if (!digest || !claimed || hexEncode(digest) !== hexEncode(claimed)) {
    errors.push({ code: "ENTRY_HASH", message: `Entry ${seq} hash does not match its body.`, seq });
  }
  return claimed;
}

function checkSignature(
  entry: Record<string, unknown>,
  digest: Uint8Array | null,
  keys: Map<string, PublicLogKey>,
  seq: number,
  errors: VerifyIssue[],
): void {
  if (!digest) return;
  const keyId = typeof entry.key_id === "string" ? entry.key_id : "";
  const key = keys.get(keyId);
  const pub = key ? hexDecode(key.public_key) : null;
  const sig = typeof entry.sig === "string" ? b64Decode(entry.sig, 64) : null;
  if (!pub || !sig || !verifyQuiet(receiptSigningMessage(digest), sig, pub)) {
    errors.push({ code: "ENTRY_SIG", message: `Entry ${seq} signature does not verify under its log key.`, seq });
  }
}

function checkLinks(
  entry: Record<string, unknown>,
  index: number,
  previousHash: string,
  previousMs: number | null,
  errors: VerifyIssue[],
): void {
  const seq = index;
  if (entry.v !== 1) {
    errors.push({ code: "ENTRY_SHAPE", message: `Entry ${seq} version must be 1.`, seq });
  }
  if (typeof entry.type !== "string" || !RECEIPT_TYPE_SET.has(entry.type)) {
    errors.push({ code: "ENTRY_TYPE", message: `Entry ${seq} type is not a receipt type.`, seq });
  }
  if (typeof entry.ts !== "string" || parseTimeMs(entry.ts) === null) {
    errors.push({ code: "ENTRY_TIME", message: `Entry ${seq} time is not RFC 3339.`, seq });
  } else if (previousMs !== null && parseTimeMs(entry.ts)! < previousMs) {
    errors.push({ code: "ENTRY_TIME", message: `Entry ${seq} time moves backwards.`, seq });
  }
  if (typeof entry.prev_hash !== "string" || entry.prev_hash !== previousHash) {
    errors.push({ code: "ENTRY_PREV", message: `Entry ${seq} prev_hash does not match the previous entry.`, seq });
  }
  if (typeof entry.payload_hash !== "string" || !isHex(entry.payload_hash, 32)) {
    errors.push({ code: "ENTRY_SHAPE", message: `Entry ${seq} payload_hash must be lowercase hex.`, seq });
  }
  if (typeof entry.ruleset_hash !== "string" || !isHex(entry.ruleset_hash, 32)) {
    errors.push({ code: "ENTRY_SHAPE", message: `Entry ${seq} ruleset_hash must be lowercase hex.`, seq });
  }
  if (typeof entry.agent_id !== "string" || typeof entry.chain !== "string" || typeof entry.provider !== "string") {
    errors.push({ code: "ENTRY_SHAPE", message: `Entry ${seq} is missing agent, chain, or provider.`, seq });
  }
  if (!("intent_id" in entry) || (entry.intent_id !== null && typeof entry.intent_id !== "string")) {
    errors.push({ code: "ENTRY_SHAPE", message: `Entry ${seq} intent_id must be a string or null.`, seq });
  }
  if (!isProviderRef(entry.provider_ref) || !isSummary(entry.summary)) {
    errors.push({ code: "ENTRY_SHAPE", message: `Entry ${seq} provider_ref or summary is malformed.`, seq });
  }
  if (!("decision" in entry) || !("outcome" in entry) || !("context" in entry)) {
    errors.push({ code: "ENTRY_SHAPE", message: `Entry ${seq} is missing decision, outcome, or context.`, seq });
  }
}

function checkPaymentEntry(
  entry: Record<string, unknown>,
  type: "ATTEMPT" | "DECISION",
  rulesets: Map<string, StoredRuleset>,
  intents: Map<string, string>,
  seq: number,
  errors: VerifyIssue[],
): void {
  const context = isRecord(entry.context) ? entry.context : null;
  const evaluation = context && isRecord(context.evaluation) ? context.evaluation : null;
  if (!evaluation) {
    errors.push({ code: "DECISION_MISMATCH", message: `Entry ${seq} is missing the evaluation context.`, seq });
    return;
  }
  const intentId = entry.intent_id;
  if (typeof intentId !== "string" || intentId.length === 0) {
    errors.push({ code: "ENTRY_SHAPE", message: `Entry ${seq} is missing intent_id.`, seq });
  } else {
    const canonical = canonicalJson(evaluation);
    const prior = intents.get(intentId);
    if (canonical === null) {
      errors.push({ code: "DECISION_MISMATCH", message: `Entry ${seq} evaluation cannot be canonicalized.`, seq });
    } else if (prior !== undefined && prior !== canonical) {
      errors.push({
        code: "ATTEMPT_MISMATCH",
        message: `Entry ${seq} evaluation does not match the earlier record of ${intentId}.`,
        seq,
      });
    } else {
      intents.set(intentId, canonical);
    }
  }
  const rulesetHash = typeof entry.ruleset_hash === "string" ? entry.ruleset_hash : "";
  const hashed = hashRuleset(evaluation.ruleset);
  if ((hashed ?? EMPTY_PAYLOAD_HASH) !== rulesetHash) {
    errors.push({ code: "RULESET_HASH", message: `Entry ${seq} ruleset_hash does not match the logged ruleset.`, seq });
  }
  if (rulesetHash !== EMPTY_PAYLOAD_HASH) {
    const stored = rulesets.get(rulesetHash);
    if (stored && canonicalJson(stored.body) !== canonicalJson(evaluation.ruleset)) {
      errors.push({ code: "RULESET_HASH", message: `Entry ${seq} ruleset body does not match the logged evaluation.`, seq });
    }
  }
  if (type === "ATTEMPT" && isRecord(entry.summary) && entry.summary.usd_value !== null) {
    errors.push({ code: "DECISION_MISMATCH", message: `Entry ${seq} attempt must not record a usd value.`, seq });
  }
  checkSummaryAgainstIntent(entry, evaluation.intent, seq, errors);
  if (typeof evaluation.intent === "object" && evaluation.intent && isRecord(evaluation.intent)) {
    const agent = typeof evaluation.intent.agentId === "string" ? evaluation.intent.agentId : "";
    const chain = typeof evaluation.intent.chain === "string" ? evaluation.intent.chain : "";
    if (entry.agent_id !== agent || entry.chain !== chain) {
      errors.push({ code: "DECISION_MISMATCH", message: `Entry ${seq} agent or chain does not match the intent.`, seq });
    }
  }
  if (type !== "DECISION") return;
  if (!isRecord(entry.decision) || !DECISION_RESULTS.has(String(entry.decision.result))) {
    errors.push({ code: "DECISION_MISMATCH", message: `Entry ${seq} decision result is missing.`, seq });
    return;
  }
  if (!Array.isArray(entry.decision.reasons) || entry.decision.reasons.some((reason) => typeof reason !== "string")) {
    errors.push({ code: "DECISION_MISMATCH", message: `Entry ${seq} decision reasons must be strings.`, seq });
    return;
  }
  const fresh = evaluate(evaluation);
  const loggedReasons = entry.decision.reasons as string[];
  if (fresh.result !== entry.decision.result || JSON.stringify(fresh.reasons) !== JSON.stringify(loggedReasons)) {
    errors.push({
      code: "DECISION_MISMATCH",
      message: `Entry ${seq} decision does not match a fresh evaluation (${fresh.result}).`,
      seq,
    });
  }
  const usd = fresh.usdValue ?? null;
  const summary = isRecord(entry.summary) ? entry.summary : null;
  if (!summary || summary.usd_value !== usd) {
    errors.push({ code: "DECISION_MISMATCH", message: `Entry ${seq} usd_value does not match evaluation.`, seq });
  }
  const snapshot = receiptPriceSnapshot(evaluation.intent, evaluation.prices);
  if (!sameValue(snapshot, entry.decision.price_snapshot)) {
    errors.push({ code: "DECISION_MISMATCH", message: `Entry ${seq} price snapshot does not match the logged prices.`, seq });
  }
  if (entry.decision.result === "allow" || entry.decision.result === "escalate") {
    const stored = rulesets.get(rulesetHash);
    if (!stored || !verifyRulesetSignature(stored.body, stored.owner_signature, stored.owner_public_key).ok) {
      errors.push({ code: "RULESET_SIGNATURE", message: `Entry ${seq} allow or escalate is not owner-signed.`, seq });
    }
  }
}

function checkActivated(
  entry: Record<string, unknown>,
  rulesets: Map<string, StoredRuleset>,
  seq: number,
  errors: VerifyIssue[],
): void {
  if (entry.decision !== null || entry.outcome !== null) {
    errors.push({ code: "ENTRY_SHAPE", message: `Entry ${seq} activation must not carry a decision or outcome.`, seq });
  }
  const rulesetHash = typeof entry.ruleset_hash === "string" ? entry.ruleset_hash : "";
  const stored = rulesets.get(rulesetHash);
  if (!stored) return;
  const check = verifyRulesetSignature(stored.body, stored.owner_signature, stored.owner_public_key);
  if (!check.ok) {
    errors.push({ code: "RULESET_SIGNATURE", message: `Activated ruleset signature failed: ${check.message}`, seq });
  }
}

function checkIntentSeen(
  entry: Record<string, unknown>,
  intents: Map<string, string>,
  seq: number,
  errors: VerifyIssue[],
): void {
  const intentId = entry.intent_id;
  if (typeof intentId !== "string" || intentId.length === 0 || !intents.has(intentId)) {
    errors.push({ code: "INTENT_UNKNOWN", message: `Entry ${seq} does not refer to an earlier attempt or decision.`, seq });
  }
}

function checkOutcome(entry: Record<string, unknown>, seq: number, errors: VerifyIssue[]): void {
  if (!isRecord(entry.outcome)) {
    errors.push({ code: "ENTRY_SHAPE", message: `Entry ${seq} outcome is missing.`, seq });
    return;
  }
  if (typeof entry.outcome.status !== "string" || !OUTCOME_STATUS.has(entry.outcome.status)) {
    errors.push({ code: "ENTRY_SHAPE", message: `Entry ${seq} outcome status is not recognized.`, seq });
  }
  if (entry.outcome.tx_hash !== null && typeof entry.outcome.tx_hash !== "string") {
    errors.push({ code: "ENTRY_SHAPE", message: `Entry ${seq} tx_hash must be a string or null.`, seq });
  }
}

function checkGap(entry: Record<string, unknown>, seq: number, errors: VerifyIssue[]): void {
  const context = isRecord(entry.context) ? entry.context : null;
  const gap = context && isRecord(context.gap) ? context.gap : null;
  if (!gap || typeof gap.note !== "string" || gap.note.length === 0) {
    errors.push({ code: "ENTRY_SHAPE", message: `Entry ${seq} gap note is missing.`, seq });
  }
}

function checkRotation(
  entry: Record<string, unknown>,
  keys: Map<string, PublicLogKey>,
  activeKeyId: string | null,
  introduced: Set<string>,
  seq: number,
  errors: VerifyIssue[],
): string | null {
  const context = isRecord(entry.context) ? entry.context : null;
  const rotation = context && isRecord(context.rotation) ? context.rotation : null;
  if (!rotation || typeof rotation.new_key_id !== "string" || typeof rotation.public_key !== "string") {
    errors.push({ code: "KEY_ROTATION", message: `Entry ${seq} rotation payload is missing.`, seq });
    return null;
  }
  if (!isHex(rotation.public_key, 32)) {
    errors.push({ code: "KEY_ROTATION", message: `Entry ${seq} rotation public key must be lowercase hex.`, seq });
    return null;
  }
  const next = keys.get(rotation.new_key_id);
  const current = activeKeyId ? keys.get(activeKeyId) : undefined;
  if (!next || next.public_key !== rotation.public_key) {
    errors.push({ code: "KEY_ROTATION", message: `Entry ${seq} rotation key does not match keys.json.`, seq });
    return null;
  }
  if (typeof entry.ts !== "string" || next.valid_from !== entry.ts) {
    errors.push({ code: "KEY_ROTATION", message: `Entry ${seq} new key must start at the rotation time.`, seq });
    return null;
  }
  if (!current || current.valid_until !== entry.ts) {
    errors.push({ code: "KEY_ROTATION", message: `Entry ${seq} must close the previous log key at the rotation time.`, seq });
    return null;
  }
  if (rotation.new_key_id === activeKeyId || introduced.has(rotation.new_key_id)) {
    errors.push({ code: "KEY_ROTATION", message: `Entry ${seq} reuses a log key id.`, seq });
    return null;
  }
  return rotation.new_key_id;
}

function checkCheckpointRef(
  entry: Record<string, unknown>,
  checkpoints: Checkpoint[],
  seq: number,
  errors: VerifyIssue[],
): void {
  const context = isRecord(entry.context) ? entry.context : null;
  const ref = context && isRecord(context.checkpoint_ref) ? context.checkpoint_ref : null;
  if (!ref) {
    errors.push({ code: "CHECKPOINT_COVERAGE", message: `Entry ${seq} checkpoint reference is missing.`, seq });
    return;
  }
  const match = checkpoints.some((checkpoint) =>
    checkpoint.from_seq === ref.from_seq &&
    checkpoint.to_seq === ref.to_seq &&
    checkpoint.merkle_root === ref.merkle_root &&
    typeof ref.to_seq === "number" &&
    ref.to_seq < seq
  );
  if (!match) {
    errors.push({ code: "CHECKPOINT_COVERAGE", message: `Entry ${seq} checkpoint reference does not match an earlier checkpoint.`, seq });
  }
}

function checkCheckpoints(
  bundle: InMemoryBundle,
  keys: Map<string, PublicLogKey>,
  activeAfter: string[],
  errors: VerifyIssue[],
): void {
  let previousTo = -1;
  let previousMs: number | null = null;
  const seen = new Set<number>();
  for (const raw of bundle.checkpoints) {
    if (!isRecord(raw)) {
      errors.push({ code: "CHECKPOINT_SHAPE", message: "A checkpoint is not an object." });
      continue;
    }
    const checkpoint = raw;
    if (
      checkpoint.from_seq !== 0 ||
      typeof checkpoint.to_seq !== "number" ||
      !Number.isSafeInteger(checkpoint.to_seq) ||
      checkpoint.tree_size !== checkpoint.to_seq + 1
    ) {
      errors.push({ code: "CHECKPOINT_SHAPE", message: "Checkpoint must be a full prefix from seq 0." });
      continue;
    }
    if (seen.has(checkpoint.to_seq)) {
      errors.push({ code: "CHECKPOINT_COVERAGE", message: `More than one checkpoint ends at seq ${checkpoint.to_seq}.` });
    }
    seen.add(checkpoint.to_seq);
    if (checkpoint.to_seq <= previousTo) {
      errors.push({ code: "CHECKPOINT_COVERAGE", message: "Checkpoints must move forward." });
    }
    previousTo = checkpoint.to_seq;
    if (typeof checkpoint.ts !== "string" || parseTimeMs(checkpoint.ts) === null) {
      errors.push({ code: "CHECKPOINT_SHAPE", message: "Checkpoint time is not RFC 3339." });
      continue;
    }
    const ts = parseTimeMs(checkpoint.ts)!;
    if (previousMs !== null && ts < previousMs) {
      errors.push({ code: "CHECKPOINT_SHAPE", message: "Checkpoint time moves backwards." });
    }
    previousMs = ts;
    const head = bundle.entries[checkpoint.to_seq];
    if (!isRecord(head) || checkpoint.to_seq >= bundle.entries.length) {
      errors.push({ code: "CHECKPOINT_COVERAGE", message: `Checkpoint ends at missing seq ${checkpoint.to_seq}.` });
      continue;
    }
    const headTs = typeof head.ts === "string" ? parseTimeMs(head.ts) : null;
    if (headTs === null || ts < headTs) {
      errors.push({ code: "CHECKPOINT_COVERAGE", message: "Checkpoint time is earlier than its log head." });
    }
    if (head.entry_hash !== checkpoint.log_head_hash) {
      errors.push({ code: "CHECKPOINT_MERKLE", message: `Checkpoint log head does not match seq ${checkpoint.to_seq}.` });
    }
    const leaves: Uint8Array[] = [];
    let leavesOk = true;
    for (let i = 0; i <= checkpoint.to_seq; i += 1) {
      const entry = bundle.entries[i];
      const hash = isRecord(entry) && typeof entry.entry_hash === "string" ? hexDecode(entry.entry_hash) : null;
      if (!hash || hash.length !== 32) {
        leavesOk = false;
        break;
      }
      leaves.push(hash);
    }
    if (!leavesOk || hexEncode(merkleRoot(leaves)) !== checkpoint.merkle_root) {
      errors.push({ code: "CHECKPOINT_MERKLE", message: `Checkpoint merkle root does not match entries 0 through ${checkpoint.to_seq}.` });
    }
    const expectedKey = activeAfter[checkpoint.to_seq];
    if (typeof checkpoint.key_id !== "string" || checkpoint.key_id !== expectedKey) {
      errors.push({
        code: "CHECKPOINT_SIG",
        message: `Checkpoint through seq ${checkpoint.to_seq} must be signed by the active log key.`,
      });
    }
    const key = typeof checkpoint.key_id === "string" ? keys.get(checkpoint.key_id) : undefined;
    if (!key || !keyCovers(key, checkpoint.ts)) {
      errors.push({ code: "CHECKPOINT_SIG", message: "Checkpoint log key is missing or outside its validity window." });
    }
    const unsigned = unsignedCheckpoint(checkpoint);
    const message = unsigned ? checkpointSigningMessage(unsigned) : null;
    const sig = typeof checkpoint.sig === "string" ? b64Decode(checkpoint.sig, 64) : null;
    const pub = key ? hexDecode(key.public_key) : null;
    if (!message || !sig || !pub || !verifyQuiet(message, sig, pub)) {
      errors.push({ code: "CHECKPOINT_SIG", message: `Checkpoint through seq ${checkpoint.to_seq} signature does not verify.` });
    }
  }
}

function checkProof(bundle: InMemoryBundle, errors: VerifyIssue[]): void {
  const proof = bundle.proof;
  if (!isRecord(proof) || proof.format !== PROOF_FORMAT) {
    errors.push({ code: "PROOF_MISMATCH", message: "proof.json format must be agent-guard/proof/1." });
    return;
  }
  if (proof.entry_count !== bundle.entries.length || proof.checkpoint_count !== bundle.checkpoints.length) {
    errors.push({ code: "PROOF_MISMATCH", message: "proof.json counts do not match the bundle." });
  }
  if (bundle.entries.length === 0) {
    if (proof.checkpoint !== null || bundle.checkpoints.length !== 0) {
      errors.push({ code: "PROOF_HEAD", message: "An empty log must not carry a checkpoint." });
    }
    return;
  }
  const last = bundle.entries[bundle.entries.length - 1];
  const lastSeq = isRecord(last) && typeof last.seq === "number" ? last.seq : -1;
  const covering = bundle.checkpoints.filter((item) => isRecord(item) && item.from_seq === 0 && item.to_seq === lastSeq);
  if (covering.length !== 1 || !sameValue(covering[0], proof.checkpoint)) {
    errors.push({ code: "PROOF_HEAD", message: "proof.json must carry the signed checkpoint that covers the log head." });
  }
}

function checkExpectations(bundle: InMemoryBundle, options: VerifyOptions, errors: VerifyIssue[]): void {
  if (options.expectedTreeSize !== undefined && options.expectedTreeSize !== bundle.entries.length) {
    errors.push({
      code: "PROOF_HEAD",
      message: `Log has ${bundle.entries.length} entries, expected ${options.expectedTreeSize}.`,
    });
  }
  if (options.expectedHeadHash === undefined) return;
  if (!isHex(options.expectedHeadHash, 32)) {
    errors.push({ code: "PROOF_HEAD", message: "Expected head hash must be 32 bytes of lowercase hex." });
    return;
  }
  const last = bundle.entries[bundle.entries.length - 1];
  const head = isRecord(last) && typeof last.entry_hash === "string" ? last.entry_hash : "";
  if (head !== options.expectedHeadHash) {
    errors.push({ code: "PROOF_HEAD", message: "Log head hash does not match the expected head." });
  }
}

function countStats(entry: Record<string, unknown>, type: string, stats: VerifyStats): void {
  if (type === "ATTEMPT") stats.attempts += 1;
  if (type !== "DECISION" || !isRecord(entry.decision)) return;
  stats.decisions += 1;
  if (entry.decision.result === "allow") stats.allowed += 1;
  else if (entry.decision.result === "deny") stats.denied += 1;
  else if (entry.decision.result === "escalate") stats.escalated += 1;
}

function checkSummaryAgainstIntent(entry: Record<string, unknown>, intent: unknown, seq: number, errors: VerifyIssue[]): void {
  if (!isRecord(entry.summary)) return;
  const summary = entry.summary;
  if (!isRecord(intent)) return;
  const expected = {
    to: typeof intent.to === "string" ? intent.to : null,
    asset_id: typeof intent.assetId === "string" ? intent.assetId : null,
    amount_base_units: typeof intent.amountBaseUnits === "string" ? intent.amountBaseUnits : null,
    decimals: typeof intent.decimals === "number" ? intent.decimals : null,
    kind: typeof intent.kind === "string" ? intent.kind : null,
  };
  if (
    summary.to !== expected.to ||
    summary.asset_id !== expected.asset_id ||
    summary.amount_base_units !== expected.amount_base_units ||
    summary.decimals !== expected.decimals ||
    summary.kind !== expected.kind
  ) {
    errors.push({ code: "DECISION_MISMATCH", message: `Entry ${seq} summary does not match the logged intent.`, seq });
  }
}

function unsignedCheckpoint(checkpoint: Record<string, unknown>): Record<string, unknown> | null {
  if (
    typeof checkpoint.from_seq !== "number" ||
    typeof checkpoint.to_seq !== "number" ||
    typeof checkpoint.tree_size !== "number" ||
    typeof checkpoint.merkle_root !== "string" ||
    typeof checkpoint.log_head_hash !== "string" ||
    typeof checkpoint.ts !== "string" ||
    typeof checkpoint.key_id !== "string"
  ) {
    return null;
  }
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(checkpoint)) {
    if (key === "sig") continue;
    body[key] = value;
  }
  return body;
}

function isProviderRef(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return nullableString(value.activity_id) && nullableString(value.fingerprint);
}

function isSummary(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    nullableString(value.to) &&
    nullableString(value.asset_id) &&
    nullableString(value.amount_base_units) &&
    (value.decimals === null || (typeof value.decimals === "number" && Number.isSafeInteger(value.decimals))) &&
    nullableString(value.usd_value) &&
    nullableString(value.kind)
  );
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function sameValue(left: unknown, right: unknown): boolean {
  const a = canonicalJson(left);
  const b = canonicalJson(right);
  return a !== null && a === b;
}

function normalizeHex(value: string): string {
  const bytes = hexDecode(value.trim());
  return bytes ? hexEncode(bytes) : "";
}

function verifyQuiet(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}
