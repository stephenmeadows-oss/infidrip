import { chainFamily, normalizeAddress } from "./address.js";
import { Check, Reason, type ReasonCode } from "./codes.js";
import {
  microsToUsd,
  parseUint,
  usdMicrosFromBaseUnits,
  usdToMicros,
  type Decimal,
} from "./money.js";
import { assessQuote, type PricingBounds } from "./price.js";
import { rulesetSemantics, validateRuleset } from "./schema.js";
import { verifyRulesetSignature } from "./signature.js";
import { isInRollingWindow, parseTimeMs } from "./time.js";
import {
  CHAINS,
  isRecord,
  type ChainId,
  type Decision,
  type EvaluationInput,
  type FeeIntent,
  type RuleCheck,
  type Ruleset,
  type RulesetAllowlistEntry,
  type RulesetAsset,
  type SpendState,
} from "./types.js";

const INTENT_KEYS = new Set([
  "agentId",
  "chain",
  "to",
  "assetId",
  "amountBaseUnits",
  "decimals",
  "kind",
  "fee",
]);
const FEE_KEYS = new Set(["assetId", "amountBaseUnits", "decimals"]);
const LEDGER_KEYS = new Set(["spends"]);
const SPEND_KEYS = new Set(["assetId", "amountBaseUnits", "usdMicros", "at", "state"]);
const SPEND_STATES = new Set<SpendState>(["held", "committed", "released"]);
const KNOWN_CHAINS = new Set<string>(CHAINS);

interface ParsedIntent {
  agentId: string;
  chain: string;
  to: string;
  assetId: string;
  amount: bigint;
  decimals: number;
  kind: string;
  fee: FeeIntent | null;
}

interface ParsedSpend {
  assetId: string;
  amount: bigint;
  usdMicros: bigint | null;
  atMs: number;
  state: SpendState;
}

/**
 * Pure rules evaluation. Same inputs always return the same decision.
 * Malformed, unknown, expired, or ambiguous input is deny. This function does not throw
 * for bad input, and it does not read the clock or the network.
 */
export function evaluate(input: unknown): Decision {
  try {
    if (!isRecord(input)) {
      return denyOnly(Reason.EVAL_ERROR, "Evaluation input must be an object.");
    }
    return evaluateInner(input as unknown as EvaluationInput);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Evaluation failed.";
    return denyOnly(Reason.EVAL_ERROR, message);
  }
}

