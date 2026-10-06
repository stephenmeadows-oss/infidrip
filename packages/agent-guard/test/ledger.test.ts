import assert from "node:assert/strict";
import * as ed from "@noble/ed25519";
import test from "node:test";
import { Reason } from "../src/codes.js";
import {
  GuardReason,
  RESERVATION_TTL_SECONDS,
  applyOutcome,
  checkPayment,
  createMemoryLedger,
  createMockPriceSource,
  createReceiptWriter,
  receiptDecisionLog,
  verifyBundle,
  type DecisionLogEntry,
  type GuardInput,
  type GuardServices,
  type MockPriceSource,
  type Ruleset,
} from "../src/index.js";
import {
  AGENT,
  ETH,
  NOW,
  PRICE_AT,
  RECIPIENT,
  SOL_RECIPIENT,
  SOL_USDC,
  USDC,
  evaluation,
  keys,
  makeRuleset,
  usdcIntent,
} from "./helpers.js";

const HASH_A = "ab".repeat(32);
const HASH_B = "cd".repeat(32);
const HASH_C = "ef".repeat(32);
const HASH_D = "12".repeat(32);
const HASH_E = "34".repeat(32);

function freshFeeds(at = PRICE_AT): MockPriceSource {
  const source = createMockPriceSource();
  const values: Record<string, string> = { "ETH/USD": "2000.00", "USDC/USD": "1.00", "SOL/USD": "150.00" };
  for (const [pair, priceUsd] of Object.entries(values)) {
    source.set(`chainlink:${pair}`, { priceUsd, observedAt: at });
    source.set(`pyth:${pair}`, { priceUsd, observedAt: at });
  }
  return source;
}

function recording(): { entries: DecisionLogEntry[]; log: GuardServices["log"] } {
  const entries: DecisionLogEntry[] = [];
  return {
    entries,
    log: {
      appendDecision(entry) {
        entries.push(entry);
      },
    },
  };
}

function quiet(ruleset: Ruleset = makeRuleset()): Ruleset {
  delete ruleset.caps.escalate_above_usd;
  return ruleset;
}

function rig(opts: { ruleset?: Ruleset; prices?: MockPriceSource; ttl?: number; dedupe?: number } = {}): GuardServices & {
  entries: DecisionLogEntry[];
  prices: MockPriceSource;
} {
  const recorded = recording();
  let n = 0;
  const prices = opts.prices ?? freshFeeds();
  return {
    ledger: createMemoryLedger(),
    prices,
    log: recorded.log,
    entries: recorded.entries,
    reservationTtlSeconds: opts.ttl,
    dedupeWindowSeconds: opts.dedupe,
    nextId: () => {
      n += 1;
      return `id-${n}`;
    },
  };
}

function pay(fingerprint: string, extra: Partial<GuardInput> = {}, ruleset?: Ruleset): GuardInput {
  const { evaluation: ev, ...rest } = extra;
  return {
    evaluation: ev ?? evaluation({ ruleset, intent: usdcIntent() }),
    fingerprint,
    payloadHash: HASH_A,
    evmChainId: 84532,
    nonce: fingerprint,
    observedDecimals: 6,
    intentId: `intent-${fingerprint}`,
    ...rest,
  };
}

function freshen(source: MockPriceSource, at: string): void {
  const values: Record<string, string> = { "ETH/USD": "2000.00", "USDC/USD": "1.00", "SOL/USD": "150.00" };
  for (const [pair, priceUsd] of Object.entries(values)) {
    source.set(`chainlink:${pair}`, { priceUsd, observedAt: at });
    source.set(`pyth:${pair}`, { priceUsd, observedAt: at });
  }
}

function later(seconds: number): string {
  return new Date(Date.parse(NOW) + seconds * 1000).toISOString().replace(".000Z", "Z");
}

