import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes } from "@noble/hashes/utils.js";

/**
 * RFC 6962 Merkle tree hash.
 * The empty list hashes as SHA-256 of an empty input.
 * A leaf is SHA-256(0x00 || data). A node is SHA-256(0x01 || left || right).
 * The split point is the largest power of two strictly less than the node count.
 */
export function merkleRoot(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return sha256(new Uint8Array());
  return merkleHash(leaves);
}

function merkleHash(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 1) {
    const only = leaves[0];
    if (!only) return sha256(new Uint8Array());
    return sha256(concatBytes(Uint8Array.of(0x00), only));
  }
  const k = largestPowerOfTwoLessThan(leaves.length);
  const left = merkleHash(leaves.slice(0, k));
  const right = merkleHash(leaves.slice(k));
  return sha256(concatBytes(Uint8Array.of(0x01), left, right));
}

function largestPowerOfTwoLessThan(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}