function evaluateInner(input: EvaluationInput): Decision {
  const checks: RuleCheck[] = [];

  const validated = validateRuleset(input.ruleset);
  if (!validated.ok) {
    const detail = validated.errors.map((issue) => `${issue.path} ${issue.message}`).join("; ");
    return deny(checks, Reason.EVAL_ERROR, `Ruleset does not match the schema: ${detail}.`);
  }
  pass(checks, Check.RULESET_SCHEMA, "Ruleset matches agent-guard/ruleset/1.");
  const ruleset = validated.ruleset;

  const signature = verifyRulesetSignature(input.ruleset, input.ownerSignature, input.ownerPublicKey);
  if (!signature.ok) {
    return deny(checks, Reason.RULESET_SIGNATURE, signature.message);
  }
  pass(checks, Check.RULESET_SIGNATURE, signature.message);

  if (input.bodyHash !== undefined) {
    if (typeof input.bodyHash !== "string" || !/^(0x)?[0-9a-fA-F]{64}$/.test(input.bodyHash.trim())) {
      return deny(checks, Reason.RULESET_HASH, "bodyHash must be 32 bytes of hex.");
    }
    const supplied = input.bodyHash.trim().replace(/^0x/i, "").toLowerCase();
    if (supplied !== signature.bodyHash) {
      return deny(checks, Reason.RULESET_HASH, "bodyHash does not match the signed ruleset.");
    }
  }
  pass(checks, Check.RULESET_HASH, `Ruleset hash is ${signature.bodyHash}.`);

  const semantic = rulesetSemantics(ruleset);
  if (semantic) {
    return deny(checks, Reason.EVAL_ERROR, semantic);
  }
  pass(checks, Check.RULESET_SEMANTICS, "Ruleset addresses, ids, and time window are usable.");

  if (input.activeVersion !== undefined && input.activeVersion !== null) {
    if (
      typeof input.activeVersion !== "number" ||
      !Number.isSafeInteger(input.activeVersion) ||
      input.activeVersion < 0
    ) {
      return deny(checks, Reason.EVAL_ERROR, "activeVersion must be a non-negative integer.");
    }
    if (ruleset.version <= input.activeVersion) {
      return deny(
        checks,
        Reason.RULESET_VERSION,
        `Ruleset version ${ruleset.version} is not higher than the active version ${input.activeVersion}.`,
      );
    }
    pass(
      checks,
      Check.RULESET_VERSION,
      `Ruleset version ${ruleset.version} is higher than the active version ${input.activeVersion}.`,
    );
  } else {
    pass(checks, Check.RULESET_VERSION, "No active ruleset version was supplied.");
  }

  if (typeof input.now !== "string") {
    return deny(checks, Reason.EVAL_ERROR, "now must be an RFC 3339 timestamp.");
  }
  const nowMs = parseTimeMs(input.now);
  if (nowMs === null) {
    return deny(checks, Reason.EVAL_ERROR, "now must be an RFC 3339 timestamp.");
  }
  const validFrom = parseTimeMs(ruleset.valid_from);
  const expiresAt = parseTimeMs(ruleset.expires_at);
  if (validFrom === null || expiresAt === null) {
    return deny(checks, Reason.EVAL_ERROR, "Ruleset timestamps are not usable.");
  }
  if (nowMs < validFrom) {
    return deny(
      checks,
      Reason.RULESET_NOT_YET_VALID,
      `Ruleset is not valid until ${ruleset.valid_from}.`,
    );
  }
  if (nowMs >= expiresAt) {
    return deny(checks, Reason.RULESET_EXPIRED, `Ruleset expired at ${ruleset.expires_at}.`);
  }
  pass(checks, Check.RULESET_WINDOW, "Ruleset is inside its validity window.");

  if (input.agentStatus !== "active") {
    if (input.agentStatus === "paused" || input.agentStatus === "revoked") {
      return deny(checks, Reason.AGENT_INACTIVE, `Agent status is ${input.agentStatus}.`);
    }
    if (input.agentStatus === undefined) {
      return deny(checks, Reason.AGENT_INACTIVE, "Agent status was not provided.");
    }
    return deny(checks, Reason.AGENT_INACTIVE, "Agent status is not active.");
  }
  pass(checks, Check.AGENT_STATUS, "Agent status is active.");

  const intentResult = parseIntent(input.intent);
  if (!intentResult.ok) {
    return deny(checks, Reason.EVAL_ERROR, intentResult.message);
  }
  pass(checks, Check.INTENT, "Payment intent is well formed.");
  const intent = intentResult.intent;

  if (intent.agentId !== ruleset.agent_id) {
    return deny(
      checks,
      Reason.AGENT_MISMATCH,
      `Payment agent ${intent.agentId} does not match ruleset agent ${ruleset.agent_id}.`,
    );
  }
  pass(checks, Check.AGENT_MATCH, "Payment agent matches the ruleset.");

  const ledgerResult = parseLedger(input.ledger, nowMs);
  if (!ledgerResult.ok) {
    return deny(checks, Reason.EVAL_ERROR, ledgerResult.message);
  }
  pass(
    checks,
    Check.LEDGER,
    ledgerResult.spends.length === 0
      ? "No prior spends were supplied."
      : `${ledgerResult.spends.length} prior spend rows were accepted.`,
  );
  const spends = ledgerResult.spends;

  const allowedKinds = ruleset.allowed_kinds ?? ["native_transfer", "token_transfer"];
  if (intent.kind !== "native_transfer" && intent.kind !== "token_transfer") {
    return deny(
      checks,
      Reason.UNSUPPORTED_PAYLOAD,
      `Payment kind ${intent.kind} is not a v1 transfer.`,
    );
  }
  if (!allowedKinds.includes(intent.kind)) {
    return deny(
      checks,
      Reason.UNSUPPORTED_PAYLOAD,
      `Payment kind ${intent.kind} is not in allowed_kinds.`,
    );
  }
  pass(checks, Check.KIND, `Payment kind ${intent.kind} is allowed.`);

  if (!KNOWN_CHAINS.has(intent.chain)) {
    return deny(checks, Reason.CHAIN_NOT_ALLOWED, `Chain ${intent.chain} is not a known Agent Guard chain.`);
  }
  const chain = intent.chain as ChainId;
  const chains = ruleset.chains ?? [];
  if (!chains.includes(chain)) {
    return deny(checks, Reason.CHAIN_NOT_ALLOWED, `Chain ${chain} is not in this ruleset.`);
  }
  pass(checks, Check.CHAIN, `Chain ${chain} is in this ruleset.`);

  const asset = ruleset.assets.find((item) => item.asset_id === intent.assetId);
  if (!asset) {
    return deny(checks, Reason.ASSET_UNKNOWN, `Asset ${intent.assetId} is not in the ruleset.`);
  }
  if (assetChain(intent.assetId) !== chain) {
    return deny(
      checks,
      Reason.ASSET_UNKNOWN,
      `Asset ${intent.assetId} does not belong to chain ${chain}.`,
    );
  }
  pass(checks, Check.ASSET, `Asset ${intent.assetId} is registered.`);

  if (intent.decimals !== asset.decimals) {
    return deny(
      checks,
      Reason.DECIMALS_MISMATCH,
      `Token decimals ${intent.decimals} do not match the pinned value ${asset.decimals}.`,
    );
  }
  pass(checks, Check.DECIMALS, `Token decimals match the pinned value ${asset.decimals}.`);

  const entryResult = matchAllowlist(ruleset, chain, intent.to, intent.assetId, nowMs);
  if (!entryResult.ok) {
    return deny(checks, entryResult.code, entryResult.message);
  }
  pass(checks, Check.ALLOWLIST, entryResult.message);
  const entry = entryResult.entry;

  if (asset.max_per_tx_base_units !== undefined) {
    const cap = mustUint(asset.max_per_tx_base_units, "max_per_tx_base_units");
    if (intent.amount > cap) {
      return deny(
        checks,
        Reason.CAP_PER_TX_BASE,
        `Per-transaction base-unit cap exceeded: ${intent.amount.toString()} > ${cap.toString()}.`,
      );
    }
    pass(
      checks,
      Check.CAP_PER_TX_BASE,
      `Per-transaction base units ${intent.amount.toString()} are within ${cap.toString()}.`,
    );
  } else {
    pass(checks, Check.CAP_PER_TX_BASE, "No per-transaction base-unit cap is set for this asset.");
  }

  const bounds = pricingBounds(ruleset);
  let feeAmount = 0n;
  let feeAsset: RulesetAsset | null = null;
  if (ruleset.caps.count_fees !== true) {
    pass(checks, Check.FEES, "Fees are not counted toward USD caps.");
  } else {
    if (!intent.fee) {
      return deny(checks, Reason.EVAL_ERROR, "count_fees is true but the intent has no fee.");
    }
    const fee = intent.fee;
    feeAsset = ruleset.assets.find((item) => item.asset_id === fee.assetId) ?? null;
    if (!feeAsset) {
      return deny(checks, Reason.ASSET_UNKNOWN, `Fee asset ${fee.assetId} is not in the ruleset.`);
    }
    if (assetChain(fee.assetId) !== chain) {
      return deny(
        checks,
        Reason.ASSET_UNKNOWN,
        `Fee asset ${fee.assetId} does not belong to chain ${chain}.`,
      );
    }
    if (fee.decimals !== feeAsset.decimals) {
      return deny(
        checks,
        Reason.DECIMALS_MISMATCH,
        `Fee decimals ${fee.decimals} do not match the pinned value ${feeAsset.decimals}.`,
      );
    }
    feeAmount = mustUint(fee.amountBaseUnits, "fee amount");
    pass(checks, Check.FEES, "Fee is present and matches its pinned asset.");
  }

  const paymentPrice = requirePrice(input.prices, asset, bounds, nowMs, checks);
  if (!paymentPrice.ok) return paymentPrice.decision;

  let feePrice: Decimal | null = null;
  if (feeAsset) {
    if (feeAsset.asset_id === asset.asset_id) {
      feePrice = paymentPrice.price;
      pass(checks, Check.FEE_PRICE, "Fee uses the same price as the payment asset.");
    } else {
      const priced = requirePrice(input.prices, feeAsset, bounds, nowMs, checks, Check.FEE_PRICE);
      if (!priced.ok) return priced.decision;
      feePrice = priced.price;
    }
  }

  const paymentUsd = usdMicrosFromBaseUnits(intent.amount, asset.decimals, paymentPrice.price);
  const feeUsd =
    feeAsset && feePrice ? usdMicrosFromBaseUnits(feeAmount, feeAsset.decimals, feePrice) : 0n;
  const totalUsd = paymentUsd + feeUsd;
  const usdValue = microsToUsd(totalUsd);

  const perTxUsd = mustUsd(ruleset.caps.max_per_tx_usd, "max_per_tx_usd");
  if (totalUsd > perTxUsd) {
    return deny(
      checks,
      Reason.CAP_PER_TX_USD,
      `Per-transaction USD cap exceeded: ${usdValue} > ${microsToUsd(perTxUsd)}.`,
      usdValue,
    );
  }
  pass(
    checks,
    Check.CAP_PER_TX_USD,
    `Per-transaction USD ${usdValue} is within ${microsToUsd(perTxUsd)}.`,
  );

  if (entry.max_per_tx_usd !== undefined) {
    const recipientCap = mustUsd(entry.max_per_tx_usd, "allowlist max_per_tx_usd");
    if (totalUsd > recipientCap) {
      return deny(
        checks,
        Reason.CAP_PER_RECIPIENT_USD,
        `Per-recipient USD cap exceeded: ${usdValue} > ${microsToUsd(recipientCap)}.`,
        usdValue,
      );
    }
    pass(
      checks,
      Check.CAP_PER_RECIPIENT_USD,
      `Per-recipient USD ${usdValue} is within ${microsToUsd(recipientCap)}.`,
    );
  } else {
    pass(checks, Check.CAP_PER_RECIPIENT_USD, "This allowlist entry has no per-address USD cap.");
  }

  const periodSeconds = ruleset.caps.period_seconds;
  const inWindow = spends.filter(
    (spend) =>
      spend.state !== "released" && isInRollingWindow(spend.atMs, nowMs, periodSeconds),
  );

  if (asset.max_per_period_base_units !== undefined) {
    const cap = mustUint(asset.max_per_period_base_units, "max_per_period_base_units");
    let used = 0n;
    for (const spend of inWindow) {
      if (spend.assetId === asset.asset_id) used += spend.amount;
    }
    const next = used + intent.amount;
    if (next > cap) {
      return deny(
        checks,
        Reason.CAP_PERIOD_BASE,
        `Per-asset period base-unit cap exceeded: ${next.toString()} > ${cap.toString()}.`,
        usdValue,
      );
    }
    pass(
      checks,
      Check.CAP_PERIOD_BASE,
      `Per-asset period base units ${next.toString()} are within ${cap.toString()}.`,
    );
  } else {
    pass(checks, Check.CAP_PERIOD_BASE, "No per-asset period base-unit cap is set for this asset.");
  }

  let usedUsd = 0n;
  for (const spend of inWindow) {
    if (spend.usdMicros === null) {
      return deny(
        checks,
        Reason.EVAL_ERROR,
        "A prior spend inside the rolling window has no usdMicros, so the period USD cap cannot be checked.",
        usdValue,
      );
    }
    usedUsd += spend.usdMicros;
  }
  const periodUsdCap = mustUsd(ruleset.caps.max_per_period_usd, "max_per_period_usd");
  const nextUsd = usedUsd + totalUsd;
  if (nextUsd > periodUsdCap) {
    return deny(
      checks,
      Reason.CAP_PERIOD_USD,
      `Period USD cap exceeded: ${microsToUsd(nextUsd)} > ${microsToUsd(periodUsdCap)}.`,
      usdValue,
    );
  }
  pass(
    checks,
    Check.CAP_PERIOD_USD,
    `Period USD ${microsToUsd(nextUsd)} is within ${microsToUsd(periodUsdCap)} over ${periodSeconds} seconds.`,
  );

  if (ruleset.caps.max_tx_count_per_period !== undefined) {
    const nextCount = inWindow.length + 1;
    if (nextCount > ruleset.caps.max_tx_count_per_period) {
      return deny(
        checks,
        Reason.CAP_PERIOD_COUNT,
        `Period transaction count exceeded: ${nextCount} > ${ruleset.caps.max_tx_count_per_period}.`,
        usdValue,
      );
    }
    pass(
      checks,
      Check.CAP_PERIOD_COUNT,
      `Period transaction count ${nextCount} is within ${ruleset.caps.max_tx_count_per_period}.`,
    );
  } else {
    pass(checks, Check.CAP_PERIOD_COUNT, "No per-period transaction count cap is set.");
  }

  if (ruleset.caps.escalate_above_usd !== undefined) {
    const threshold = mustUsd(ruleset.caps.escalate_above_usd, "escalate_above_usd");
    if (totalUsd > threshold) {
      const message = `Amount ${usdValue} is above the escalate threshold ${microsToUsd(threshold)}. The guard will not approve it.`;
      checks.push({ code: Check.ESCALATE, passed: false, message });
      return {
        result: "escalate",
        rulesChecked: checks,
        reasons: [Reason.ESCALATE],
        reasonMessages: [message],
        usdValue,
      };
    }
    pass(
      checks,
      Check.ESCALATE,
      `Amount ${usdValue} is at or under the escalate threshold ${microsToUsd(threshold)}.`,
    );
  } else {
    pass(checks, Check.ESCALATE, "No escalate band is set.");
  }

  checks.push({ code: Check.ALLOW, passed: true, message: "All checked rules passed." });
  return {
    result: "allow",
    rulesChecked: checks,
    reasons: [],
    reasonMessages: [],
    usdValue,
  };
}

