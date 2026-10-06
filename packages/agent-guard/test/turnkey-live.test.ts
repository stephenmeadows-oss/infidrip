import assert from "node:assert/strict";
import test from "node:test";
import { createTurnkeyAdapter } from "../src/turnkey/adapter.js";
import { liveTurnkeyFromEnv } from "../src/turnkey/live.js";

const org = process.env.TURNKEY_ORG_ID?.trim() ?? "";
const apiKey = (process.env.TURNKEY_API_KEY ?? process.env.TURNKEY_API_PUBLIC_KEY)?.trim() ?? "";
const live = org.length > 0 && apiKey.length > 0;

test("live Turnkey whoami and startup check", { skip: !live }, async () => {
  const env = liveTurnkeyFromEnv();
  assert.ok(env);
  const adapter = createTurnkeyAdapter(env.client, {
    organizationId: env.organizationId,
    agentUserId: env.agentUserId,
    approverUserId: env.approverUserId,
    wallets: env.wallets,
  });
  assert.deepEqual([...adapter.capabilities().chains], ["base-sepolia", "solana-devnet"]);
  const health = await adapter.healthcheck();
  assert.equal(health.ok, true, health.message);
  assert.equal(health.organizationId, org);
  const report = await adapter.startupCheck();
  if (process.env.TURNKEY_EXPECT_READY === "1") {
    assert.equal(report.ok, true, JSON.stringify(report.reasons));
    assert.equal(report.canaryStatus, "ACTIVITY_STATUS_CONSENSUS_NEEDED");
  } else {
    assert.equal(Array.isArray(report.reasons), true);
  }
});
