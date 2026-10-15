import assert from "node:assert/strict";
import test from "node:test";
import { toChecksumAddress } from "../src/address.js";
import { normalizeAddress } from "../src/address.js";
import { Check } from "../src/codes.js";
import { Reason, evaluate, type Ruleset } from "../src/index.js";
import {
  AGENT,
  ETH,
  PRICE_AT,
  RECIPIENT,
  SOL_RECIPIENT,
  SOL_USDC,
  USDC,
  evaluation,
  makeRuleset,
  quote,
  usdcIntent,
} from "./helpers.js";

function quietCaps(ruleset: Ruleset = makeRuleset()): Ruleset {
  delete ruleset.caps.escalate_above_usd;
  return ruleset;
}

test("allows a 1 USD payment and records every rule in order", () => {
  const decision = evaluate(evaluation());
  assert.equal(decision.result, "allow");
  assert.deepEqual(decision.reasons, []);
  assert.deepEqual(decision.reasonMessages, []);
  assert.equal(decision.usdValue, "1.000000");
  assert.deepEqual(
    decision.rulesChecked.map((check) => check.code),
    [
      Check.RULESET_SCHEMA,
      Check.RULESET_SIGNATURE,
      Check.RULESET_HASH,
      Check.RULESET_SEMANTICS,
      Check.RULESET_VERSION,
      Check.RULESET_WINDOW,
      Check.AGENT_STATUS,
      Check.INTENT,
      Check.AGENT_MATCH,
      Check.LEDGER,
      Check.KIND,
      Check.CHAIN,
      Check.ASSET,
      Check.DECIMALS,
      Check.ALLOWLIST,
      Check.CAP_PER_TX_BASE,
      Check.FEES,
      Check.PRICE,
      Check.CAP_PER_TX_USD,
      Check.CAP_PER_RECIPIENT_USD,
      Check.CAP_PERIOD_BASE,
      Check.CAP_PERIOD_USD,
      Check.CAP_PERIOD_COUNT,
      Check.ESCALATE,
      Check.ALLOW,
    ],
  );
  assert.ok(decision.rulesChecked.every((check) => check.passed));
});

test("the same input is deterministic and does not require the host clock", () => {
  const input = evaluation();
  assert.deepEqual(evaluate(input), evaluate(input));
  const expired = evaluate(evaluation({ now: "2026-11-06T00:00:00Z" }));
  assert.equal(expired.result, "deny");
  assert.equal(expired.reasons[0], Reason.RULESET_EXPIRED);
});

test("validity window is inclusive at the start and exclusive at the end", () => {
  const atStart = evaluate(
    evaluation({
      now: "2026-10-06T00:00:00Z",
      prices: { [USDC]: quote(USDC, "1.00", "2026-10-06T00:00:00Z") },
    }),
  );
  assert.equal(atStart.result, "allow");

  const before = evaluate(evaluation({ now: "2026-10-05T23:59:59.999Z" }));
  assert.equal(before.reasons[0], Reason.RULESET_NOT_YET_VALID);

  const lastMs = evaluate(
    evaluation({
      now: "2026-11-05T23:59:59.999Z",
      prices: { [USDC]: quote(USDC, "1.00", "2026-11-05T23:59:59.000Z") },
    }),
  );
  assert.equal(lastMs.result, "allow");

  const atEnd = evaluate(evaluation({ now: "2026-11-06T00:00:00Z" }));
  assert.equal(atEnd.reasons[0], Reason.RULESET_EXPIRED);
  assert.match(atEnd.reasonMessages[0] ?? "", /expired/);
});

test("base-unit caps are inclusive and one unit over denies", () => {
  const ruleset = quietCaps();
  const onCap = evaluate(evaluation({ ruleset, intent: usdcIntent("5000000") }));
  assert.equal(onCap.result, "allow");
  assert.equal(onCap.usdValue, "5.000000");

  const over = evaluate(evaluation({ ruleset: quietCaps(), intent: usdcIntent("5000001") }));
  assert.equal(over.result, "deny");
  assert.equal(over.reasons[0], Reason.CAP_PER_TX_BASE);
  assert.match(over.reasonMessages[0] ?? "", /5000001 > 5000000/);
});

