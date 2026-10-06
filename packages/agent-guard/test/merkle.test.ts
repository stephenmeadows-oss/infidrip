import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import test from "node:test";
import { merkleRoot } from "../src/merkle.js";

test("empty RFC 6962 tree is SHA-256 of an empty input", () => {
  assert.equal(bytesToHex(merkleRoot([])), bytesToHex(sha256(new Uint8Array())));
});

test("a single RFC 6962 leaf is SHA-256 of 0x00 concatenated with the leaf data", () => {
  const data = new TextEncoder().encode("leaf");
  const expected = sha256(concatBytes(Uint8Array.of(0x00), data));
  assert.equal(bytesToHex(merkleRoot([data])), bytesToHex(expected));
});

test("three RFC 6962 leaves split at the largest power of two below the count", () => {
  const leaves = ["a", "b", "c"].map((text) => new TextEncoder().encode(text));
  const hashed = leaves.map((leaf) => sha256(concatBytes(Uint8Array.of(0x00), leaf)));
  const left = sha256(concatBytes(Uint8Array.of(0x01), hashed[0]!, hashed[1]!));
  const root = sha256(concatBytes(Uint8Array.of(0x01), left, hashed[2]!));
  assert.equal(bytesToHex(merkleRoot(leaves)), bytesToHex(root));
});