function requirePrice(
  prices: unknown,
  asset: RulesetAsset,
  bounds: PricingBounds,
  nowMs: number,
  checks: RuleCheck[],
  checkCode: string = Check.PRICE,
): { ok: true; price: Decimal } | { ok: false; decision: Decision } {
  const loaded = loadRawQuote(prices, asset.asset_id);
  if (!loaded.ok) {
    const message =
      asset.require_price === false
        ? `${loaded.message} USD caps still apply, and no worst-case USD value is available in M1.`
        : loaded.message;
    return { ok: false, decision: deny(checks, loaded.code, message) };
  }
  const assessed = assessQuote(loaded.raw, asset.asset_id, bounds, nowMs);
  if (!assessed.ok) {
    return {
      ok: false,
      decision: deny(checks, Reason.PRICE_UNAVAILABLE, assessed.message),
    };
  }
  pass(checks, checkCode, `Price for ${asset.asset_id} from ${assessed.price.source} was accepted.`);
  return { ok: true, price: assessed.price.price };
}

function loadRawQuote(
  prices: unknown,
  assetId: string,
): { ok: true; raw: unknown } | { ok: false; code: ReasonCode; message: string } {
  if (prices === undefined) {
    return {
      ok: false,
      code: Reason.PRICE_UNAVAILABLE,
      message: `No USD price was provided for ${assetId}.`,
    };
  }
  if (!isRecord(prices)) {
    return {
      ok: false,
      code: Reason.EVAL_ERROR,
      message: "Prices must be an object keyed by asset id.",
    };
  }
  if (!Object.prototype.hasOwnProperty.call(prices, assetId)) {
    return {
      ok: false,
      code: Reason.PRICE_UNAVAILABLE,
      message: `No USD price was provided for ${assetId}.`,
    };
  }
  return { ok: true, raw: prices[assetId] };
}

