import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { p256 } from "@noble/curves/nist.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Buffer } from "node:buffer";
import { evaluate } from "../src/evaluate.js";
import { applyGuardDecision } from "../src/providers/apply.js";
import { buildBackstopPolicies } from "../src/providers/backstop.js";
import { auditStartup, chainNamespacesIn, type PolicyView } from "../src/providers/startup.js";
import {
  AdapterError,
  BASE_SEPOLIA_CHAIN_ID,
  PROVIDER_CAPABILITY_PRESETS,
  commandForDecision,
} from "../src/providers/types.js";
import { createReceiptWriter } from "../src/receipt.js";
import { createTurnkeyAdapter } from "../src/turnkey/adapter.js";
import { hashHexPayload, normalizeActivity, normalizePolicy } from "../src/turnkey/client.js";
import { createMemoryTurnkeyClient, fixtureActivity } from "../src/turnkey/memory.js";
import { publicKeyFromPrivate, stampRequest } from "../src/turnkey/stamp.js";
import type { TurnkeyPolicy } from "../src/turnkey/client.js";
import { AGENT, NOW, evaluation, keys, makeRuleset, usdcIntent } from "./helpers.js";
import * as ed from "@noble/ed25519";

const PAYLOAD = "ab".repeat(32);
const AGENT_USER = "user-agent";
const GUARD_USER = "user-guard";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function policiesFromFile(): TurnkeyPolicy[] {
  const parsed = JSON.parse(readFileSync(join(root, "test", "fixtures", "turnkey-policies.json"), "utf8")) as unknown[];
  return parsed.map((item) => {
    const policy = normalizePolicy(item);
    if (!policy) throw new Error("fixture policy");
    return policy;
  });
}

function wallets() {
  return [
    { walletId: "wallet-base", chain: "base-sepolia" as const },
    { walletId: "wallet-sol", chain: "solana-devnet" as const },
  ];
}

function adapterFor(
  policies: TurnkeyPolicy[],
  extra?: { canaryStatus?: string | null; canaryVotes?: { userId: string; selection: string }[] },
) {
  const activity = fixtureActivity();
  const client = createMemoryTurnkeyClient({
    organizationId: "org-test",
    agentUserId: AGENT_USER,
    approverUserId: GUARD_USER,
    policies,
    activities: [activity],
    canaryStatus: extra?.canaryStatus,
    canaryVotes: extra?.canaryVotes,
  });
  const adapter = createTurnkeyAdapter(client, {
    organizationId: "org-test",
    agentUserId: AGENT_USER,
    approverUserId: GUARD_USER,
    wallets: wallets(),
  });
  return { client, adapter, activity };
}

function logWriter() {
  return createReceiptWriter({
    keyId: "log-1",
    secretKey: ed.keygen().secretKey,
    ownerPublicKey: keys.publicKeyHex,
    validFrom: "2026-10-01T00:00:00Z",
    checkpointEvery: 1000,
    checkpointIntervalMs: 86_400_000,
  });
}

test("provider presets keep co-approval and on-chain enforcement distinct", () => {
  assert.equal(PROVIDER_CAPABILITY_PRESETS.turnkey.coApprove, true);
  assert.equal(PROVIDER_CAPABILITY_PRESETS.privy.coApprove, true);
  assert.equal(PROVIDER_CAPABILITY_PRESETS["coinbase-cdp"].coApprove, false);
  assert.equal(PROVIDER_CAPABILITY_PRESETS.safe.onchainEnforced, true);
  assert.equal(PROVIDER_CAPABILITY_PRESETS.crossmint.coApprove, false);
  assert.deepEqual(commandForDecision("allow"), "approve");
  assert.deepEqual(commandForDecision("deny"), "reject");
  assert.deepEqual(commandForDecision("escalate"), "hold");
  assert.equal(BASE_SEPOLIA_CHAIN_ID, 84532);
});