test("two fresh sources allow a 1 USD payment and reserve it", async () => {
  const services = rig();
  const decision = await checkPayment(pay("fp-1"), services);
  assert.equal(decision.result, "allow");
  assert.equal(decision.mayApprove, true);
  assert.equal(decision.reservation?.usdMicros, "1000000");
  assert.equal(decision.reservation?.state, "held");
  assert.equal(decision.reservation?.periodKey, "rolling:86400");
  assert.equal(RESERVATION_TTL_SECONDS, 300);
  assert.equal(services.entries.length, 1);
  assert.equal(services.entries[0]?.kind, "evaluate");
  const quote = (services.entries[0]?.evaluation?.prices as Record<string, { source: string; second?: { source: string }; isStable?: boolean }>)[USDC];
  assert.equal(quote?.source, "chainlink:USDC/USD");
  assert.equal(quote?.second?.source, "pyth:USDC/USD");
  assert.equal(quote?.isStable, true);
});

test("stale, deviating, depegged, and one-sided prices do not reserve", async () => {
  const stale = rig({ prices: freshFeeds("2026-10-10T11:00:00Z") });
  const staleDecision = await checkPayment(pay("stale"), stale);
  assert.equal(staleDecision.result, "deny");
  assert.ok(staleDecision.reasons.includes(Reason.PRICE_UNAVAILABLE));
  assert.match(staleDecision.reasonMessages[0] ?? "", /older than 60 seconds/);
  assert.equal(stale.ledger.listReservations(AGENT).length, 0);

  const skewed = rig();
  skewed.prices.set("pyth:USDC/USD", { priceUsd: "1.02", observedAt: PRICE_AT });
  const skewedDecision = await checkPayment(pay("skew"), skewed);
  assert.ok(skewedDecision.reasons.includes(Reason.PRICE_UNAVAILABLE));
  assert.match(skewedDecision.reasonMessages[0] ?? "", /differ by more than 100 bps/);
  assert.equal(skewed.ledger.listReservations(AGENT).length, 0);

  const inside = rig();
  inside.prices.set("chainlink:USDC/USD", { priceUsd: "1.01", observedAt: PRICE_AT });
  inside.prices.set("pyth:USDC/USD", { priceUsd: "1.01", observedAt: PRICE_AT });
  assert.equal((await checkPayment(pay("band"), inside)).result, "allow");

  const depeg = rig();
  depeg.prices.set("chainlink:USDC/USD", { priceUsd: "0.97", observedAt: PRICE_AT });
  depeg.prices.set("pyth:USDC/USD", { priceUsd: "0.97", observedAt: PRICE_AT });
  const depegDecision = await checkPayment(pay("depeg"), depeg);
  assert.match(depegDecision.reasonMessages[0] ?? "", /depeg tolerance/);
  assert.equal(depeg.ledger.listReservations(AGENT).length, 0);

  const oneSided = rig();
  oneSided.prices.set("pyth:USDC/USD", null);
  const missing = await checkPayment(pay("oneside"), oneSided);
  assert.ok(missing.reasons.includes(Reason.PRICE_UNAVAILABLE));
  assert.equal(oneSided.ledger.listReservations(AGENT).length, 0);
});

test("require_price false still denies when the feed is dead", async () => {
  const ruleset = makeRuleset();
  ruleset.assets = ruleset.assets.map((asset) =>
    asset.asset_id === USDC ? { ...asset, require_price: false } : asset,
  );
  const services = rig({ ruleset });
  services.prices.kill();
  const decision = await checkPayment(pay("noprice", {}, ruleset), services);
  assert.ok(decision.reasons.includes(Reason.PRICE_UNAVAILABLE));
  assert.match(decision.reasonMessages[0] ?? "", /worst-case/);
  assert.equal(decision.mayApprove, false);
  assert.equal(services.ledger.listReservations(AGENT).length, 0);
});