function matchAllowlist(
  ruleset: Ruleset,
  chain: ChainId,
  to: string,
  assetId: string,
  nowMs: number,
):
  | { ok: true; entry: RulesetAllowlistEntry; message: string }
  | { ok: false; code: ReasonCode; message: string } {
  if (ruleset.allowlist.length === 0) {
    return {
      ok: false,
      code: Reason.ALLOWLIST_MISS,
      message: "Allowlist is empty, so no recipient can be paid.",
    };
  }
  const normalized = normalizeAddress(chain, to);
  if (!normalized) {
    const family = chainFamily(chain) ?? "chain";
    return {
      ok: false,
      code: Reason.EVAL_ERROR,
      message: `Recipient address is not a valid ${family} address.`,
    };
  }
  const matches = ruleset.allowlist.filter((entry) => {
    if (entry.chain !== chain) return false;
    return normalizeAddress(entry.chain, entry.address) === normalized;
  });
  if (matches.length > 1) {
    return {
      ok: false,
      code: Reason.EVAL_ERROR,
      message: `Allowlist has more than one entry for ${chain} ${normalized}.`,
    };
  }
  const entry = matches[0];
  if (!entry) {
    return {
      ok: false,
      code: Reason.ALLOWLIST_MISS,
      message: `Recipient is not on the allowlist for ${chain}.`,
    };
  }
  if (entry.expires_at !== undefined) {
    const expiry = parseTimeMs(entry.expires_at);
    if (expiry === null) {
      return {
        ok: false,
        code: Reason.EVAL_ERROR,
        message: "Allowlist expiry is not a usable timestamp.",
      };
    }
    if (nowMs >= expiry) {
      return {
        ok: false,
        code: Reason.ALLOWLIST_EXPIRED,
        message: `Allowlist entry for this recipient expired at ${entry.expires_at}.`,
      };
    }
  }
  if (entry.allowed_assets !== undefined && !entry.allowed_assets.includes(assetId)) {
    return {
      ok: false,
      code: Reason.ALLOWLIST_ASSET,
      message: `Asset ${assetId} is not allowed for this recipient.`,
    };
  }
  return {
    ok: true,
    entry,
    message: `Recipient is on the allowlist for ${chain}.`,
  };
}