test("USD caps use ceiling rounding, including a single wei", () => {
  const ruleset = quietCaps();
  ruleset.caps.max_per_tx_usd = "0";
  ruleset.caps.max_per_period_usd = "1";
  const dust = evaluate(
    evaluation({
      ruleset,
      intent: {
        agentId: AGENT,
        chain: "base-sepolia",
        to: RECIPIENT,
        assetId: ETH,
        amountBaseUnits: "1",
        decimals: 18,
        kind: "native_transfer",
      },
    }),
  );
  assert.equal(dust.result, "deny");
  assert.equal(dust.reasons[0], Reason.CAP_PER_TX_USD);
  assert.equal(dust.usdValue, "0.000001");

  const exact = quietCaps();
  exact.assets[0]!.max_per_tx_base_units = "1000000000000000000";
  const oneEth = evaluate(
    evaluation({
      ruleset: exact,
      intent: {
        agentId: AGENT,
        chain: "base-sepolia",
        to: RECIPIENT,
        assetId: ETH,
        amountBaseUnits: "1000000000000000",
        decimals: 18,
        kind: "native_transfer",
      },
    }),
  );
  assert.equal(oneEth.usdValue, "2.000000");
  assert.equal(oneEth.result, "allow");
});

test("an amount above the escalate threshold is not an approval", () => {
  const under = evaluate(evaluation({ intent: usdcIntent("3000000") }));
  assert.equal(under.result, "allow");
  assert.equal(under.usdValue, "3.000000");

  const over = evaluate(evaluation({ intent: usdcIntent("3000001") }));
  assert.equal(over.result, "escalate");
  assert.deepEqual(over.reasons, [Reason.ESCALATE]);
  assert.match(over.reasonMessages[0] ?? "", /will not approve/);
  assert.equal(over.rulesChecked.at(-1)?.passed, false);
});

test("empty allowlist, unknown asset, and decimals mismatch deny", () => {
  const empty = makeRuleset();
  empty.allowlist = [];
  assert.equal(evaluate(evaluation({ ruleset: empty })).reasons[0], Reason.ALLOWLIST_MISS);

  const unknown = evaluate(
    evaluation({ intent: usdcIntent("1000000", { assetId: "base-sepolia:nope" }) }),
  );
  assert.equal(unknown.reasons[0], Reason.ASSET_UNKNOWN);

  const decimals = evaluate(evaluation({ intent: usdcIntent("1000000", { decimals: 18 }) }));
  assert.equal(decimals.reasons[0], Reason.DECIMALS_MISMATCH);
  assert.match(decimals.reasonMessages[0] ?? "", /18/);
});

test("EVM addresses compare case-insensitively only with a valid checksum", () => {
  const lower = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const checksum = toChecksumAddress(lower);
  assert.ok(checksum);
  assert.notEqual(checksum, lower);
  const ruleset = quietCaps();
  ruleset.allowlist[0]!.address = checksum;

  const fromLower = evaluate(
    evaluation({ ruleset, intent: usdcIntent("1000000", { to: lower }) }),
  );
  assert.equal(fromLower.result, "allow");

  const upper = `0x${lower.slice(2).toUpperCase()}`;
  const upperRuleset = quietCaps();
  upperRuleset.allowlist[0]!.address = lower;
  const allowedUpper = evaluate(
    evaluation({ ruleset: upperRuleset, intent: usdcIntent("1000000", { to: upper }) }),
  );
  assert.equal(allowedUpper.result, "allow");

  const broken =
    checksum[2] === checksum[2]?.toLowerCase()
      ? `0x${checksum[2]?.toUpperCase()}${checksum.slice(3)}`
      : `0x${checksum[2]?.toLowerCase()}${checksum.slice(3)}`;
  const denied = evaluate(
    evaluation({ ruleset, intent: usdcIntent("1000000", { to: broken }) }),
  );
  assert.equal(denied.result, "deny");
  assert.equal(denied.reasons[0], Reason.EVAL_ERROR);
  assert.match(denied.reasonMessages[0] ?? "", /not a valid evm address/);
});

