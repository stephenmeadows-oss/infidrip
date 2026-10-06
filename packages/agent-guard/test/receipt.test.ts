import assert from "node:assert/strict";
import * as ed from "@noble/ed25519";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Buffer } from "node:buffer";
import test from "node:test";
import { b64Decode } from "../src/encoding.js";
import {
  DEFAULT_CHECKPOINT_EVERY,
  DEFAULT_CHECKPOINT_INTERVAL_MS,
  EMPTY_PAYLOAD_HASH,
  GENESIS_PREV_HASH,
  PROOF_FORMAT,
  ReceiptError,
  computeEntryHash,
  createReceiptWriter,
  receiptSigningMessage,
} from "../src/receipt.js";
import { verifyBundle } from "../src/verify.js";
import { AGENT, NOW, evaluation, keys } from "./helpers.js";

const PAYLOAD = "ab".repeat(32);

function at(seconds: number): string {
  return new Date(Date.parse(NOW) + seconds * 1000).toISOString().replace(".000Z", "Z");
}

function logSecret(): Uint8Array {
  return ed.keygen().secretKey;
}

function writer(secretKey: Uint8Array, extra: { checkpointEvery?: number; checkpointIntervalMs?: number } = {}) {
  return createReceiptWriter({
    keyId: "log-1",
    secretKey,
    ownerPublicKey: keys.publicKeyHex,
    validFrom: "2026-10-01T00:00:00Z",
    checkpointEvery: extra.checkpointEvery ?? 1000,
    checkpointIntervalMs: extra.checkpointIntervalMs ?? 86_400_000,
  });
}

test("receipt defaults match the spec checkpoint schedule", () => {
  assert.equal(DEFAULT_CHECKPOINT_EVERY, 256);
  assert.equal(DEFAULT_CHECKPOINT_INTERVAL_MS, 600_000);
  assert.equal(GENESIS_PREV_HASH, "00".repeat(32));
  assert.equal(PROOF_FORMAT, "agent-guard/proof/1");
});

test("entries form a signed hash chain and an export checkpoints the head", () => {
  const secretKey = logSecret();
  const log = writer(secretKey);
  const input = evaluation();
  const first = log.appendRulesetActivated({
    ruleset: input.ruleset,
    ownerSignature: String(input.ownerSignature),
    ownerPublicKey: String(input.ownerPublicKey),
    agentId: AGENT,
    now: at(0),
  });
  const second = log.appendDecision({
    evaluation: input,
    intentId: "intent-1",
    payloadHash: PAYLOAD.toUpperCase(),
  });
  assert.equal(first.seq, 0);
  assert.equal(first.prev_hash, GENESIS_PREV_HASH);
  assert.equal(second.seq, 1);
  assert.equal(second.prev_hash, first.entry_hash);
  assert.equal(second.payload_hash, PAYLOAD);
  assert.equal(second.provider, "turnkey");
  assert.equal(second.decision?.result, "allow");
  const body: Record<string, unknown> = { ...second };
  delete body.entry_hash;
  delete body.sig;
  const digest = computeEntryHash(body);
  assert.ok(digest);
  assert.equal(bytesToHex(digest), second.entry_hash);
  const sig = b64Decode(second.sig, 64);
  assert.ok(sig);
  assert.equal(ed.verify(sig, receiptSigningMessage(digest), ed.getPublicKey(secretKey)), true);

  const bundle = log.exportBundle(at(30));
  assert.equal(bundle.proof.format, PROOF_FORMAT);
  assert.equal(bundle.proof.entry_count, 2);
  assert.equal(bundle.checkpoints.length, 1);
  assert.equal(bundle.proof.checkpoint?.to_seq, 1);
  assert.equal(bundle.proof.checkpoint?.tree_size, 2);
  assert.equal(bundle.proof.checkpoint?.log_head_hash, second.entry_hash);
  assert.equal(bundle.rulesets.length, 1);
  const dumped = JSON.stringify(bundle);
  assert.equal(dumped.includes(bytesToHex(secretKey)), false);
  assert.equal(dumped.includes(Buffer.from(secretKey).toString("base64")), false);
});