test("a second asset can pass its base cap and still miss the aggregate USD cap", async () => {
  const ruleset = quiet();
  ruleset.caps.max_per_period_usd = "3.00";
  const services = rig({ ruleset });
  const eth = await checkPayment(pay("eth", {
    payloadHash: HASH_A,
    observedDecimals: 18,
    evmChainId: 84532,
    evaluation: evaluation({
      ruleset,
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
  }, ruleset), services);
  assert.equal(eth.result, "allow");
  assert.equal(eth.decision?.usdValue, "2.000000");

  const usdc = await checkPayment(pay("usdc", {
    payloadHash: HASH_B,
    nonce: "usdc",
    evaluation: evaluation({ ruleset, intent: usdcIntent("1500000") }),
  }, ruleset), services);
  assert.equal(usdc.result, "deny");
  assert.ok(usdc.reasons.includes(Reason.CAP_PERIOD_USD));
  assert.equal(usdc.reservation, null);
  assert.equal(services.ledger.listReservations(AGENT).filter((row) => row.state === "held").length, 1);
});

test("parallel payments cannot both fit a one-slot cap, and the lock is per agent", async () => {
  const ruleset = quiet();
  ruleset.caps.max_per_period_usd = "1.00";
  const services = rig({ ruleset });
  let inFlight = 0;
  let maxInFlight = 0;
  const inner = services.prices.read.bind(services.prices);
  services.prices.read = async (endpoint) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      return await inner(endpoint);
    } finally {
      inFlight -= 1;
    }
  };
  const [first, second] = await Promise.all([
    checkPayment(pay("a", { payloadHash: HASH_A, nonce: "1", evaluation: evaluation({ ruleset }) }), services),
    checkPayment(pay("b", { payloadHash: HASH_B, nonce: "2", evaluation: evaluation({ ruleset }) }), services),
  ]);
  const results = [first.result, second.result].sort();
  assert.deepEqual(results, ["allow", "deny"]);
  assert.equal(maxInFlight, 1);
  assert.equal(services.ledger.listReservations(AGENT).filter((row) => row.state === "held").length, 1);
  const denied = first.result === "deny" ? first : second;
  assert.ok(denied.reasons.includes(Reason.CAP_PERIOD_USD));

  const wide = quiet();
  wide.caps.max_per_period_usd = "5.00";
  wide.agent_id = "agent-a";
  const other = quiet();
  other.agent_id = "agent-b";
  const shared = rig({ ruleset: wide });
  let overlap = 0;
  let maxOverlap = 0;
  const read = shared.prices.read.bind(shared.prices);
  shared.prices.read = async (endpoint) => {
    overlap += 1;
    maxOverlap = Math.max(maxOverlap, overlap);
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      return await read(endpoint);
    } finally {
      overlap -= 1;
    }
  };
  const [left, right] = await Promise.all([
    checkPayment(pay("a2", {
      payloadHash: HASH_A,
      evaluation: evaluation({ ruleset: wide, intent: usdcIntent("1000000", { agentId: "agent-a" }) }),
    }), shared),
    checkPayment(pay("b2", {
      payloadHash: HASH_B,
      evaluation: evaluation({ ruleset: other, intent: usdcIntent("1000000", { agentId: "agent-b" }) }),
    }), shared),
  ]);
  assert.equal(left.result, "allow");
  assert.equal(right.result, "allow");
  assert.ok(maxOverlap >= 2);
});

test("replay and idempotency do not reserve twice", async () => {
  const services = rig();
  const first = await checkPayment(pay("fp", { idempotencyKey: "key-1" }), services);
  assert.equal(first.mayApprove, true);
  const again = await checkPayment(pay("fp", { idempotencyKey: "key-1" }), services);
  assert.equal(again.replayed, true);
  assert.equal(again.result, "allow");
  assert.equal(again.mayApprove, true);
  assert.equal(again.reservation?.reservationId, first.reservation?.reservationId);
  assert.equal(services.entries.length, 1);
  assert.equal(services.ledger.listReservations(AGENT).length, 1);

  services.ledger.markApproved(AGENT, "fp");
  const approved = await checkPayment(pay("fp", { idempotencyKey: "key-1" }), services);
  assert.equal(approved.replayed, true);
  assert.equal(approved.mayApprove, false);

  const conflict = await checkPayment(pay("fp-other", {
    idempotencyKey: "key-1",
    payloadHash: HASH_B,
    nonce: "other",
  }), services);
  assert.ok(conflict.reasons.includes(GuardReason.IDEMPOTENCY_CONFLICT));
  assert.equal(services.ledger.listReservations(AGENT).length, 1);

  const sameKey = await checkPayment(pay("fp-copy", { idempotencyKey: "key-1", nonce: "copy" }), services);
  assert.equal(sameKey.replayed, true);
  assert.equal(sameKey.reservation?.reservationId, first.reservation?.reservationId);

  const swapped = await checkPayment(pay("fp", { payloadHash: HASH_C, nonce: "fp" }), services);
  assert.ok(swapped.reasons.includes(GuardReason.REPLAY));
  assert.match(swapped.reasonMessages[0] ?? "", /different payload/);
});