function parseIntent(value: unknown): { ok: true; intent: ParsedIntent } | { ok: false; message: string } {
  if (!isRecord(value)) return { ok: false, message: "Payment intent must be an object." };
  const extra = unexpectedKey(value, INTENT_KEYS);
  if (extra) return { ok: false, message: `Payment intent has unknown field ${extra}.` };
  if (typeof value.agentId !== "string" || value.agentId.length === 0) {
    return { ok: false, message: "Payment intent agentId must be a non-empty string." };
  }
  if (typeof value.chain !== "string" || value.chain.length === 0) {
    return { ok: false, message: "Payment intent chain must be a string." };
  }
  if (typeof value.to !== "string" || value.to.length === 0) {
    return { ok: false, message: "Payment intent recipient must be a string." };
  }
  if (typeof value.assetId !== "string" || value.assetId.length === 0) {
    return { ok: false, message: "Payment intent assetId must be a non-empty string." };
  }
  if (typeof value.amountBaseUnits !== "string") {
    return { ok: false, message: "amountBaseUnits must be an integer string." };
  }
  const amount = parseUint(value.amountBaseUnits);
  if (amount === null) {
    return { ok: false, message: "amountBaseUnits must be a canonical non-negative integer string." };
  }
  if (typeof value.decimals !== "number" || !Number.isSafeInteger(value.decimals)) {
    return { ok: false, message: "Payment decimals must be an integer." };
  }
  if (value.decimals < 0 || value.decimals > 36) {
    return { ok: false, message: "Payment decimals are out of range." };
  }
  if (typeof value.kind !== "string" || value.kind.length === 0) {
    return { ok: false, message: "Payment kind must be a string." };
  }
  let fee: FeeIntent | null = null;
  if (value.fee !== undefined) {
    const parsedFee = parseFee(value.fee);
    if (!parsedFee.ok) return parsedFee;
    fee = parsedFee.fee;
  }
  const intent: ParsedIntent = {
    agentId: value.agentId,
    chain: value.chain,
    to: value.to,
    assetId: value.assetId,
    amount,
    decimals: value.decimals,
    kind: value.kind,
    fee,
  };
  return { ok: true, intent };
}

