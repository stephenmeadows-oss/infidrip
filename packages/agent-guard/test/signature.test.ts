import assert from "node:assert/strict";
import test from "node:test";
import * as ed from "@noble/ed25519";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  canonicalJson,
  generateRulesKeypair,
  hashRuleset,
  signRuleset,
  verifyRulesetSignature,
} from "../src/index.js";
import { makeRuleset } from "./helpers.js";

test("JCS sorts keys and ignores insertion order", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(
    canonicalJson({
      peach: "This sorting order",
      péché: "is wrong according to French but canonicalization MUST",
      pêche: "ignore locale",
    }),
    '{"peach":"This sorting order","péché":"is wrong according to French but canonicalization MUST","pêche":"ignore locale"}',
  );
  const left = { z: 1, a: { d: 1, b: 2 } };
  const right = { a: { b: 2, d: 1 }, z: 1 };
  assert.equal(canonicalJson(left), canonicalJson(right));
});

test("Ed25519 matches RFC 8032 test vector 1 for an empty message", () => {
  const secret = hexToBytes("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
  const signature = ed.sign(new Uint8Array(), secret);
  assert.equal(
    Buffer.from(signature).toString("hex"),
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  );
});

test("a signature verifies across key order and fails after a tamper", () => {
  const { secretKey, publicKeyHex } = generateRulesKeypair();
  const ruleset = makeRuleset();
  const signed = signRuleset(ruleset, secretKey);
  assert.equal(signed.publicKey, publicKeyHex);
  assert.equal(signed.bodyHash, hashRuleset(ruleset));
  assert.equal(verifyRulesetSignature(ruleset, signed.signature, signed.publicKey).ok, true);

  const reordered = JSON.parse(canonicalJson(ruleset) ?? "{}") as unknown;
  assert.equal(verifyRulesetSignature(reordered, signed.signature, publicKeyHex).ok, true);

  const tampered = structuredClone(ruleset);
  tampered.version = 4;
  assert.equal(verifyRulesetSignature(tampered, signed.signature, publicKeyHex).ok, false);

  const other = generateRulesKeypair();
  assert.equal(verifyRulesetSignature(ruleset, signed.signature, other.publicKeyHex).ok, false);
  assert.equal(verifyRulesetSignature(ruleset, "", publicKeyHex).ok, false);
  assert.equal(verifyRulesetSignature(undefined, signed.signature, publicKeyHex).ok, false);
});