test("solana allowlist uses canonical base58 and does not fold case", () => {
  const allowed = evaluate(
    evaluation({
      intent: {
        agentId: AGENT,
        chain: "solana-devnet",
        to: SOL_RECIPIENT,
        assetId: SOL_USDC,
        amountBaseUnits: "1000000",
        decimals: 6,
        kind: "token_transfer",
      },
    }),
  );
  assert.equal(allowed.result, "allow");

  const flipped = `s${SOL_RECIPIENT.slice(1)}`;
  const denied = evaluate(
    evaluation({
      intent: {
        agentId: AGENT,
        chain: "solana-devnet",
        to: flipped,
        assetId: SOL_USDC,
        amountBaseUnits: "1000000",
        decimals: 6,
        kind: "token_transfer",
      },
    }),
  );
  assert.equal(denied.result, "deny");
  const norm = normalizeAddress("solana-devnet", flipped);
  assert.notEqual(norm, SOL_RECIPIENT);
  assert.equal(denied.reasons[0], norm === null ? Reason.EVAL_ERROR : Reason.ALLOWLIST_MISS);
});

test("allowlist expiry, asset restriction, and per-recipient caps", () => {
  const expired = evaluate(
    evaluation({
      now: "2026-10-20T00:00:00Z",
      prices: { [SOL_USDC]: quote(SOL_USDC, "1.00", "2026-10-20T00:00:00Z") },
      intent: {
        agentId: AGENT,
        chain: "solana-devnet",
        to: SOL_RECIPIENT,
        assetId: SOL_USDC,
        amountBaseUnits: "1000000",
        decimals: 6,
        kind: "token_transfer",
      },
    }),
  );
  assert.equal(expired.reasons[0], Reason.ALLOWLIST_EXPIRED);

  const stillGood = evaluate(
    evaluation({
      now: "2026-10-19T23:59:59.999Z",
      prices: { [SOL_USDC]: quote(SOL_USDC, "1.00", "2026-10-19T23:59:30Z") },
      intent: {
        agentId: AGENT,
        chain: "solana-devnet",
        to: SOL_RECIPIENT,
        assetId: SOL_USDC,
        amountBaseUnits: "1000000",
        decimals: 6,
        kind: "token_transfer",
      },
    }),
  );
  assert.equal(stillGood.result, "allow");

  const restricted = makeRuleset();
  restricted.allowlist[0]!.allowed_assets = [ETH];
  const wrongAsset = evaluate(evaluation({ ruleset: restricted }));
  assert.equal(wrongAsset.reasons[0], Reason.ALLOWLIST_ASSET);

  const capped = quietCaps();
  capped.allowlist[0]!.max_per_tx_usd = "2.00";
  const onRecipientCap = evaluate(
    evaluation({ ruleset: capped, intent: usdcIntent("2000000") }),
  );
  assert.equal(onRecipientCap.result, "allow");
  const overRuleset = quietCaps();
  overRuleset.allowlist[0]!.max_per_tx_usd = "2.00";
  const denied = evaluate(evaluation({ ruleset: overRuleset, intent: usdcIntent("2000001") }));
  assert.equal(denied.reasons[0], Reason.CAP_PER_RECIPIENT_USD);
});

test("rolling period caps count held reservations and drop the old edge", () => {
  const ruleset = quietCaps();
  ruleset.assets[1]!.max_per_period_base_units = "100";
  const prior = (at: string, amount: string, state: "held" | "committed" | "released", usd?: string) =>
    evaluation({
      ruleset,
      intent: usdcIntent(amount),
      ledger: {
        spends: [
          {
            assetId: USDC,
            amountBaseUnits: "100",
            ...(usd === undefined ? {} : { usdMicros: usd }),
            at,
            state,
          },
        ],
      },
    });

  assert.equal(
    evaluate(prior("2026-10-10T11:59:59Z", "100", "released", "0")).result,
    "allow",
  );
  assert.equal(
    evaluate(prior("2026-10-09T12:00:00Z", "100", "committed", "0")).result,
    "allow",
  );
  assert.equal(
    evaluate(prior("2026-10-09T12:00:00.001Z", "1", "held", "0")).reasons[0],
    Reason.CAP_PERIOD_BASE,
  );

  const usdRuleset = quietCaps();
  const atCap = evaluate(
    evaluation({
      ruleset: usdRuleset,
      intent: usdcIntent("5000000"),
      ledger: {
        spends: [
          {
            assetId: ETH,
            amountBaseUnits: "1",
            usdMicros: "20000000",
            at: "2026-10-10T11:00:00Z",
            state: "held",
          },
        ],
      },
    }),
  );
  assert.equal(atCap.result, "allow");

  const overUsd = quietCaps();
  const overDecision = evaluate(
    evaluation({
      ruleset: overUsd,
      intent: usdcIntent("5000000"),
      ledger: {
        spends: [
          {
            assetId: SOL_USDC,
            amountBaseUnits: "1",
            usdMicros: "20000001",
            at: "2026-10-10T11:00:00Z",
            state: "committed",
          },
        ],
      },
    }),
  );
  assert.equal(overDecision.reasons[0], Reason.CAP_PERIOD_USD);

  const unvalued = quietCaps();
  const missing = evaluate(
    evaluation({
      ruleset: unvalued,
      intent: usdcIntent("1"),
      ledger: {
        spends: [
          {
            assetId: USDC,
            amountBaseUnits: "1",
            at: "2026-10-10T11:00:00Z",
            state: "held",
          },
        ],
      },
    }),
  );
  assert.equal(missing.reasons[0], Reason.EVAL_ERROR);
  assert.match(missing.reasonMessages[0] ?? "", /usdMicros/);
});

