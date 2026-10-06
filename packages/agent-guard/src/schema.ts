import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { ErrorObject } from "ajv";
import { normalizeAddress } from "./address.js";
import { parseTimeMs } from "./time.js";
import type { Ruleset, SchemaIssue } from "./types.js";
import { isRecord } from "./types.js";

const schemaPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../schema/agent-guard-ruleset-v1.json",
);

export const rulesetSchema: Record<string, unknown> = JSON.parse(
  readFileSync(schemaPath, "utf8"),
) as Record<string, unknown>;

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
});
const addFormats = addFormatsImport as unknown as (instance: Ajv2020) => void;
addFormats(ajv);

const validate = ajv.compile(rulesetSchema);

export type RulesetValidation =
  | { ok: true; ruleset: Ruleset }
  | { ok: false; errors: SchemaIssue[] };

export function validateRuleset(data: unknown): RulesetValidation {
  if (!isRecord(data)) {
    return {
      ok: false,
      errors: [{ path: "/", message: "Ruleset must be a JSON object." }],
    };
  }
  const ok = validate(data);
  if (!ok) {
    return { ok: false, errors: formatErrors(validate.errors) };
  }
  return { ok: true, ruleset: data as unknown as Ruleset };
}

/**
 * Constraints that the JSON Schema expresses only partly:
 * real chain addresses, a non-empty time window, and unique ids.
 * Returns a human-readable problem, or null when the ruleset is usable.
 */
export function rulesetSemantics(ruleset: Ruleset): string | null {
  if (!Number.isSafeInteger(ruleset.version)) {
    return "Ruleset version is not a safe integer.";
  }
  if (!Number.isSafeInteger(ruleset.caps.period_seconds)) {
    return "period_seconds is not a safe integer.";
  }
  const validFrom = parseTimeMs(ruleset.valid_from);
  const expiresAt = parseTimeMs(ruleset.expires_at);
  if (validFrom === null || expiresAt === null) {
    return "Ruleset valid_from and expires_at must be RFC 3339 timestamps from 1970 through 9999.";
  }
  if (validFrom >= expiresAt) {
    return "Ruleset validity window is empty.";
  }

  const assetIds = new Set<string>();
  for (const asset of ruleset.assets) {
    if (!Number.isSafeInteger(asset.decimals)) {
      return `Asset ${asset.asset_id} has a decimals value that is not a safe integer.`;
    }
    if (assetIds.has(asset.asset_id)) {
      return `Asset ${asset.asset_id} is listed more than once.`;
    }
    assetIds.add(asset.asset_id);
  }

  const allowKeys = new Set<string>();
  for (const entry of ruleset.allowlist) {
    const normalized = normalizeAddress(entry.chain, entry.address);
    if (!normalized) {
      return `Allowlist address for ${entry.chain} is not a valid address: ${entry.address}.`;
    }
    if (entry.expires_at !== undefined && parseTimeMs(entry.expires_at) === null) {
      return `Allowlist expiry for ${entry.chain} is not a usable timestamp.`;
    }
    const key = `${entry.chain}:${normalized}`;
    if (allowKeys.has(key)) {
      return `Allowlist has more than one entry for ${entry.chain} ${normalized}.`;
    }
    allowKeys.add(key);
  }

  const pricing = ruleset.pricing;
  if (pricing) {
    for (const [name, value] of Object.entries(pricing)) {
      if (value !== undefined && !Number.isSafeInteger(value)) {
        return `pricing.${name} is not a safe integer.`;
      }
    }
  }
  if (
    ruleset.caps.max_tx_count_per_period !== undefined &&
    !Number.isSafeInteger(ruleset.caps.max_tx_count_per_period)
  ) {
    return "max_tx_count_per_period is not a safe integer.";
  }
  return null;
}

function formatErrors(errors: ErrorObject[] | null | undefined): SchemaIssue[] {
  const list = errors ?? [];
  if (list.length === 0) {
    return [{ path: "/", message: "Ruleset does not match the schema." }];
  }
  return list.slice(0, 8).map((error) => ({
    path: error.instancePath === "" ? "/" : error.instancePath,
    message: error.message ?? "is invalid",
  }));
}
