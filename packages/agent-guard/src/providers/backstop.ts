import type { Ruleset } from "../types.js";
import { AdapterError, BASE_SEPOLIA_CHAIN_ID, type BackstopPolicy, type TestnetChainId } from "./types.js";
import { isTestnetChain } from "./types.js";

export interface BackstopWallet {
  walletId: string;
  chain: TestnetChainId;
}

export interface BackstopInput {
  ruleset: Ruleset;
  agentUserId: string;
  approverUserId: string;
  wallets: readonly BackstopWallet[];
}

const RAW_TYPES = [
  "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD",
  "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
  "ACTIVITY_TYPE_SIGN_RAW_PAYLOADS",
].join("', '");

/**
 * Stateless Turnkey policies mirrored from a ruleset.
 * The live adapter does not submit these. John reviews them and creates them in the dashboard.
 */
export function buildBackstopPolicies(input: BackstopInput): BackstopPolicy[] {
  const chains = rulesetChains(input.ruleset);
  for (const chain of chains) {
    if (!isTestnetChain(chain)) {
      throw new AdapterError(`Refusing to mirror a backstop for ${chain}. v1 allows base-sepolia and solana-devnet only.`);
    }
  }
  const agent = quoteId(input.agentUserId, "agent user id");
  const approver = quoteId(input.approverUserId, "approver user id");
  const joint = `approvers.any(user, user.id == '${agent}') && approvers.any(user, user.id == '${approver}')`;
  const agentOnly = `approvers.any(user, user.id == '${agent}')`;
  const policies: BackstopPolicy[] = [];

  const wallets = input.wallets.length > 0 ? input.wallets : chains.map((chain) => ({ walletId: "", chain }));
  if (wallets.length === 0) {
    policies.push(allowSign(joint, "activity.action == 'SIGN'", "org"));
  }
  for (const wallet of wallets) {
    const scope = wallet.walletId.length > 0 ? ` && wallet.id == '${quoteId(wallet.walletId, "wallet id")}'` : "";
    policies.push(allowSign(joint, `activity.action == 'SIGN'${scope}`, wallet.chain));
  }

  policies.push({
    policyName: "agent-guard: approver may approve or reject only",
    effect: "EFFECT_ALLOW",
    consensus: `approvers.any(user, user.id == '${approver}')`,
    condition:
      "activity.type in ['ACTIVITY_TYPE_APPROVE_ACTIVITY', 'ACTIVITY_TYPE_REJECT_ACTIVITY']",
    notes: "The guard user is an Approver. This policy does not grant SIGN.",
  });

  const evmRecipients = addresses(input.ruleset, "base-sepolia").map((address) => address.toLowerCase());
  const solRecipients = addresses(input.ruleset, "solana-devnet");
  if (chains.includes("base-sepolia") || wallets.some((wallet) => wallet.chain === "base-sepolia")) {
    const recipient = evmRecipients.length === 0
      ? `eth.tx.chain_id == ${BASE_SEPOLIA_CHAIN_ID} && eth.tx.to != ''`
      : `eth.tx.chain_id == ${BASE_SEPOLIA_CHAIN_ID} && !(eth.tx.to in [${quoteList(evmRecipients)}])`;
    policies.push(deny(agentOnly, recipient, "agent-guard: deny Base Sepolia recipients outside the allowlist"));
    const cap = nativeCap(input.ruleset, "base-sepolia");
    policies.push(
      deny(
        agentOnly,
        `eth.tx.chain_id == ${BASE_SEPOLIA_CHAIN_ID} && eth.tx.value > ${cap ?? "0"}`,
        cap === null
          ? "agent-guard: deny Base Sepolia native value because no native cap is set"
          : "agent-guard: deny Base Sepolia native value above the per-transaction cap",
      ),
    );
  }
  if (chains.includes("solana-devnet") || wallets.some((wallet) => wallet.chain === "solana-devnet")) {
    const recipient = solRecipients.length === 0
      ? "solana.tx.transfers.count() > 0"
      : `solana.tx.transfers.any(transfer, !(transfer.to in [${quoteList(solRecipients)}]))`;
    policies.push(deny(agentOnly, recipient, "agent-guard: deny Solana devnet recipients outside the allowlist"));
    policies.push(
      deny(
        agentOnly,
        "solana.tx.address_table_lookups.count != 0",
        "agent-guard: deny Solana address table lookups",
      ),
    );
  }
  policies.push(
    deny(
      agentOnly,
      `activity.type in ['${RAW_TYPES}']`,
      "agent-guard: deny raw payload signing for the agent",
    ),
  );
  policies.push(
    deny(
      "true",
      "activity.action == 'EXPORT'",
      "agent-guard: deny private key and wallet export",
    ),
  );
  policies.push(
    deny(
      "true",
      "activity.resource in ['POLICY', 'USER', 'CREDENTIAL'] && activity.action in ['CREATE', 'UPDATE', 'DELETE']",
      "agent-guard: deny user, credential, and policy changes",
    ),
  );
  return policies;
}

function allowSign(consensus: string, condition: string, scope: string): BackstopPolicy {
  return {
    policyName: `agent-guard: consensus agent and guard (${scope})`,
    effect: "EFFECT_ALLOW",
    consensus,
    condition,
    notes: "Signature consensus requires the agent and the guard approver. The agent cannot complete this alone.",
  };
}

function deny(consensus: string, condition: string, policyName: string): BackstopPolicy {
  return {
    policyName,
    effect: "EFFECT_DENY",
    consensus,
    condition,
    notes: "Native DENY backstop. DENY overrides ALLOW in the Turnkey policy engine.",
  };
}

function rulesetChains(ruleset: Ruleset): string[] {
  return ruleset.chains ?? [];
}

function addresses(ruleset: Ruleset, chain: TestnetChainId): string[] {
  return ruleset.allowlist.filter((entry) => entry.chain === chain).map((entry) => entry.address);
}

function nativeCap(ruleset: Ruleset, chain: TestnetChainId): string | null {
  const asset = ruleset.assets.find((item) => item.asset_id === `${chain}:native`);
  const cap = asset?.max_per_tx_base_units;
  if (cap === undefined) return null;
  if (!/^(0|[1-9][0-9]{0,77})$/.test(cap)) {
    throw new AdapterError("Native per-transaction cap is not a canonical integer string.");
  }
  return cap;
}

function quoteList(values: readonly string[]): string {
  return values.map((value) => `'${quoteId(value, "address")}'`).join(", ");
}

function quoteId(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("'") || value.includes("\\")) {
    throw new AdapterError(`${label} cannot be embedded in a policy condition.`);
  }
  return value;
}
