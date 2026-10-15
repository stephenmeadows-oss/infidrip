import * as ed from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Buffer } from "node:buffer";
import { canonicalJson } from "./canonical.js";

ed.hashes.sha512 = sha512;

export interface RulesetSignature {
  /** Lowercase hex SHA-256 of the JCS ruleset body. */
  bodyHash: string;
  /** Base64 Ed25519 signature over the raw 32-byte body hash. */
  signature: string;
  /** Lowercase hex Ed25519 public key. This is the owner rules key, not a wallet key. */
  publicKey: string;
}

export interface SignatureCheck {
  ok: boolean;
  bodyHash: string;
  message: string;
}

/**
 * Sign SHA-256(JCS(ruleset body)) with Ed25519.
 * The signature stays outside the body. The signed bytes are the raw digest, not the hex text.
 */
export function signRuleset(body: unknown, secretKey: Uint8Array): RulesetSignature {
  const digest = digestRuleset(body);
  if (!digest) {
    throw new Error("Ruleset body cannot be canonicalized.");
  }
  const signature = ed.sign(digest, secretKey);
  const publicKey = ed.getPublicKey(secretKey);
  return {
    bodyHash: bytesToHex(digest),
    signature: Buffer.from(signature).toString("base64"),
    publicKey: bytesToHex(publicKey),
  };
}

export function generateRulesKeypair(): {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHex: string;
} {
  const { secretKey, publicKey } = ed.keygen();
  return { secretKey, publicKey, publicKeyHex: bytesToHex(publicKey) };
}

export function hashRuleset(body: unknown): string | null {
  const digest = digestRuleset(body);
  return digest ? bytesToHex(digest) : null;
}

export function verifyRulesetSignature(
  body: unknown,
  signature: unknown,
  publicKey: unknown,
): SignatureCheck {
  const digest = digestRuleset(body);
  if (!digest) {
    return { ok: false, bodyHash: "", message: "Ruleset body cannot be canonicalized." };
  }
  const bodyHash = bytesToHex(digest);
  const sigBytes = decodeBytes(signature, 64);
  if (!sigBytes) {
    return {
      ok: false,
      bodyHash,
      message: "Owner signature must be 64 bytes, hex or base64.",
    };
  }
  const pubBytes = decodeBytes(publicKey, 32);
  if (!pubBytes) {
    return {
      ok: false,
      bodyHash,
      message: "Owner public key must be 32 bytes, hex or base64.",
    };
  }
  try {
    const ok = ed.verify(sigBytes, digest, pubBytes);
    if (!ok) {
      return { ok: false, bodyHash, message: "Owner signature does not match the ruleset hash." };
    }
    return { ok: true, bodyHash, message: "Owner signature matches the ruleset hash." };
  } catch {
    return { ok: false, bodyHash, message: "Owner signature could not be verified." };
  }
}

function digestRuleset(body: unknown): Uint8Array | null {
  const canonical = canonicalJson(body);
  if (canonical === null) return null;
  return sha256(new TextEncoder().encode(canonical));
}

function decodeBytes(value: unknown, length: number): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value.length === length ? value : null;
  }
  if (typeof value !== "string" || value.length === 0) return null;
  const trimmed = value.trim();
  const hex = parseHex(trimmed);
  if (hex && hex.length === length) return hex;
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === length && Buffer.from(decoded).toString("base64") === trimmed) {
      return new Uint8Array(decoded);
    }
  } catch {
    return null;
  }
  return null;
}

function parseHex(value: string): Uint8Array | null {
  const stripped = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  if (stripped.length === 0 || stripped.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(stripped)) return null;
  return hexToBytes(stripped.toLowerCase());
}
