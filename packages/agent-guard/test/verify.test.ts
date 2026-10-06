import assert from "node:assert/strict";
import * as ed from "@noble/ed25519";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { b64Encode, hexDecode, hexEncode } from "../src/encoding.js";
import { merkleRoot } from "../src/merkle.js";
import {
  PROOF_FORMAT,
  type InMemoryBundle,
  type ReceiptEntry,
  checkpointSigningMessage,
  computeEntryHash,
  createReceiptWriter,
  receiptSigningMessage,
} from "../src/receipt.js";
import { Reason } from "../src/codes.js";
import { writeBundle } from "../src/bundle.js";
import { verifyBundle, verifyDirectory } from "../src/verify.js";
import { AGENT, NOW, USDC, evaluation, keys, usdcIntent } from "./helpers.js";

const PAYLOAD = "ab".repeat(32);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function at(seconds: number): string {
  return new Date(Date.parse(NOW) + seconds * 1000).toISOString().replace(".000Z", "Z");
}

function logSecret(): Uint8Array {
  return ed.keygen().secretKey;
}

function writer(secretKey: Uint8Array) {
  return createReceiptWriter({
    keyId: "log-1",
    secretKey,
    ownerPublicKey: keys.publicKeyHex,
    validFrom: "2026-10-01T00:00:00Z",
    checkpointEvery: 1000,
    checkpointIntervalMs: 86_400_000,
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function resignEntry(entry: ReceiptEntry, secretKey: Uint8Array): void {
  const body: Record<string, unknown> = { ...entry };
  delete body.entry_hash;
  delete body.sig;
  const digest = computeEntryHash(body);
  if (!digest) throw new Error("entry hash");
  entry.entry_hash = hexEncode(digest);
  entry.sig = b64Encode(ed.sign(receiptSigningMessage(digest), secretKey));
}

function rebuildProof(bundle: InMemoryBundle, secretKey: Uint8Array, keyId: string): void {
  const last = bundle.entries[bundle.entries.length - 1];
  if (!last) {
    bundle.checkpoints = [];
    bundle.proof = { format: PROOF_FORMAT, checkpoint: null, entry_count: 0, checkpoint_count: 0 };
    return;
  }
  const leaves = bundle.entries.map((entry) => {
    const bytes = hexDecode(entry.entry_hash);
    if (!bytes) throw new Error("entry hash");
    return bytes;
  });
  const unsigned = {
    from_seq: 0,
    to_seq: last.seq,
    tree_size: bundle.entries.length,
    merkle_root: hexEncode(merkleRoot(leaves)),
    log_head_hash: last.entry_hash,
    ts: bundle.proof.checkpoint?.ts ?? last.ts,
    key_id: keyId,
  };
  const message = checkpointSigningMessage(unsigned);
  if (!message) throw new Error("checkpoint");
  const checkpoint = { ...unsigned, sig: b64Encode(ed.sign(message, secretKey)) };
  bundle.checkpoints = [checkpoint];
  bundle.proof = {
    format: PROOF_FORMAT,
    checkpoint,
    entry_count: bundle.entries.length,
    checkpoint_count: 1,
  };
}

function happyLog(): { secretKey: Uint8Array; bundle: InMemoryBundle } {
  const secretKey = logSecret();
  const log = writer(secretKey);
  const input = evaluation();
  log.appendRulesetActivated({
    ruleset: input.ruleset,
    ownerSignature: String(input.ownerSignature),
    ownerPublicKey: String(input.ownerPublicKey),
    agentId: AGENT,
    now: at(0),
  });
  log.appendAttempt({ evaluation: input, intentId: "intent-1", payloadHash: PAYLOAD });
  const decision = log.appendDecision({ evaluation: input, intentId: "intent-1", payloadHash: PAYLOAD });
  log.appendOutcome({
    intentId: "intent-1",
    agentId: AGENT,
    chain: "base-sepolia",
    payloadHash: PAYLOAD,
    rulesetHash: decision.ruleset_hash,
    status: "confirmed",
    txHash: "tx-1",
    now: at(2),
  });
  log.appendRejectSent({
    intentId: "intent-1",
    agentId: AGENT,
    chain: "base-sepolia",
    payloadHash: PAYLOAD,
    rulesetHash: decision.ruleset_hash,
    now: at(3),
  });
  return { secretKey, bundle: log.exportBundle(at(4)) };
}

function codes(bundle: InMemoryBundle, options?: { expectedHeadHash?: string; expectedTreeSize?: number }): string[] {
  return verifyBundle(bundle, options).errors.map((issue) => issue.code);
}

test("a full export verifies offline and an empty log verifies", () => {
  const { bundle } = happyLog();
  const report = verifyBundle(bundle);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.summary, "1 payment attempts, 1 allowed, 0 denied, 0 escalated; chain intact.");
  assert.equal(report.stats.attempts, 1);
  assert.equal(report.stats.decisions, 1);
  const empty = writer(logSecret()).exportBundle(at(0));
  const emptyReport = verifyBundle(empty);
  assert.equal(emptyReport.ok, true, JSON.stringify(emptyReport.errors));
  assert.equal(empty.proof.checkpoint, null);
});

test("deny, escalate, and an unsigned ruleset are re-derived", () => {
  const secretKey = logSecret();
  const log = writer(secretKey);
  const period = evaluation({
    intent: usdcIntent("1000000"),
    ledger: {
      spends: [
        {
          assetId: USDC,
          amountBaseUnits: "1000000",
          usdMicros: "25000000",
          at: "2026-10-10T11:00:00Z",
          state: "committed",
        },
      ],
    },
  });
  const denied = log.appendDecision({ evaluation: period, intentId: "intent-deny", payloadHash: PAYLOAD });
  assert.equal(denied.decision?.result, "deny");
  assert.equal(denied.decision?.reasons.includes(Reason.CAP_PERIOD_USD), true);

  const escalated = log.appendDecision({
    evaluation: evaluation({ now: at(1), intent: usdcIntent("4000000") }),
    intentId: "intent-escalate",
    payloadHash: PAYLOAD,
  });
  assert.equal(escalated.decision?.result, "escalate");

  const malformed = log.appendDecision({
    evaluation: evaluation({
      now: at(2),
      ruleset: { schema_version: "nope" } as never,
      ownerSignature: "aaaa",
    }),
    intentId: "intent-bad",
    payloadHash: PAYLOAD,
  });
  assert.equal(malformed.decision?.result, "deny");
  assert.equal(malformed.decision?.reasons[0], Reason.EVAL_ERROR);

  const report = verifyBundle(log.exportBundle(at(3)));
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.stats.allowed, 0);
  assert.equal(report.stats.denied, 2);
  assert.equal(report.stats.escalated, 1);
  assert.equal(report.summary, "3 payment attempts, 0 allowed, 2 denied, 1 escalated; chain intact.");
});

test("a re-signed decision lie is rejected by re-derivation", () => {
  const secretKey = logSecret();
  const log = writer(secretKey);
  const entry = log.appendDecision({
    evaluation: evaluation(),
    intentId: "intent-1",
    payloadHash: PAYLOAD,
  });
  const bundle = log.exportBundle(at(5));
  const logged = bundle.entries[0];
  assert.ok(logged && logged.decision);
  logged.decision.result = "deny";
  logged.decision.reasons = [Reason.CAP_PER_TX_USD];
  resignEntry(logged, secretKey);
  rebuildProof(bundle, secretKey, "log-1");
  const report = verifyBundle(bundle);
  assert.equal(report.ok, false);
  assert.deepEqual(report.errors.map((issue) => issue.code), ["DECISION_MISMATCH"]);
  assert.equal(entry.decision?.result, "allow");
});

test("a re-signed price snapshot lie is rejected", () => {
  const secretKey = logSecret();
  const log = writer(secretKey);
  log.appendDecision({ evaluation: evaluation(), intentId: "intent-1", payloadHash: PAYLOAD });
  const bundle = log.exportBundle(at(5));
  const logged = bundle.entries[0];
  assert.ok(logged?.decision?.price_snapshot);
  logged.decision.price_snapshot.price = "9.99";
  resignEntry(logged, secretKey);
  rebuildProof(bundle, secretKey, "log-1");
  assert.deepEqual(codes(bundle), ["DECISION_MISMATCH"]);
});

test("editing, deleting, inserting, or reordering an entry is detected", () => {
  const { bundle } = happyLog();

  const edited = clone(bundle);
  const target = edited.entries[2];
  assert.ok(target);
  target.summary.to = "0x2222222222222222222222222222222222222222";
  assert.equal(codes(edited).includes("ENTRY_HASH"), true);

  const deleted = clone(bundle);
  deleted.entries.splice(2, 1);
  assert.equal(codes(deleted).includes("ENTRY_SEQ"), true);

  const inserted = clone(bundle);
  inserted.entries.splice(2, 0, clone(inserted.entries[2]!));
  assert.equal(codes(inserted).includes("ENTRY_SEQ"), true);

  const reordered = clone(bundle);
  const left = reordered.entries[3];
  const right = reordered.entries[4];
  assert.ok(left && right);
  reordered.entries[3] = right;
  reordered.entries[4] = left;
  assert.equal(codes(reordered).includes("ENTRY_SEQ"), true);
});

test("truncation that keeps the original proof fails, and a swapped older proof needs a saved head", () => {
  const { secretKey, bundle } = happyLog();
  const originalHead = bundle.entries[bundle.entries.length - 1]?.entry_hash;
  assert.ok(originalHead);

  const casual = clone(bundle);
  casual.entries.pop();
  assert.equal(codes(casual).includes("PROOF_HEAD"), true);

  const swapped = clone(bundle);
  swapped.entries.pop();
  rebuildProof(swapped, secretKey, "log-1");
  assert.equal(verifyBundle(swapped).ok, true, JSON.stringify(verifyBundle(swapped).errors));
  assert.equal(codes(swapped, { expectedHeadHash: originalHead }).includes("PROOF_HEAD"), true);
  assert.equal(codes(swapped, { expectedTreeSize: bundle.entries.length }).includes("PROOF_HEAD"), true);
});

test("attempt and decision records of one intent must match", () => {
  const secretKey = logSecret();
  const log = writer(secretKey);
  const input = evaluation();
  log.appendAttempt({ evaluation: input, intentId: "intent-1", payloadHash: PAYLOAD });
  log.appendDecision({ evaluation: input, intentId: "intent-1", payloadHash: PAYLOAD });
  const bundle = log.exportBundle(at(2));
  const decision = bundle.entries[1];
  assert.ok(decision?.context?.evaluation?.ledger);
  const ledger = decision.context.evaluation.ledger as { spends: unknown[] };
  ledger.spends.push({
    assetId: USDC,
    amountBaseUnits: "1",
    usdMicros: "1",
    at: NOW,
    state: "released",
  });
  resignEntry(decision, secretKey);
  rebuildProof(bundle, secretKey, "log-1");
  assert.deepEqual(codes(bundle), ["ATTEMPT_MISMATCH"]);
});

test("directory export round-trips through the offline verifier", () => {
  const { bundle } = happyLog();
  const dir = mkdtempSync(join(tmpdir(), "agent-guard-"));
  try {
    writeBundle(dir, bundle);
    mkdirSync(join(dir, "anchors"));
    const report = verifyDirectory(dir);
    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.equal(report.notes.some((note) => note.includes("not checked")), true);
    writeFileSync(join(dir, "entries.jsonl"), "{not json}\n");
    const broken = verifyDirectory(dir);
    assert.equal(broken.ok, false);
    assert.equal(broken.errors[0]?.code, "BUNDLE_READ");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifier CLI exit codes", () => {
  const { bundle } = happyLog();
  const dir = mkdtempSync(join(tmpdir(), "agent-guard-cli-"));
  try {
    writeBundle(dir, bundle);
    const ok = runCli(["verify", dir]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /chain intact/);
    assert.match(ok.stdout, /"ok": true/);

    const head = bundle.entries[bundle.entries.length - 1]?.entry_hash;
    const headed = runCli(["verify", dir, "--expect-head", head ?? "", "--json"]);
    assert.equal(headed.status, 0, headed.stdout);

    const usage = runCli(["verify"]);
    assert.equal(usage.status, 2);

    const unknown = runCli(["verify", dir, "--network"]);
    assert.equal(unknown.status, 2);

    writeFileSync(join(dir, "entries.jsonl"), "{}\n");
    const failed = runCli(["verify", dir]);
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /chain check failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: root,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