test("period transaction count includes held rows only inside the window", () => {
  const ruleset = quietCaps();
  ruleset.caps.max_tx_count_per_period = 1;
  const spend = (at: string, state: "held" | "released") =>
    evaluate(
      evaluation({
        ruleset,
        intent: usdcIntent("1"),
        ledger: {
          spends: [{ assetId: USDC, amountBaseUnits: "1", usdMicros: "1", at, state }],
        },
      }),
    );
  assert.equal(spend("2026-10-10T11:00:00Z", "held").reasons[0], Reason.CAP_PERIOD_COUNT);
  assert.equal(spend("2026-10-10T11:00:00Z", "released").result, "allow");
  assert.equal(spend("2026-10-09T12:00:00Z", "held").result, "allow");
});

test("missing, stale, future, deviant, and depegged prices deny", () => {
  const none = evaluate(evaluation({ prices: "none" }));
  assert.equal(none.reasons[0], Reason.PRICE_UNAVAILABLE);

  const optedOut = makeRuleset();
  optedOut.assets[1]!.require_price = false;
  const still = evaluate(evaluation({ ruleset: optedOut, prices: "none" }));
  assert.equal(still.reasons[0], Reason.PRICE_UNAVAILABLE);
  assert.match(still.reasonMessages[0] ?? "", /worst-case/);

  const stale = evaluate(
    evaluation({ prices: { [USDC]: quote(USDC, "1.00", "2026-10-10T11:58:59.999Z") } }),
  );
  assert.equal(stale.reasons[0], Reason.PRICE_UNAVAILABLE);

  const freshEdge = evaluate(
    evaluation({ prices: { [USDC]: quote(USDC, "1.00", "2026-10-10T11:59:00Z") } }),
  );
  assert.equal(freshEdge.result, "allow");

  const future = evaluate(
    evaluation({ prices: { [USDC]: quote(USDC, "1.00", "2026-10-10T12:00:05.001Z") } }),
  );
  assert.equal(future.reasons[0], Reason.PRICE_UNAVAILABLE);

  const skewOk = evaluate(
    evaluation({ prices: { [USDC]: quote(USDC, "1.00", "2026-10-10T12:00:05Z") } }),
  );
  assert.equal(skewOk.result, "allow");

  const deviant = quote(USDC, "1.00");
  deviant.second = { priceUsd: "1.02", source: "other", observedAt: PRICE_AT };
  assert.equal(
    evaluate(evaluation({ prices: { [USDC]: deviant } })).reasons[0],
    Reason.PRICE_UNAVAILABLE,
  );

  const onDeviation = quote(USDC, "1.00");
  onDeviation.second = { priceUsd: "1.01", source: "other", observedAt: PRICE_AT };
  assert.equal(evaluate(evaluation({ prices: { [USDC]: onDeviation } })).result, "allow");

  const depeg = quote(USDC, "1.03");
  depeg.isStable = true;
  assert.equal(
    evaluate(evaluation({ prices: { [USDC]: depeg } })).reasons[0],
    Reason.PRICE_UNAVAILABLE,
  );
  const inside = quote(USDC, "1.02");
  inside.isStable = true;
  assert.equal(evaluate(evaluation({ prices: { [USDC]: inside } })).result, "allow");

  const zero = quote(USDC, "0");
  assert.equal(
    evaluate(evaluation({ prices: { [USDC]: zero } })).reasons[0],
    Reason.PRICE_UNAVAILABLE,
  );
});