test("a safe policy fixture passes startup and maps decisions", async () => {
  const { client, adapter, activity } = adapterFor(policiesFromFile());
  const report = await adapter.startupCheck();
  assert.equal(report.ok, true, JSON.stringify(report.reasons));
  assert.equal(report.canaryStatus, "ACTIVITY_STATUS_CONSENSUS_NEEDED");
  assert.equal(report.canaryVerdict, "consensus_needed");
  const health = await adapter.healthcheck();
  assert.equal(health.ok, true, health.message);
  assert.equal(health.userId, GUARD_USER);

  const loaded = JSON.parse(readFileSync(join(root, "test", "fixtures", "turnkey-activity.json"), "utf8")) as unknown;
  const parsed = normalizeActivity(loaded);
  assert.equal(parsed?.status, "ACTIVITY_STATUS_CONSENSUS_NEEDED");
  assert.equal(parsed?.payloadHash, hashHexPayload("deadbeef"));
  assert.deepEqual(parsed?.votes, [
    { userId: "user-agent", selection: "VOTE_SELECTION_APPROVED" },
    { userId: "user-guard", selection: "VOTE_SELECTION_APPROVED" },
  ]);
  const nested = normalizeActivity({
    id: "nested-vote",
    status: "ACTIVITY_STATUS_COMPLETED",
    votes: [{ selection: "VOTE_SELECTION_APPROVED", user: { userId: " user-guard " } }, { selection: "" }],
  });
  assert.deepEqual(nested?.votes, [{ userId: "user-guard", selection: "VOTE_SELECTION_APPROVED" }]);

  const pending = await adapter.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.payloadHash, activity.payloadHash);

  const input = evaluation();
  const decision = evaluate(input);
  assert.equal(decision.result, "allow");
  const writer = logWriter();
  writer.appendDecision({
    evaluation: input,
    intentId: "intent-1",
    payloadHash: PAYLOAD,
  });
  const allowed = await applyGuardDecision(adapter, {
    decision,
    ref: { activity_id: activity.id, fingerprint: activity.fingerprint },
    decisionId: "decision-1",
    intentId: "intent-1",
    agentId: AGENT,
    chain: "base-sepolia",
    payloadHash: PAYLOAD,
    rulesetHash: writer.exportBundle(NOW).entries[0]?.ruleset_hash ?? PAYLOAD,
    now: NOW,
    decisionLogged: true,
  }, writer);
  assert.equal(allowed.command, "approve");
  assert.equal(allowed.sent, true);
  assert.equal((await adapter.getOutcome({ activity_id: activity.id, fingerprint: activity.fingerprint })).status, "signed");
  const approved = writer.exportBundle(NOW).entries.find((entry) => entry.type === "APPROVE_SENT");
  assert.ok(approved);
  assert.equal(approved.provider, "turnkey");
  assert.equal(approved.provider_ref.fingerprint, activity.fingerprint);
  assert.equal(client.calls.includes(`approve:${activity.fingerprint}`), true);

  await assert.rejects(
    () => adapter.approve({ activity_id: activity.id, fingerprint: activity.fingerprint }, "decision-2"),
    /already approved/,
  );
});

