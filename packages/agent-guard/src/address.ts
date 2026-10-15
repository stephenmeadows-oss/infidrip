import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const EVM_CHAINS = new Set(["base", "base-sepolia"]);
const SOLANA_CHAINS = new Set(["solana", "solana-devnet"]);

const EVM_RE = /^0x([0-9a-fA-F]{40})$/;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export type ChainFamily = "evm" | "solana";

export function chainFamily(chain: string): ChainFamily | null {
  if (EVM_CHAINS.has(chain)) return "evm";
  if (SOLANA_CHAINS.has(chain)) return "solana";
  return null;
}

/**
 * Canonical form used for allowlist comparison.
 * EVM addresses become lowercase 0x plus 40 hex characters.
 * Mixed-case EVM input must already be valid EIP-55 or it is rejected.
 * Solana addresses must be canonical base58 of exactly 32 bytes. Case is significant.
 */
export function normalizeAddress(chain: string, address: string): string | null {
  const family = chainFamily(chain);
  if (family === "evm") return normalizeEvm(address);
  if (family === "solana") return normalizeSolana(address);
  return null;
}

export function normalizeEvm(address: string): string | null {
  if (typeof address !== "string") return null;
  const match = EVM_RE.exec(address);
  if (!match) return null;
  const hex = match[1] ?? "";
  const lower = hex.toLowerCase();
  const isAllLower = hex === lower;
  const isAllUpper = hex === hex.toUpperCase();
  if (!isAllLower && !isAllUpper && toChecksumAddress(`0x${lower}`) !== address) {
    return null;
  }
  return `0x${lower}`;
}

export function toChecksumAddress(address: string): string | null {
  const match = /^0x([0-9a-f]{40})$/.exec(address.toLowerCase());
  if (!match?.[1] || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  const lower = match[1];
  const hashHex = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = "0x";
  for (let i = 0; i < lower.length; i += 1) {
    const nibble = Number.parseInt(hashHex[i] ?? "", 16);
    const ch = lower[i] ?? "";
    out += nibble >= 8 ? ch.toUpperCase() : ch;
  }
  return out;
}

export function normalizeSolana(address: string): string | null {
  if (typeof address !== "string" || address.length < 32 || address.length > 44) return null;
  const decoded = decodeBase58(address);
  if (!decoded || decoded.length !== 32) return null;
  const canonical = encodeBase58(decoded);
  if (canonical !== address) return null;
  return canonical;
}

export function decodeBase58(input: string): Uint8Array | null {
  if (input.length === 0) return new Uint8Array();
  for (const ch of input) {
    if (!BASE58_ALPHABET.includes(ch)) return null;
  }
  if ([...input].every((ch) => ch === "1")) {
    return new Uint8Array(input.length);
  }
  let zeros = 0;
  while (zeros < input.length && input[zeros] === "1") zeros += 1;
  let value = 0n;
  for (const ch of input) {
    const digit = BASE58_ALPHABET.indexOf(ch);
    value = value * 58n + BigInt(digit);
  }
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const significant = new Uint8Array(hex.length / 2);
  for (let i = 0; i < significant.length; i += 1) {
    significant[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  const out = new Uint8Array(zeros + significant.length);
  out.set(significant, zeros);
  return out;
}

export function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    const rem = Number(value % 58n);
    encoded = `${BASE58_ALPHABET[rem] ?? ""}${encoded}`;
    value /= 58n;
  }
  return `${"1".repeat(zeros)}${encoded}`;
}