test("fees are added to USD caps only when count_fees is set", () => {
  const ruleset = makeRuleset();
  ruleset.caps.count_fees = true;
  const missing = evaluate(evaluation({ ruleset }));
  assert.equal(missing.reasons[0], Reason.EVAL_ERROR);
  assert.match(missing.reasonMessages[0] ?? "", /no fee/);

  const fee = {
    assetId: ETH,
    amountBaseUnits: "1000000000000000",
    decimals: 18,
  };
  const over = evaluate(
    evaluation({
      ruleset,
      intent: usdcIntent("4000000", { fee }),
    }),
  );
  assert.equal(over.reasons[0], Reason.CAP_PER_TX_USD);
  assert.equal(over.usdValue, "6.000000");

  const fitted = makeRuleset();
  fitted.caps.count_fees = true;
  const ok = evaluate(evaluation({ ruleset: fitted, intent: usdcIntent("1000000", { fee }) }));
  assert.equal(ok.result, "allow");
  assert.equal(ok.usdValue, "3.000000");
});

test("signature, version, agent, kind, and chain failures deny", () => {
  assert.equal(evaluate(evaluation({ ownerSignature: "" })).reasons[0], Reason.RULESET_SIGNATURE);
  assert.equal(
    evaluate(evaluation({ bodyHash: "ab".repeat(32) })).reasons[0],
    Reason.RULESET_HASH,
  );
  assert.equal(evaluate(evaluation({ omitBodyHash: true })).result, "allow");
  assert.equal(evaluate(evaluation({ activeVersion: 3 })).reasons[0], Reason.RULESET_VERSION);
  assert.equal(evaluate(evaluation({ activeVersion: 2 })).result, "allow");
  assert.equal(evaluate(evaluation({ agentStatus: "paused" })).reasons[0], Reason.AGENT_INACTIVE);
  assert.equal(evaluate(evaluation({ agentStatus: "revoked" })).reasons[0], Reason.AGENT_INACTIVE);
  assert.equal(evaluate(evaluation({ agentStatus: undefined })).reasons[0], Reason.AGENT_INACTIVE);

  const mismatch = evaluate(
    evaluation({ intent: usdcIntent("1000000", { agentId: "other-agent" }) }),
  );
  assert.equal(mismatch.reasons[0], Reason.AGENT_MISMATCH);

  for (const kind of ["permit", "approve", "swap", "unsupported"]) {
    const decision = evaluate(evaluation({ intent: usdcIntent("1000000", { kind }) }));
    assert.equal(decision.reasons[0], Reason.UNSUPPORTED_PAYLOAD, kind);
  }

  const onlySolana = makeRuleset();
  onlySolana.chains = ["solana-devnet"];
  assert.equal(evaluate(evaluation({ ruleset: onlySolana })).reasons[0], Reason.CHAIN_NOT_ALLOWED);

  const noChains = makeRuleset();
  delete noChains.chains;
  assert.equal(evaluate(evaluation({ ruleset: noChains })).reasons[0], Reason.CHAIN_NOT_ALLOWED);

  const unknownChainInput = evaluation();
  unknownChainInput.intent = { ...usdcIntent("1000000"), chain: "ethereum" };
  const unknownChain = evaluate(unknownChainInput);
  assert.equal(unknownChain.reasons[0], Reason.CHAIN_NOT_ALLOWED);
});