test("deny rejects, escalate holds, and an unlogged allow is refused", async () => {
  const policies = policiesFromFile();
  const deniedClient = adapterFor(policies);
  const deniedDecision = evaluate(evaluation({ prices: "none" }));
  assert.equal(deniedDecision.result, "deny");
  const writer = logWriter();
  const denied = await applyGuardDecision(deniedClient.adapter, {
    decision: deniedDecision,
    ref: { activity_id: deniedClient.activity.id, fingerprint: deniedClient.activity.fingerprint },
    decisionId: "decision-deny",
    intentId: "intent-deny",
    agentId: AGENT,
    chain: "base-sepolia",
    payloadHash: PAYLOAD,
    rulesetHash: PAYLOAD,
    now: NOW,
    decisionLogged: true,
  }, writer);
  assert.equal(denied.command, "reject");
  assert.equal(deniedClient.client.calls.some((call) => call.startsWith("reject:")), true);
  assert.equal(writer.exportBundle(NOW).entries.some((entry) => entry.type === "REJECT_SENT"), true);
  assert.equal(
    (await deniedClient.adapter.getOutcome({
      activity_id: deniedClient.activity.id,
      fingerprint: deniedClient.activity.fingerprint,
    })).status,
    "rejected",
  );

  const held = adapterFor(policies);
  const escalated = evaluate(evaluation({ intent: usdcIntent("4000000") }));
  assert.equal(escalated.result, "escalate");
  const hold = await applyGuardDecision(held.adapter, {
    decision: escalated,
    ref: { activity_id: held.activity.id, fingerprint: held.activity.fingerprint },
    decisionId: "decision-hold",
    intentId: "intent-hold",
    agentId: AGENT,
    chain: "base-sepolia",
    payloadHash: PAYLOAD,
    rulesetHash: PAYLOAD,
    now: NOW,
    decisionLogged: true,
  });
  assert.equal(hold.command, "hold");
  assert.equal(hold.sent, false);
  assert.equal(held.client.calls.some((call) => call.startsWith("approve:") || call.startsWith("reject:")), false);

  const blocked = adapterFor(policies);
  const allow = evaluate(evaluation());
  await assert.rejects(
    () =>
      applyGuardDecision(blocked.adapter, {
        decision: allow,
        ref: { activity_id: blocked.activity.id, fingerprint: blocked.activity.fingerprint },
        decisionId: "decision-3",
        intentId: "intent-3",
        agentId: AGENT,
        chain: "base-sepolia",
        payloadHash: PAYLOAD,
        rulesetHash: PAYLOAD,
        now: NOW,
        decisionLogged: false,
      }),
    /decision receipt/,
  );
  assert.equal(blocked.client.calls.some((call) => call.startsWith("approve:")), false);
});

test("startup refuses an agent who can sign alone", async () => {
  const policies = policiesFromFile().map((policy) =>
    policy.policyName === "agent-guard consensus"
      ? {
          ...policy,
          consensus: "approvers.any(user, user.id == 'user-agent')",
        }
      : policy,
  );
  const { adapter, client, activity } = adapterFor(policies);
  const report = await adapter.startupCheck();
  assert.equal(report.ok, false);
  assert.equal(report.canaryStatus, "ACTIVITY_STATUS_COMPLETED");
  assert.equal(report.canaryVerdict, "agent_signed_alone");
  assert.equal(report.reasons.some((reason) => reason.code === "AGENT_CAN_SIGN_ALONE"), true);
  const signed = report.reasons.find((reason) => reason.code === "CANARY_SIGNED");
  assert.ok(signed);
  assert.match(signed.message, /without an approval vote from the guard approver/);
  await assert.rejects(
    () => adapter.approve({ activity_id: activity.id, fingerprint: activity.fingerprint }, "decision-x"),
    /Startup check has not passed/,
  );
  assert.equal(client.calls.some((call) => call.startsWith("approve:")), false);

  const broad = auditStartup({
    agentUserId: AGENT_USER,
    approverUserId: GUARD_USER,
    policies: [
      ...policiesFromFile().filter((policy) => policy.effect === "EFFECT_DENY"),
      {
        policyName: "broad",
        effect: "EFFECT_ALLOW",
        consensus: "approvers.count() >= 1",
        condition: "activity.action == 'SIGN'",
      },
    ],
    chains: ["base-sepolia", "solana-devnet"],
    canaryStatus: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
  });
  assert.equal(broad.reasons.some((reason) => reason.code === "AGENT_CAN_SIGN_ALONE"), true);

  const approverSigns = auditStartup({
    agentUserId: AGENT_USER,
    approverUserId: GUARD_USER,
    policies: [
      ...policiesFromFile(),
      {
        policyName: "approver signs",
        effect: "EFFECT_ALLOW",
        consensus: "approvers.any(user, user.id == 'user-guard')",
        condition: "activity.action == 'SIGN'",
      },
    ],
    chains: ["base-sepolia", "solana-devnet"],
    canaryStatus: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
  });
  assert.equal(approverSigns.reasons.some((reason) => reason.code === "APPROVER_CAN_SIGN_ALONE"), true);
});

