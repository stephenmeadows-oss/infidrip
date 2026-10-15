import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { Check } from "../src/codes.js";
import { Reason, ceilDiv, evaluate, usdMicrosFromBaseUnits, type Decimal } from "../src/index.js";
import { USDC, evaluation, makeRuleset, quote, usdcIntent } from "./helpers.js";

test("ceiling division never understates and is the smallest such integer", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 10n ** 40n }),
      fc.bigInt({ min: 1n, max: 10n ** 24n }),
      (numerator, denominator) => {
        const quotient = ceilDiv(numerator, denominator);
        return quotient * denominator >= numerator && (quotient === 0n || (quotient - 1n) * denominator < numerator);
      },
    ),
    { numRuns: 100 },
  );
});

test("USD conversion is the ceiling of the exact rational and is monotonic", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 10n ** 24n }),
      fc.integer({ min: 0, max: 18 }),
      fc.bigInt({ min: 1n, max: 10n ** 12n }),
      (amount, decimals, priceMicros) => {
        const price: Decimal = { numerator: priceMicros, scale: 6 };
        const got = usdMicrosFromBaseUnits(amount, decimals, price);
        const next = usdMicrosFromBaseUnits(amount + 1n, decimals, price);
        const scale = 10n ** BigInt(decimals);
        const exact = amount * priceMicros;
        const expected = ceilDiv(exact, scale);
        return got === expected && next >= got;
      },
    ),
    { numRuns: 100 },
  );
});

test("a base-unit amount within the cap is allowed and one unit over is denied", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 10n ** 18n }),
      fc.bigInt({ min: 0n, max: 10n ** 18n }),
      (amount, cap) => {
        const ruleset = makeRuleset();
        delete ruleset.caps.escalate_above_usd;
        ruleset.caps.max_per_tx_usd = "999999999999";
        ruleset.caps.max_per_period_usd = "999999999999";
        const asset = ruleset.assets[1];
        assert.ok(asset);
        asset.max_per_tx_base_units = cap.toString();
        asset.max_per_period_base_units = (amount > cap ? amount : cap).toString();
        const decision = evaluate(
          evaluation({
            ruleset,
            intent: usdcIntent(amount.toString()),
            prices: { [USDC]: quote(USDC, "0.000001") },
          }),
        );
        if (amount <= cap) return decision.result === "allow";
        return decision.result === "deny" && decision.reasons[0] === Reason.CAP_PER_TX_BASE;
      },
    ),
    { numRuns: 40 },
  );
});

test("malformed rulesets deny and do not throw", () => {
  fc.assert(
    fc.property(fc.anything({ maxDepth: 3 }), (ruleset) => {
      const decision = evaluate({
        ruleset,
        ownerSignature: "not-a-signature",
        ownerPublicKey: "not-a-key",
        intent: {},
        now: "2026-10-10T12:00:00Z",
        agentStatus: "active",
      });
      return decision.result === "deny" && decision.rulesChecked.length > 0;
    }),
    { numRuns: 50 },
  );
});

test("property allows still record the base-unit check before USD", () => {
  const ruleset = makeRuleset();
  delete ruleset.caps.escalate_above_usd;
  const decision = evaluate(
    evaluation({
      ruleset,
      intent: usdcIntent("1"),
      prices: { [USDC]: quote(USDC, "0.000001") },
    }),
  );
  const codes = decision.rulesChecked.map((check) => check.code);
  assert.ok(codes.indexOf(Check.CAP_PER_TX_BASE) < codes.indexOf(Check.CAP_PER_TX_USD));
  assert.equal(decision.result, "allow");
});
