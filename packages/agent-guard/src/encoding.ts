import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Buffer } from "node:buffer";

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function hexEncode(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

export function hexDecode(value: string): Uint8Array | null {
  const stripped = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  if (stripped.length === 0 || stripped.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(stripped)) return null;
  return hexToBytes(stripped.toLowerCase());
}

export function isHex(value: string, bytes: number): boolean {
  return new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value);
}

/** Standard base64 with padding. The round trip must be exact. */
export function b64Encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function b64Decode(value: string, length: number): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const trimmed = value.trim();
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length !== length) return null;
  if (Buffer.from(decoded).toString("base64") !== trimmed) return null;
  return new Uint8Array(decoded);
}

export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