test("a completed canary passes only when the approver also approved", async () => {
  const both = [
    { userId: AGENT_USER, selection: "VOTE_SELECTION_APPROVED" },
    { userId: GUARD_USER, selection: "VOTE_SELECTION_APPROVED" },
  ];
  const joint = adapterFor(policiesFromFile(), {
    canaryStatus: "ACTIVITY_STATUS_COMPLETED",
    canaryVotes: both,
  });
  const passed = await joint.adapter.startupCheck();
  assert.equal(passed.ok, true, JSON.stringify(passed.reasons));
  assert.equal(passed.canaryStatus, "ACTIVITY_STATUS_COMPLETED");
  assert.equal(passed.canaryVerdict, "jointly_approved");

  const base = {
    agentUserId: AGENT_USER,
    approverUserId: GUARD_USER,
    policies: policiesFromFile(),
    chains: ["base-sepolia", "solana-devnet"],
    canaryStatus: "ACTIVITY_STATUS_COMPLETED",
  };
  const alone = auditStartup({
    ...base,
    canaryVotes: [{ userId: AGENT_USER, selection: "VOTE_SELECTION_APPROVED" }],
  });
  assert.equal(alone.ok, false);
  assert.equal(alone.canaryVerdict, "agent_signed_alone");
  assert.match(
    alone.reasons.find((reason) => reason.code === "CANARY_SIGNED")?.message ?? "",
    /without an approval vote from the guard approver/,
  );

  const approverOnly = auditStartup({
    ...base,
    canaryVotes: [{ userId: GUARD_USER, selection: "VOTE_SELECTION_APPROVED" }],
  });
  assert.equal(approverOnly.canaryVerdict, "not_consensus");
  assert.equal(approverOnly.reasons.some((reason) => reason.code === "CANARY_SIGNED"), false);
  assert.match(
    approverOnly.reasons.find((reason) => reason.code === "CANARY_NOT_CONSENSUS")?.message ?? "",
    /no approval vote from the agent/,
  );

  const rejected = auditStartup({
    ...base,
    canaryVotes: [
      { userId: AGENT_USER, selection: "VOTE_SELECTION_APPROVED" },
      { userId: GUARD_USER, selection: "VOTE_SELECTION_REJECTED" },
    ],
  });
  assert.equal(rejected.canaryVerdict, "agent_signed_alone");

  const failed = auditStartup({
    ...base,
    canaryStatus: "ACTIVITY_STATUS_FAILED",
    canaryVotes: both,
  });
  assert.equal(failed.canaryVerdict, "not_consensus");
  assert.equal(failed.reasons.some((reason) => reason.code === "CANARY_NOT_CONSENSUS"), true);
  assert.equal(failed.reasons.some((reason) => reason.code === "CANARY_SIGNED"), false);
});

