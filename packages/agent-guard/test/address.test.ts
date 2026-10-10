import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeBase58,
  encodeBase58,
  normalizeAddress,
  normalizeEvm,
  normalizeSolana,
  toChecksumAddress,
} from "../src/address.js";

test("base58 round trips, including leading zero bytes", () => {
  assert.deepEqual(decodeBase58("z"), Uint8Array.of(57));
  assert.equal(encodeBase58(Uint8Array.of(57)), "z");
  assert.deepEqual(decodeBase58("12"), Uint8Array.of(0, 1));
  assert.equal(encodeBase58(Uint8Array.of(0, 1)), "12");
  assert.equal(encodeBase58(new Uint8Array(32)), "1".repeat(32));
  assert.equal(normalizeSolana("1".repeat(32)), "1".repeat(32));
  assert.equal(decodeBase58("0"), null);

  const bytes = new Uint8Array(32);
  bytes[0] = 0;
  bytes[31] = 7;
  const encoded = encodeBase58(bytes);
  assert.equal(decodeBase58(encoded)?.length, 32);
  assert.deepEqual(decodeBase58(encoded), bytes);
  assert.equal(normalizeSolana(encoded), encoded);
});

test("wrapped SOL is canonical and case-sensitive", () => {
  const wrapped = "So11111111111111111111111111111111111111112";
  assert.equal(normalizeSolana(wrapped), wrapped);
  const flipped = `s${wrapped.slice(1)}`;
  assert.notEqual(normalizeSolana(flipped), wrapped);
});

test("EVM addresses fold case only when the checksum is valid or the text is uniform", () => {
  const lower = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const checksum = toChecksumAddress(lower);
  assert.ok(checksum);
  assert.notEqual(checksum, lower);
  assert.equal(normalizeEvm(lower), lower);
  assert.equal(normalizeEvm(lower.toUpperCase().replace("0X", "0x")), lower);
  assert.equal(normalizeEvm(checksum), lower);

  const broken =
    checksum.slice(0, 2) +
    (checksum[2] === checksum[2]?.toLowerCase() ? checksum[2]?.toUpperCase() : checksum[2]?.toLowerCase()) +
    checksum.slice(3);
  assert.equal(normalizeEvm(broken), null);
  assert.equal(normalizeEvm("0x1234"), null);
  assert.equal(normalizeEvm("abcdefabcdefabcdefabcdefabcdefabcdefabcd"), null);
});

test("chain family picks the normalizer", () => {
  const evm = "0x1111111111111111111111111111111111111111";
  assert.equal(normalizeAddress("base", evm), evm);
  assert.equal(normalizeAddress("base-sepolia", evm), evm);
  assert.equal(normalizeAddress("solana", evm), null);
  assert.equal(normalizeAddress("ethereum", evm), null);
  assert.equal(
    normalizeAddress("solana", "So11111111111111111111111111111111111111112"),
    "So11111111111111111111111111111111111111112",
  );
});