test("count and time policies checkpoint before export, and the defaults do not", () => {
  const byCount = writer(logSecret(), { checkpointEvery: 2, checkpointIntervalMs: 86_400_000 });
  const input = evaluation();
  byCount.appendDecision({ evaluation: input, intentId: "intent-a", payloadHash: PAYLOAD });
  byCount.appendDecision({
    evaluation: evaluation({ now: at(1) }),
    intentId: "intent-b",
    payloadHash: PAYLOAD,
  });
  const counted = byCount.exportBundle(at(50));
  assert.equal(counted.checkpoints.length, 1);
  assert.equal(counted.checkpoints[0]?.ts, at(1));

  const byTime = writer(logSecret(), { checkpointEvery: 1000, checkpointIntervalMs: 1000 });
  byTime.appendDecision({ evaluation: input, intentId: "intent-c", payloadHash: PAYLOAD });
  byTime.appendDecision({
    evaluation: evaluation({ now: at(1) }),
    intentId: "intent-d",
    payloadHash: PAYLOAD,
  });
  const timed = byTime.exportBundle(at(50));
  assert.equal(timed.checkpoints.length, 1);
  assert.equal(timed.checkpoints[0]?.ts, at(1));

  const defaults = createReceiptWriter({
    keyId: "log-1",
    secretKey: logSecret(),
    ownerPublicKey: keys.publicKeyHex,
    validFrom: "2026-10-01T00:00:00Z",
  });
  defaults.appendDecision({ evaluation: input, intentId: "intent-e", payloadHash: PAYLOAD });
  defaults.appendDecision({
    evaluation: evaluation({ now: at(1) }),
    intentId: "intent-f",
    payloadHash: PAYLOAD,
  });
  const deferred = defaults.exportBundle(at(30));
  assert.equal(deferred.checkpoints.length, 1);
  assert.equal(deferred.checkpoints[0]?.ts, at(30));
});

test("writer rejects a backwards clock, a bad hash, and an empty checkpoint", () => {
  const log = writer(logSecret());
  const input = evaluation();
  assert.throws(
    () => log.appendDecision({ evaluation: input, intentId: "intent-1", payloadHash: "zz" }),
    ReceiptError,
  );
  log.appendDecision({ evaluation: input, intentId: "intent-1", payloadHash: PAYLOAD });
  assert.throws(
    () =>
      log.appendDecision({
        evaluation: evaluation({ now: "2026-10-10T11:00:00Z" }),
        intentId: "intent-2",
        payloadHash: PAYLOAD,
      }),
    ReceiptError,
  );
  const empty = writer(logSecret());
  assert.throws(() => empty.checkpoint(at(0)), ReceiptError);
  assert.equal(EMPTY_PAYLOAD_HASH.length, 64);
});

test("key rotation closes the old log key and signs later entries with the new one", () => {
  const first = logSecret();
  const second = logSecret();
  const log = writer(first);
  const input = evaluation();
  log.appendDecision({ evaluation: input, intentId: "intent-1", payloadHash: PAYLOAD });
  const rotation = log.rotateKey({ keyId: "log-2", secretKey: second, now: at(5) });
  assert.equal(rotation.type, "KEY_ROTATION");
  assert.equal(rotation.key_id, "log-1");
  assert.equal(rotation.context?.rotation?.public_key, bytesToHex(ed.getPublicKey(second)));
  const later = log.appendDecision({
    evaluation: evaluation({ now: at(6) }),
    intentId: "intent-2",
    payloadHash: PAYLOAD,
  });
  assert.equal(later.key_id, "log-2");
  const bundle = log.exportBundle(at(7));
  const oldKey = bundle.keys.log_keys.find((item) => item.key_id === "log-1");
  const newKey = bundle.keys.log_keys.find((item) => item.key_id === "log-2");
  assert.equal(oldKey?.valid_until, at(5));
  assert.equal(newKey?.valid_from, at(5));
  assert.equal(newKey?.valid_until, null);
  assert.equal(bundle.proof.checkpoint?.key_id, "log-2");
  assert.equal(verifyBundle(bundle).ok, true, JSON.stringify(verifyBundle(bundle).errors));
});

test("gap markers and checkpoint references stay inside the chain", () => {
  const log = writer(logSecret());
  const input = evaluation();
  log.appendDecision({ evaluation: input, intentId: "intent-1", payloadHash: PAYLOAD });
  const checkpoint = log.checkpoint(at(1));
  const ref = log.appendCheckpointRef(at(2));
  const gap = log.appendGap({ agentId: AGENT, now: at(3), note: "operator marker" });
  assert.equal(ref.context?.checkpoint_ref?.merkle_root, checkpoint.merkle_root);
  assert.equal(ref.seq, 1);
  assert.equal(gap.seq, 2);
  assert.equal(gap.prev_hash, ref.entry_hash);
  const bundle = log.exportBundle(at(4));
  assert.equal(bundle.checkpoints.length, 2);
  assert.equal(bundle.checkpoints[1]?.to_seq, gap.seq);
  assert.equal(verifyBundle(bundle).ok, true, JSON.stringify(verifyBundle(bundle).errors));
});