test("healthcheck refuses the agent API key", async () => {
  const { client } = adapterFor(policiesFromFile());
  const agentAdapter = createTurnkeyAdapter(
    {
      ...client,
      async whoami() {
        return { organizationId: "org-test", userId: AGENT_USER, username: "agent" };
      },
    },
    {
      organizationId: "org-test",
      agentUserId: AGENT_USER,
      approverUserId: GUARD_USER,
      wallets: wallets(),
    },
  );
  const health = await agentAdapter.healthcheck();
  assert.equal(health.ok, false);
  assert.equal(health.userId, AGENT_USER);
  assert.match(health.message, /agent user/);
  assert.match(health.message, /approver user's API key/);
});

test("startup requires export and user or policy change denials", () => {
  const policies = policiesFromFile().filter(
    (policy) => policy.policyName !== "agent-guard export" && policy.policyName !== "agent-guard governance",
  );
  const report = auditStartup({
    agentUserId: AGENT_USER,
    approverUserId: GUARD_USER,
    policies,
    chains: ["base-sepolia", "solana-devnet"],
    canaryStatus: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
  });
  const missing = report.reasons.find((reason) => reason.code === "BACKSTOP_MISSING");
  assert.ok(missing);
  assert.match(missing.message, /private key or wallet export/);
  assert.match(missing.message, /policy changes/);
  assert.match(missing.message, /user or credential changes/);
});

function auditFixture(policies: PolicyView[]) {
  return auditStartup({
    agentUserId: AGENT_USER,
    approverUserId: GUARD_USER,
    policies,
    chains: ["base-sepolia", "solana-devnet"],
    canaryStatus: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
  });
}

test("a condition that mixes chain namespaces always errors and is not a backstop", () => {
  const mixed = policiesFromFile().map((policy) =>
    policy.policyName === "agent-guard allowlist"
      ? {
          ...policy,
          condition:
            "eth.tx.to != '0x1111111111111111111111111111111111111111' || solana.tx.transfers.any(transfer, transfer.to != 'So11111111111111111111111111111111111111112')",
        }
      : policy,
  );
  const report = auditFixture(mixed);
  const always = report.reasons.find((reason) => reason.code === "POLICY_ALWAYS_ERRORS");
  assert.ok(always);
  assert.match(always.message, /eth\.tx/);
  assert.match(always.message, /solana\.tx/);
  assert.match(always.message, /does not short circuit/);
  assert.match(always.message, /not counted as a backstop/);
  const missing = report.reasons.find((reason) => reason.code === "BACKSTOP_MISSING");
  assert.ok(missing);
  assert.match(missing.message, /recipient allowlist/);
  assert.equal(report.ok, false);

  const similar = auditFixture([
    ...policiesFromFile().filter((policy) => policy.policyName !== "agent-guard allowlist"),
    {
      policyName: "agent-guard allowlist",
      effect: "EFFECT_DENY",
      consensus: "approvers.any(user, user.id == 'user-agent')",
      condition: "eth.tx.to != '0xabc' || bitcoin.tx.outputs.count() > 0",
    },
  ]);
  assert.equal(similar.reasons.some((reason) => reason.code === "POLICY_ALWAYS_ERRORS"), true);
  assert.match(
    similar.reasons.find((reason) => reason.code === "BACKSTOP_MISSING")?.message ?? "",
    /recipient allowlist/,
  );

  const typedData = auditFixture([
    ...policiesFromFile(),
    {
      policyName: "mixed typed data",
      effect: "EFFECT_DENY",
      consensus: "true",
      condition: "eth.tx.to != '' || eth.eip_712.primary_type == 'Permit'",
    },
  ]);
  assert.match(
    typedData.reasons.find((reason) => reason.code === "POLICY_ALWAYS_ERRORS")?.message ?? "",
    /eth\.tx, eth\.eip_712|eth\.eip_712, eth\.tx/,
  );

  const quoted = policiesFromFile().map((policy) =>
    policy.policyName === "agent-guard allowlist"
      ? { ...policy, condition: "eth.tx.to != 'solana.tx.transfers'" }
      : policy,
  );
  const quotedReport = auditFixture(quoted);
  assert.equal(quotedReport.reasons.some((reason) => reason.code === "POLICY_ALWAYS_ERRORS"), false);
  assert.equal(quotedReport.ok, true, JSON.stringify(quotedReport.reasons));
  assert.deepEqual(chainNamespacesIn("eth.tx.to != 'solana.tx.transfers'"), ["eth.tx"]);

  const brokenAllow = policiesFromFile().map((policy) =>
    policy.policyName === "agent-guard consensus"
      ? { ...policy, condition: "activity.action == 'SIGN' || eth.tx.to != '' || solana.tx.transfers.count() > 0" }
      : policy,
  );
  const allowReport = auditFixture(brokenAllow);
  assert.equal(allowReport.reasons.some((reason) => reason.code === "POLICY_ALWAYS_ERRORS"), true);
  assert.equal(allowReport.reasons.some((reason) => reason.code === "CONSENSUS_MISSING"), true);
  assert.equal(allowReport.reasons.some((reason) => reason.code === "AGENT_CAN_SIGN_ALONE"), false);
});

test("a DENY backstop counts only when consensus names the agent or everyone", () => {
  const withConsensus = (consensus: string) =>
    policiesFromFile().map((policy) =>
      policy.policyName === "agent-guard allowlist" ? { ...policy, consensus } : policy,
    );

  const approverOnly = auditFixture(withConsensus("approvers.any(user, user.id == 'user-guard')"));
  assert.equal(approverOnly.reasons.some((reason) => reason.code === "POLICY_ALWAYS_ERRORS"), false);
  assert.match(
    approverOnly.reasons.find((reason) => reason.code === "BACKSTOP_MISSING")?.message ?? "",
    /recipient allowlist/,
  );

  const otherUser = auditFixture(withConsensus("approvers.any(user, user.id == 'user-other')"));
  assert.match(
    otherUser.reasons.find((reason) => reason.code === "BACKSTOP_MISSING")?.message ?? "",
    /recipient allowlist/,
  );

  const twoApprovers = auditFixture(withConsensus("approvers.count() >= 2"));
  assert.match(
    twoApprovers.reasons.find((reason) => reason.code === "BACKSTOP_MISSING")?.message ?? "",
    /recipient allowlist/,
  );

  for (const consensus of ["true", "", "approvers.count() >= 1", "approvers.any(user, user.id == 'user-agent')"]) {
    const report = auditFixture(withConsensus(consensus));
    assert.equal(report.ok, true, `${JSON.stringify(consensus)} ${JSON.stringify(report.reasons)}`);
  }
});

test("backstop policies stay on testnet and can be applied to the fixture", async () => {
  const ruleset = makeRuleset();
  const policies = buildBackstopPolicies({
    ruleset,
    agentUserId: AGENT_USER,
    approverUserId: GUARD_USER,
    wallets: wallets(),
  });
  const joined = policies.map((policy) => `${policy.effect} ${policy.consensus} ${policy.condition}`).join("\n");
  assert.match(joined, /user-agent/);
  assert.match(joined, /user-guard/);
  assert.match(joined, new RegExp(String(BASE_SEPOLIA_CHAIN_ID)));
  assert.match(joined, /address_table_lookups/);
  assert.match(joined, /ACTIVITY_TYPE_SIGN_RAW_PAYLOAD/);
  assert.match(joined, /activity\.action == 'EXPORT'/);
  assert.match(joined, /'POLICY', 'USER', 'CREDENTIAL'/);
  assert.equal(policies.some((policy) => policy.effect === "EFFECT_ALLOW" && policy.consensus.includes("&&")), true);
  for (const policy of policies) {
    assert.ok(chainNamespacesIn(policy.condition).length <= 1, policy.policyName);
  }

  const { adapter, client } = adapterFor(policiesFromFile());
  const plan = await adapter.mirrorBackstop(ruleset, { apply: true });
  assert.equal(plan.applied, true);
  assert.equal(client.calls.includes("createPolicies"), true);

  const bare = createTurnkeyAdapter(
    {
      ...client,
      createPolicies: undefined,
    },
    {
      organizationId: "org-test",
      agentUserId: AGENT_USER,
      approverUserId: GUARD_USER,
      wallets: wallets(),
    },
  );
  await assert.rejects(() => bare.mirrorBackstop(ruleset, { apply: true }), /dashboard/);

  const mainnet = makeRuleset();
  mainnet.chains = ["base"];
  assert.throws(
    () =>
      buildBackstopPolicies({
        ruleset: mainnet,
        agentUserId: AGENT_USER,
        approverUserId: GUARD_USER,
        wallets: [],
      }),
    AdapterError,
  );
  assert.throws(
    () =>
      createTurnkeyAdapter(client, {
        organizationId: "org-test",
        agentUserId: AGENT_USER,
        approverUserId: GUARD_USER,
        wallets: [{ walletId: "wallet-main", chain: "base" as never }],
      }),
    /base-sepolia and solana-devnet/,
  );
});

test("API key stamp is a P-256 DER signature over the body and is not a network call", () => {
  const secret = p256.utils.randomSecretKey();
  const secretHex = bytesToHex(secret);
  const body = JSON.stringify({ organizationId: "org-test" });
  const header = stampRequest(body, publicKeyFromPrivate(secretHex), secretHex);
  const decoded = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as {
    publicKey: string;
    signature: string;
    scheme: string;
  };
  assert.equal(decoded.scheme, "SIGNATURE_SCHEME_TK_API_P256");
  assert.equal(decoded.publicKey, publicKeyFromPrivate(secretHex));
  assert.equal(
    p256.verify(hexToBytes(decoded.signature), new TextEncoder().encode(body), hexToBytes(decoded.publicKey), {
      format: "der",
      lowS: true,
    }),
    true,
  );
});
