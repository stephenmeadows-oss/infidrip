import assert from "node:assert/strict";
import test from "node:test";
import { rulesetSchema, validateRuleset } from "../src/index.js";
import { makeRuleset } from "./helpers.js";

test("the published schema id and required fields match the spec", () => {
  assert.equal(rulesetSchema.$id, "https://infidrip.dev/schemas/agent-guard/ruleset-v1.json");
  assert.equal(rulesetSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  const required = rulesetSchema.required as string[];
  for (const field of [
    "schema_version",
    "ruleset_id",
    "version",
    "agent_id",
    "valid_from",
    "expires_at",
    "default_action",
    "assets",
    "allowlist",
    "caps",
  ]) {
    assert.ok(required.includes(field), field);
  }
});

test("a usable ruleset validates", () => {
  const result = validateRuleset(makeRuleset());
  assert.equal(result.ok, true);
});

test("the spec's illustrative asset ids fail the published pattern because of underscores", () => {
  const example = {
    schema_version: "agent-guard/ruleset/1",
    ruleset_id: "01JABCDEFGHJKMNPQRSTVWXYZ0",
    version: 3,
    agent_id: "agent007-research",
    valid_from: "2026-10-06T00:00:00Z",
    expires_at: "2026-11-06T00:00:00Z",
    default_action: "deny",
    chains: ["base-sepolia", "solana-devnet"],
    assets: [
      {
        asset_id: "base-sepolia:native",
        symbol: "ETH",
        decimals: 18,
        max_per_tx_base_units: "2000000000000000",
      },
      {
        asset_id: "base-sepolia:0xUSDC_TESTNET_CONTRACT",
        symbol: "USDC",
        decimals: 6,
      },
    ],
    allowlist: [],
    caps: {
      max_per_tx_usd: "5.00",
      period_seconds: 86400,
      max_per_period_usd: "25.00",
    },
  };
  const result = validateRuleset(example);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(JSON.stringify(result.errors), /asset_id|pattern/);
  }
});

test("schema rejects extra fields, allow as default, floats, and bad ids", () => {
  const ruleset = makeRuleset() as unknown as Record<string, unknown>;
  assert.equal(validateRuleset({ ...ruleset, note: "extra" }).ok, false);

  const allowDefault = structuredClone(ruleset);
  allowDefault.default_action = "allow";
  assert.equal(validateRuleset(allowDefault).ok, false);

  const badVersion = structuredClone(ruleset);
  badVersion.version = 0;
  assert.equal(validateRuleset(badVersion).ok, false);

  const floatCap = structuredClone(ruleset) as {
    assets: Array<{ max_per_tx_base_units?: string }>;
  };
  floatCap.assets[0]!.max_per_tx_base_units = "1.5";
  assert.equal(validateRuleset(floatCap).ok, false);

  const badId = structuredClone(ruleset) as { ruleset_id: string };
  badId.ruleset_id = "01IABCDEFGHJKMNPQRSTVWXYZ0";
  assert.equal(validateRuleset(badId).ok, false);

  assert.equal(validateRuleset(null).ok, false);
  assert.equal(validateRuleset([]).ok, false);
  assert.equal(validateRuleset("ruleset").ok, false);
});
