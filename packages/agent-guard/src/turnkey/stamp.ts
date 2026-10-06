import { p256 } from "@noble/curves/nist.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Buffer } from "node:buffer";
import { AdapterError } from "../providers/types.js";

export const STAMP_SCHEME = "SIGNATURE_SCHEME_TK_API_P256";

/**
 * X-Stamp value for a Turnkey POST body.
 * The signature is ECDSA P-256 over SHA-256 of the raw body, encoded as ASN.1 DER hex.
 * The header value is base64url of the JSON stamp. No request is sent.
 */
export function stampRequest(body: string, apiPublicKey: string, apiPrivateKey: string): string {
  const secret = hexToBytes(stripHex(apiPrivateKey));
  if (secret.length !== 32) throw new AdapterError("TURNKEY_API_PRIVATE_KEY must be 32 bytes of hex.");
  const signature = p256.sign(new TextEncoder().encode(body), secret, { format: "der", lowS: true });
  const stamp = {
    publicKey: stripHex(apiPublicKey).toLowerCase(),
    signature: bytesToHex(signature),
    scheme: STAMP_SCHEME,
  };
  return Buffer.from(JSON.stringify(stamp), "utf8").toString("base64url");
}

export function publicKeyFromPrivate(apiPrivateKey: string): string {
  const secret = hexToBytes(stripHex(apiPrivateKey));
  if (secret.length !== 32) throw new AdapterError("TURNKEY_API_PRIVATE_KEY must be 32 bytes of hex.");
  return bytesToHex(p256.getPublicKey(secret, true));
}

function stripHex(value: string): string {
  const trimmed = value.trim();
  const stripped = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]+$/.test(stripped)) throw new AdapterError("Turnkey API key material must be hex.");
  return stripped.toLowerCase();
}