function parseFee(value: unknown): { ok: true; fee: FeeIntent } | { ok: false; message: string } {
  if (!isRecord(value)) return { ok: false, message: "Fee must be an object." };
  const extra = unexpectedKey(value, FEE_KEYS);
  if (extra) return { ok: false, message: `Fee has unknown field ${extra}.` };
  if (typeof value.assetId !== "string" || value.assetId.length === 0) {
    return { ok: false, message: "Fee assetId must be a non-empty string." };
  }
  if (typeof value.amountBaseUnits !== "string" || parseUint(value.amountBaseUnits) === null) {
    return { ok: false, message: "Fee amountBaseUnits must be a canonical non-negative integer string." };
  }
  if (typeof value.decimals !== "number" || !Number.isSafeInteger(value.decimals)) {
    return { ok: false, message: "Fee decimals must be an integer." };
  }
  if (value.decimals < 0 || value.decimals > 36) {
    return { ok: false, message: "Fee decimals are out of range." };
  }
  return {
    ok: true,
    fee: {
      assetId: value.assetId,
      amountBaseUnits: value.amountBaseUnits,
      decimals: value.decimals,
    },
  };
}

function parseLedger(
  value: unknown,
  nowMs: number,
): { ok: true; spends: ParsedSpend[] } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, spends: [] };
  if (!isRecord(value)) return { ok: false, message: "Ledger must be an object with a spends array." };
  const extra = unexpectedKey(value, LEDGER_KEYS);
  if (extra) return { ok: false, message: `Ledger has unknown field ${extra}.` };
  if (!Array.isArray(value.spends)) return { ok: false, message: "Ledger spends must be an array." };
  const spends: ParsedSpend[] = [];
  for (let i = 0; i < value.spends.length; i += 1) {
    const parsed = parseSpend(value.spends[i], i, nowMs);
    if (!parsed.ok) return parsed;
    spends.push(parsed.spend);
  }
  return { ok: true, spends };
}

