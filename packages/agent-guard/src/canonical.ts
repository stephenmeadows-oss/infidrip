import canonicalize from "canonicalize";

/**
 * RFC 8785 JSON Canonicalization Scheme.
 * Object key order does not affect the result. Undefined is not valid JSON and returns null.
 */
export function canonicalJson(value: unknown): string | null {
  try {
    const out = canonicalize(value);
    return typeof out === "string" ? out : null;
  } catch {
    return null;
  }
}