test("malformed input denies and does not throw", () => {
  for (const bad of [null, undefined, 1, "x", [], () => {}]) {
    const decision = evaluate(bad);
    assert.equal(decision.result, "deny");
    assert.equal(decision.reasons[0], Reason.EVAL_ERROR);
  }
  const badAmount = evaluate(evaluation({ intent: usdcIntent("01") }));
  assert.equal(badAmount.reasons[0], Reason.EVAL_ERROR);
  const floatAmount = evaluate(evaluation({ intent: usdcIntent("1.5") }));
  assert.equal(floatAmount.reasons[0], Reason.EVAL_ERROR);
  const numericInput = evaluation();
  numericInput.intent = { ...usdcIntent(), amountBaseUnits: 1000000 };
  assert.equal(evaluate(numericInput).reasons[0], Reason.EVAL_ERROR);

  const extra = evaluate(
    evaluation({ intent: { ...usdcIntent(), note: "hidden" } as unknown as ReturnType<typeof usdcIntent> }),
  );
  assert.equal(extra.reasons[0], Reason.EVAL_ERROR);

  const badAddress = makeRuleset();
  badAddress.allowlist[0]!.address = "0".repeat(42);
  assert.equal(evaluate(evaluation({ ruleset: badAddress })).reasons[0], Reason.EVAL_ERROR);

  const duplicate = makeRuleset();
  duplicate.assets.push({ ...duplicate.assets[1]! });
  assert.match(evaluate(evaluation({ ruleset: duplicate })).reasonMessages[0] ?? "", /more than once/);

  const futureLedger = evaluate(
    evaluation({
      ledger: {
        spends: [
          {
            assetId: USDC,
            amountBaseUnits: "1",
            usdMicros: "1",
            at: "2026-10-10T12:00:00.001Z",
            state: "held",
          },
        ],
      },
    }),
  );
  assert.equal(futureLedger.reasons[0], Reason.EVAL_ERROR);
  assert.match(futureLedger.reasonMessages[0] ?? "", /after now/);
});

test("amounts above the safe integer range stay exact", () => {
  const amount = "9007199254740993";
  const ruleset = quietCaps();
  ruleset.assets[1]!.max_per_tx_base_units = amount;
  ruleset.assets[1]!.max_per_period_base_units = amount;
  ruleset.caps.max_per_tx_usd = "999999999999";
  ruleset.caps.max_per_period_usd = "999999999999";
  const prices = { [USDC]: quote(USDC, "0.000001") };
  const onCap = evaluate(evaluation({ ruleset, intent: usdcIntent(amount), prices }));
  assert.equal(onCap.result, "allow");

  const overRuleset = quietCaps();
  overRuleset.assets[1]!.max_per_tx_base_units = amount;
  overRuleset.assets[1]!.max_per_period_base_units = "9007199254740994";
  overRuleset.caps.max_per_tx_usd = "999999999999";
  overRuleset.caps.max_per_period_usd = "999999999999";
  const over = evaluate(
    evaluation({
      ruleset: overRuleset,
      intent: usdcIntent("9007199254740994"),
      prices,
    }),
  );
  assert.equal(over.reasons[0], Reason.CAP_PER_TX_BASE);
});

test("base and solana identifiers are data, with no network side effect", () => {
  const ruleset = quietCaps();
  ruleset.chains = ["base", "solana"];
  ruleset.assets = [
    { asset_id: "base:native", symbol: "ETH", decimals: 18 },
    { asset_id: "solana:native", symbol: "SOL", decimals: 9 },
  ];
  ruleset.allowlist = [
    { chain: "base", address: RECIPIENT },
    { chain: "solana", address: SOL_RECIPIENT },
  ];
  const base = evaluate(
    evaluation({
      ruleset,
      intent: {
        agentId: AGENT,
        chain: "base",
        to: RECIPIENT,
        assetId: "base:native",
        amountBaseUnits: "1000000000000000",
        decimals: 18,
        kind: "native_transfer",
      },
      prices: {
        "base:native": quote("base:native", "2000.00"),
        "solana:native": quote("solana:native", "100.00"),
      },
    }),
  );
  assert.equal(base.result, "allow");
  assert.equal(base.usdValue, "2.000000");

  const solana = evaluate(
    evaluation({
      ruleset,
      intent: {
        agentId: AGENT,
        chain: "solana",
        to: SOL_RECIPIENT,
        assetId: "solana:native",
        amountBaseUnits: "10000000",
        decimals: 9,
        kind: "native_transfer",
      },
      prices: {
        "base:native": quote("base:native", "2000.00"),
        "solana:native": quote("solana:native", "100.00"),
      },
    }),
  );
  assert.equal(solana.result, "allow");
  assert.equal(solana.usdValue, "1.000000");
});

test("a signature still verifies when object key order changes", () => {
  const ruleset = makeRuleset();
  const input = evaluation({ ruleset });
  const canonical = JSON.parse(JSON.stringify(ruleset)) as Ruleset;
  const reversed = Object.fromEntries(Object.entries(canonical).reverse());
  const decision = evaluate({ ...input, ruleset: reversed });
  assert.equal(decision.result, "allow");
});