function parseSpend(
  value: unknown,
  index: number,
  nowMs: number,
): { ok: true; spend: ParsedSpend } | { ok: false; message: string } {
  if (!isRecord(value)) {
    return { ok: false, message: `Ledger spend ${index} must be an object.` };
  }
  const extra = unexpectedKey(value, SPEND_KEYS);
  if (extra) return { ok: false, message: `Ledger spend ${index} has unknown field ${extra}.` };
  if (typeof value.assetId !== "string" || value.assetId.length === 0) {
    return { ok: false, message: `Ledger spend ${index} has an empty assetId.` };
  }
  if (typeof value.amountBaseUnits !== "string") {
    return { ok: false, message: `Ledger spend ${index} amount must be an integer string.` };
  }
  const amount = parseUint(value.amountBaseUnits);
  if (amount === null) {
    return { ok: false, message: `Ledger spend ${index} amount is not a canonical integer string.` };
  }
  if (typeof value.at !== "string") {
    return { ok: false, message: `Ledger spend ${index} is missing a timestamp.` };
  }
  const atMs = parseTimeMs(value.at);
  if (atMs === null) {
    return { ok: false, message: `Ledger spend ${index} timestamp is not usable.` };
  }
  if (atMs > nowMs) {
    return { ok: false, message: `Ledger spend ${index} is timestamped after now.` };
  }
  if (typeof value.state !== "string" || !SPEND_STATES.has(value.state as SpendState)) {
    return { ok: false, message: `Ledger spend ${index} has an unknown state.` };
  }
  let usdMicros: bigint | null = null;
  if (value.usdMicros !== undefined) {
    if (typeof value.usdMicros !== "string") {
      return { ok: false, message: `Ledger spend ${index} usdMicros must be an integer string.` };
    }
    usdMicros = parseUint(value.usdMicros);
    if (usdMicros === null) {
      return { ok: false, message: `Ledger spend ${index} usdMicros is not a canonical integer string.` };
    }
  }
  return {
    ok: true,
    spend: {
      assetId: value.assetId,
      amount,
      usdMicros,
      atMs,
      state: value.state as SpendState,
    },
  };
}

function pricingBounds(ruleset: Ruleset): PricingBounds {
  return {
    maxPriceAgeSeconds: ruleset.pricing?.max_price_age_seconds ?? 60,
    maxSourceDeviationBps: ruleset.pricing?.max_source_deviation_bps ?? 100,
    stableDepegToleranceBps: ruleset.pricing?.stable_depeg_tolerance_bps ?? 200,
  };
}

function assetChain(assetId: string): string | null {
  const index = assetId.indexOf(":");
  if (index <= 0) return null;
  return assetId.slice(0, index);
}

function unexpectedKey(value: Record<string, unknown>, allowed: Set<string>): string | null {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return key;
  }
  return null;
}

function mustUint(value: string, label: string): bigint {
  const parsed = parseUint(value);
  if (parsed === null) {
    throw new Error(`${label} is not a canonical integer string.`);
  }
  return parsed;
}

function mustUsd(value: string, label: string): bigint {
  const parsed = usdToMicros(value);
  if (parsed === null) {
    throw new Error(`${label} is not a USD decimal string.`);
  }
  return parsed;
}

function pass(checks: RuleCheck[], code: string, message: string): void {
  checks.push({ code, passed: true, message });
}

function deny(checks: RuleCheck[], code: ReasonCode, message: string, usdValue?: string): Decision {
  checks.push({ code, passed: false, message });
  const decision: Decision = {
    result: "deny",
    rulesChecked: checks,
    reasons: [code],
    reasonMessages: [message],
  };
  if (usdValue !== undefined) decision.usdValue = usdValue;
  return decision;
}

function denyOnly(code: ReasonCode, message: string): Decision {
  return deny([], code, message);
}