test("a price deny is sticky only when an idempotency key was supplied", async () => {
  const open = rig();
  open.prices.kill();
  const denied = await checkPayment(pay("open-fp"), open);
  assert.ok(denied.reasons.includes(Reason.PRICE_UNAVAILABLE));
  open.prices = freshFeeds();
  const recovered = await checkPayment(pay("open-fp"), open);
  assert.equal(recovered.result, "allow");

  const keyed = rig();
  keyed.prices.kill();
  const stuck = await checkPayment(pay("keyed-fp", { idempotencyKey: "once" }), keyed);
  assert.ok(stuck.reasons.includes(Reason.PRICE_UNAVAILABLE));
  keyed.prices = freshFeeds();
  const still = await checkPayment(pay("keyed-fp", { idempotencyKey: "once" }), keyed);
  assert.equal(still.replayed, true);
  assert.ok(still.reasons.includes(Reason.PRICE_UNAVAILABLE));
  assert.equal(keyed.ledger.listReservations(AGENT).length, 0);
});

test("chain id, nonce, payload, and solana blockhash checks", async () => {
  const services = rig();
  const mainnetId = await checkPayment(pay("main", { payloadHash: HASH_D, evmChainId: 8453 }), services);
  assert.ok(mainnetId.reasons.includes(GuardReason.CHAIN_ID_MISMATCH));
  assert.match(mainnetId.reasonMessages[0] ?? "", /8453/);
  assert.equal(mainnetId.mayApprove, false);
  assert.equal(services.ledger.listReservations(AGENT).length, 0);

  const mainnetName = await checkPayment(pay("name", {
    payloadHash: HASH_E,
    evaluation: evaluation({ intent: usdcIntent("1000000", { chain: "base" }) }),
  }), services);
  assert.ok(mainnetName.reasons.includes(GuardReason.CHAIN_ID_MISMATCH));
  assert.match(mainnetName.reasonMessages[0] ?? "", /base/);

  const first = await checkPayment(pay("n1", { payloadHash: HASH_A, nonce: "7" }), services);
  assert.equal(first.result, "allow");
  const reusedNonce = await checkPayment(pay("n2", { payloadHash: HASH_B, nonce: "7" }), services);
  assert.ok(reusedNonce.reasons.includes(GuardReason.REPLAY));
  assert.match(reusedNonce.reasonMessages[0] ?? "", /nonce/);
  const reusedPayload = await checkPayment(pay("n3", { payloadHash: HASH_A, nonce: "8" }), services);
  assert.ok(reusedPayload.reasons.includes(GuardReason.REPLAY));
  assert.match(reusedPayload.reasonMessages[0] ?? "", /payload hash/);

  const ruleset = quiet();
  const solana = rig({ ruleset });
  const missing = await checkPayment(pay("sol-miss", {
    payloadHash: HASH_C,
    evmChainId: undefined,
    blockhash: undefined,
    evaluation: evaluation({
      ruleset,
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
  }, ruleset), solana);
  assert.ok(missing.reasons.includes(GuardReason.REPLAY));
  assert.match(missing.reasonMessages[0] ?? "", /blockhash/);

  const solPay = (fingerprint: string, payloadHash: string): GuardInput => pay(fingerprint, {
    payloadHash,
    evmChainId: undefined,
    blockhash: "recent-blockhash",
    observedDecimals: 6,
    evaluation: evaluation({
      ruleset,
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
  }, ruleset);
  const solFirst = await checkPayment(solPay("sol-1", HASH_A), solana);
  const solSecond = await checkPayment(solPay("sol-2", HASH_B), solana);
  assert.equal(solFirst.result, "allow");
  assert.equal(solSecond.result, "allow");
  assert.equal(solFirst.reservation?.blockhash, "recent-blockhash");
  const logged = solana.entries.find((entry) => entry.fingerprint === "sol-1");
  const quote = (logged?.evaluation?.prices as Record<string, { source: string }>)[SOL_USDC];
  assert.equal(quote?.source, "pyth:USDC/USD");
});

test("decimals mismatches and a failed decimals read do not reserve", async () => {
  const services = rig();
  const wrong = await checkPayment(pay("dec", { observedDecimals: 18 }), services);
  assert.ok(wrong.reasons.includes(Reason.DECIMALS_MISMATCH));
  assert.match(wrong.reasonMessages[0] ?? "", /pinned value 6/);
  assert.equal(services.ledger.listReservations(AGENT).length, 0);

  const unread = await checkPayment(pay("unread", { payloadHash: HASH_B, observedDecimals: null, nonce: "unread" }), services);
  assert.match(unread.reasonMessages[0] ?? "", /could not be read/);

  const lied = await checkPayment(pay("lied", {
    payloadHash: HASH_C,
    nonce: "lied",
    observedDecimals: 6,
    evaluation: evaluation({ intent: usdcIntent("1000000", { decimals: 8 }) }),
  }), services);
  assert.ok(lied.reasons.includes(Reason.DECIMALS_MISMATCH));
  assert.match(lied.reasonMessages[0] ?? "", /on-chain value 6/);
});

test("dedupe escalates a repeat and reservations expire, release, and commit", async () => {
  const ruleset = quiet();
  ruleset.caps.max_per_period_usd = "1.00";
  const services = rig({ ruleset, dedupe: 3600 });
  const first = await checkPayment(pay("d1", { evaluation: evaluation({ ruleset }) }), services);
  assert.equal(first.result, "allow");
  const repeat = await checkPayment(pay("d2", {
    payloadHash: HASH_B,
    nonce: "d2",
    evaluation: evaluation({ ruleset }),
  }), services);
  assert.equal(repeat.result, "escalate");
  assert.ok(repeat.reasons.includes(GuardReason.DEDUPE));
  assert.equal(repeat.reservation, null);

  const freed = rig({ ruleset });
  const held = await checkPayment(pay("rel", { evaluation: evaluation({ ruleset }) }), freed);
  assert.ok(held.reservation);
  applyOutcome(freed.ledger, held.reservation.reservationId, "failed");
  const next = await checkPayment(pay("rel-2", {
    payloadHash: HASH_B,
    nonce: "rel-2",
    evaluation: evaluation({ ruleset }),
  }), freed);
  assert.equal(next.result, "allow");

  const ttl = rig({ ruleset, ttl: 300 });
  const reserved = await checkPayment(pay("ttl", { evaluation: evaluation({ ruleset }) }), ttl);
  assert.equal(reserved.result, "allow");
  freshen(ttl.prices, later(250));
  const stillHeld = await checkPayment(pay("ttl-soon", {
    payloadHash: HASH_B,
    nonce: "soon",
    evaluation: evaluation({ ruleset, now: later(299) }),
  }), ttl);
  assert.equal(stillHeld.result, "deny");
  assert.ok(stillHeld.reasons.includes(Reason.CAP_PERIOD_USD));
  const expired = await checkPayment(pay("ttl-later", {
    payloadHash: HASH_C,
    nonce: "later",
    evaluation: evaluation({ ruleset, now: later(301) }),
  }), ttl);
  assert.equal(expired.result, "allow");

  const committed = rig({ ruleset });
  const row = await checkPayment(pay("commit", { evaluation: evaluation({ ruleset }) }), committed);
  assert.ok(row.reservation);
  applyOutcome(committed.ledger, row.reservation.reservationId, "confirmed");
  freshen(committed.prices, later(290));
  const after = await checkPayment(pay("commit-2", {
    payloadHash: HASH_B,
    nonce: "commit-2",
    evaluation: evaluation({ ruleset, now: later(301) }),
  }), committed);
  assert.equal(after.result, "deny");
  assert.ok(after.reasons.includes(Reason.CAP_PERIOD_USD));
});

test("killing the guard, the ledger, the price feed, or the log all block", async () => {
  const deadGuard = rig();
  deadGuard.available = false;
  deadGuard.ledger.kill();
  let guardLogged = false;
  deadGuard.log = {
    appendDecision() {
      guardLogged = true;
      throw new Error("log should not be called");
    },
  };
  const guard = await checkPayment(pay("guard"), deadGuard);
  assert.ok(guard.reasons.includes(GuardReason.GUARD_UNAVAILABLE));
  assert.equal(guard.mayApprove, false);
  assert.equal(guardLogged, false);

  const deadLedger = rig();
  deadLedger.ledger.kill();
  const ledger = await checkPayment(pay("ledger"), deadLedger);
  assert.ok(ledger.reasons.includes(GuardReason.LEDGER_ERROR));
  assert.equal(ledger.mayApprove, false);

  const deadFeed = rig();
  deadFeed.prices.kill();
  const feed = await checkPayment(pay("feed"), deadFeed);
  assert.ok(feed.reasons.includes(Reason.PRICE_UNAVAILABLE));
  assert.equal(deadFeed.ledger.listReservations(AGENT).length, 0);

  const deadLog = rig();
  deadLog.log = {
    appendDecision() {
      throw new Error("disk full");
    },
  };
  const logged = await checkPayment(pay("log"), deadLog);
  assert.ok(logged.reasons.includes(GuardReason.LOG_WRITE_FAILED));
  assert.equal(logged.mayApprove, false);
  assert.equal(deadLog.ledger.listReservations(AGENT).filter((row) => row.state === "held").length, 0);

  let failOnce = true;
  const retry = rig();
  retry.log = {
    appendDecision(entry) {
      if (failOnce) {
        failOnce = false;
        throw new Error("disk full");
      }
      retry.entries.push(entry);
    },
  };
  const blocked = await checkPayment(pay("retry"), retry);
  assert.ok(blocked.reasons.includes(GuardReason.LOG_WRITE_FAILED));
  const recovered = await checkPayment(pay("retry"), retry);
  assert.equal(recovered.result, "allow");
  assert.equal(recovered.mayApprove, true);
  assert.equal(retry.ledger.listReservations(AGENT).filter((row) => row.state === "held").length, 1);
});

test("an allow receipt verifies, and a decimals block does not become an allow receipt", async () => {
  const ruleset = quiet();
  ruleset.caps.max_per_period_usd = "1.00";
  const writer = createReceiptWriter({
    keyId: "log-1",
    secretKey: ed.keygen().secretKey,
    ownerPublicKey: keys.publicKeyHex,
    validFrom: "2026-10-01T00:00:00Z",
    checkpointEvery: 1000,
    checkpointIntervalMs: 86_400_000,
  });
  const services = rig({ ruleset });
  services.log = receiptDecisionLog(writer);
  const allowed = await checkPayment(pay("receipt", { evaluation: evaluation({ ruleset }) }), services);
  assert.equal(allowed.result, "allow");
  assert.equal(allowed.mayApprove, true);
  const denied = await checkPayment(pay("receipt-dec", {
    payloadHash: HASH_B,
    nonce: "dec",
    observedDecimals: 18,
    evaluation: evaluation({ ruleset }),
  }), services);
  assert.ok(denied.reasons.includes(Reason.DECIMALS_MISMATCH));

  const bundle = writer.exportBundle(NOW);
  const report = verifyBundle(bundle);
  assert.equal(report.ok, true, report.errors.map((error) => error.message).join("\n"));
  const decisions = bundle.entries.filter((entry) => entry.type === "DECISION");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.decision?.result, "allow");
  assert.ok(bundle.entries.some((entry) => entry.type === "ATTEMPT" && entry.intent_id === "intent-receipt-dec"));
});
