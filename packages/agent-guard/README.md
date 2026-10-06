# @infidrip/agent-guard

Rules engine, receipt log, Turnkey approver, and spend ledger for Agent Guard v1.

Agent Guard is a non-custodial pre-sign check. A human owner sets spending caps, an allowlist of recipient addresses, and expiry. Before the owner's wallet signs a payment an agent proposes, `evaluate` returns `allow`, `deny`, or `escalate` with the rules it checked and a human-readable reason. The package does not hold wallet keys or funds, and it does not send a transaction.

`escalate` is not an approval. It means the amount sits above `escalate_above_usd` and under the hard caps, so the owner has to decide. Anything malformed, unknown, expired, or ambiguous is `deny`.

## Why TypeScript, in this repo

The Infidrip site is static HTML and has no application runtime. This library lives in `packages/agent-guard` so it does not change the site. TypeScript is a practical fit for the rest of v1:

- `bigint` keeps base-unit amounts exact. Money math never uses floating point.
- Ajv checks the draft 2020-12 ruleset schema from the spec.
- Later pieces (owner CLI, agent shim, MCP tool) are natural TypeScript callers.

Runtime dependencies are the schema validator, RFC 8785 canonical JSON, and the noble Ed25519 and hash libraries. There is no wallet SDK and no network client.

## What M1 covers

- Ruleset JSON Schema at `schema/agent-guard-ruleset-v1.json`, plus typed validation.
- Detached owner Ed25519 signature over the raw SHA-256 digest of the RFC 8785 canonical ruleset. The signature is not a field inside the body.
- Monotonic `version` check when the caller passes the active version.
- Deterministic `evaluate(ruleset, payment, prior spend, clock, prices)`.
- Per-transaction caps, rolling period caps, per-asset caps, allowlist (including per-address expiry, asset filter, and USD cap), and ruleset expiry.
- Chain ids `base`, `base-sepolia`, `solana`, and `solana-devnet` as data. Nothing here dials a chain.
- Integer base units. USD value is `ceil(amount * price / 10^decimals)` in micros (6 decimal places).
- Asset ids follow the schema pattern exactly. Illustrative ids in the spec that contain underscores do not match that pattern, so validation rejects them.

Evaluation stops at the first failing rule. The fixed order follows the spec: schema and signature, validity window, agent status, kind, chain, asset, decimals, allowlist, per-transaction caps, period caps, then the escalate band.

## Stubbed for later milestones

- `evaluate` does not retrieve prices. Pass a `PriceQuote`, or call `checkPayment` with a `PriceSource`. A second quote is enforced only when one is present. `PriceQuote.isStable` turns on the depeg band. The ruleset schema has no `is_stable` field.
- `require_price: false` does not skip USD caps. The schema requires those caps, and there is no owner-set worst-case USD value, so a missing price still denies.
- `evaluate` still takes the spend ledger as a list. Held and committed rows inside the rolling window count. Released rows do not. The window is half-open: a spend exactly `period_seconds` old has fallen out. Reservations are applied by `checkPayment`.
- Payload decoding is not in this package. Kinds other than `native_transfer` and `token_transfer` are denied. Fees are added to USD caps only when `count_fees` is true and the intent carries a fee. They are not added to base-unit caps.
- External anchoring and the owner CLI are milestone M5.

## What M2 covers

Every ruleset activation, payment attempt, and evaluate decision can be appended to a receipt log. The log also records provider approve and reject notices, outcomes, gap markers, log key rotation, and references to earlier checkpoints. Each entry is hash-chained to the previous one and signed with a log key. Checkpoints are RFC 6962 Merkle roots over the entry hashes, signed by the log key that is active at the head. The default checkpoint policy is every 256 entries or 10 minutes, and an export always checkpoints the current head.

`exportBundle` writes an in-memory bundle. `writeBundle` stores it as a directory:

- `entries.jsonl` and `checkpoints.jsonl`: one canonical JSON object per line
- `rulesets/<body_hash>.json`: ruleset body plus the detached owner signature
- `keys.json`: log public keys, their validity windows, and the owner rules public key
- `proof.json`: the small download a UI can keep. It carries the latest signed checkpoint, the entry count, and the checkpoint count

`verifyBundle` and `verifyDirectory` recompute every hash, check every signature, rebuild every Merkle root, and run `evaluate` again on the logged inputs. A decision whose fresh result does not match the receipt is rejected. The verifier reads only the export. It does not open a socket.

The log key is a test or deployment signing key for the receipt log. It is not a wallet key, and the secret is not written into the export. `provider: "turnkey"` on a receipt is the provider label. M3 is the first code that can call Turnkey, and only when credentials are present.

Checkpoint signatures use `agent-guard/checkpoint/v1` concatenated with SHA-256 of the canonical checkpoint object without `sig`. Receipt signatures use `agent-guard/receipt/v1` concatenated with the raw entry hash.

## Verifier limits

A consistent prefix of the log, paired with an older checkpoint that was honestly signed for that prefix, looks valid on its own. Dropping entries while keeping the original `proof.json` fails. To reject a swapped older proof, pass `expectedHeadHash` from a proof the operator saved earlier. External timestamp anchoring is milestone M5. If an `anchors/` directory is present, the verifier reports that it was not checked and does not treat the log as anchored.

Payload hashes are recorded as supplied by the caller. M2 does not decode transaction bytes.

## What M3 covers

M3 is the Turnkey approver adapter. The rules engine and the receipt log do not import it. A `SignerAdapter` is the seam for later providers (Privy, Coinbase CDP, Safe, Crossmint). v1 implements Turnkey only.

- `allow` approves the Turnkey activity by fingerprint (`ACTIVITY_TYPE_APPROVE_ACTIVITY`).
- `deny` rejects it (`ACTIVITY_TYPE_REJECT_ACTIVITY`).
- `escalate` sends neither. The activity stays pending for the owner.
- Approve is refused until `startupCheck` passes, and until the caller sets `decisionLogged`. The same fingerprint is not approved twice.
- `startupCheck` refuses to run when the agent can sign alone, when the approver can sign, when the two roles are the same user, when the joint consensus ALLOW is missing, or when a required DENY backstop is missing.
- A condition that mentions two chain payloads, such as `eth.tx` and `solana.tx`, or that mentions both `wallet` and `private_key`, is `POLICY_ALWAYS_ERRORS`. Turnkey evaluates every clause and does not short circuit, so that policy never applies and is not counted as a backstop. A DENY counts only when its consensus names the agent user or applies to everyone (`true`, empty, or `approvers.count() >= 1`).
- A recipient allowlist DENY is required for each chain that has a sign ALLOW. An Ethereum DENY does not cover a Solana ALLOW, and the reverse is also true. A chain with no sign ALLOW does not add that requirement.
- A canary in `ACTIVITY_STATUS_CONSENSUS_NEEDED` passes. A canary in `ACTIVITY_STATUS_COMPLETED` passes only when `votes` contains `VOTE_SELECTION_APPROVED` from both the agent and the approver (`canaryVerdict` is `jointly_approved`). A completed canary with no approver approval is `agent_signed_alone`. Other statuses fail.
- `healthcheck` passes only when whoami is the configured approver user in the configured organization. An agent API key fails that check.
- Chains are Base Sepolia (chain id 84532) and Solana devnet only. A mainnet chain throws.
- `mirrorBackstop` builds the consensus ALLOW and the DENY policies from a ruleset. The live client does not submit them.

Unit tests use an in-memory Turnkey client and JSON fixtures. They do not open a socket. The live test is skipped unless `TURNKEY_ORG_ID` and `TURNKEY_API_KEY` are set. Even then it only calls whoami and the startup check. It does not approve, reject, or broadcast.

The in-memory canary is a fixture: if any ALLOW lets the agent sign without the approver, the canary status is `ACTIVITY_STATUS_COMPLETED` and the only vote is the agent's approval. The live client never submits a signature request. John records a manual 0-value canary and passes its activity id. The audit reads that activity's `votes` array.

## What M4 covers

`checkPayment` runs the pre-sign check around `evaluate`. It reads two prices, reserves the spend, and writes the decision log before the caller may approve (`mayApprove`).

- Testnet assets use mainnet ETH/USD, USDC/USD, and SOL/USD pairs. Base assets use Chainlink as the primary source and Pyth as the cross-check. Solana assets do the reverse. A `price_feed_id` prefix overrides that order. The catalog stores public Chainlink proxy addresses and public Pyth feed ids. Those values are not secrets.
- This package does not call Chainlink or Pyth. Tests use `createMockPriceSource`. `createLivePriceSource` is a stub that always throws. A live Pyth Hermes client would need `PYTH_API_KEY` (Bearer token, required since 2026-08-26). That variable is not read and no key is stored. A live Chainlink read needs no API key. It would also dial a mainnet RPC, which this package does not do.
- Both sources are required. Staleness, source deviation, and the stablecoin depeg band are the checks `evaluate` already applies. A killed feed, a missing quote, or a thrown read becomes `PRICE_UNAVAILABLE`, and nothing is reserved.
- The spend ledger holds a reservation on allow. Held rows count until they expire (default 300 seconds), are released, or are committed. Committed rows keep counting until they leave the rolling window. Released rows do not. Evaluation and the reservation for one agent run under one lock, so two parallel payments cannot both fit a cap that only has room for one.
- The same fingerprint and payload returns the prior decision and does not reserve again. `mayApprove` stays true until `markApproved`, so a failed approve can be retried. A different payload for that fingerprint is `REPLAY`. The same idempotency key with a different payload is `IDEMPOTENCY_CONFLICT`. With a key, the first logged decision sticks. Without a key, a price or cap deny does not stick.
- Base Sepolia must carry chain id 84532. Chain id 8453 and the chain names `base` and `solana` are refused. Solana devnet must carry a recent blockhash, which is recorded. A shared blockhash on a different payload is allowed. The same payload hash is not decided twice. An approved nonce is not approved again.
- On-chain decimals are compared with the pinned asset and with the payment. A failed read is `DECIMALS_MISMATCH`. Per-asset caps stay in base units. The aggregate period cap is USD across assets and includes held reservations.
- Fail closed: a stopped guard, a killed ledger, a killed price feed, and a log write failure all deny. A log failure releases the reservation. The caller must not approve unless `mayApprove` is true.
- Dedupe is off unless `dedupeWindowSeconds` is set. The same recipient, asset, and amount inside that window escalates and does not reserve.
- `receiptDecisionLog` writes an evaluate result as an attempt plus a decision, using the ledger from before the new hold, so the offline verifier recomputes the same result. Guard-level denies are attempts only. A decision receipt is re-derived by `evaluate`, which does not see replay, chain id, or on-chain decimals.

## Turnkey setup for John

Do this in a test organization. Do not use an organization that holds mainnet funds. Do not commit the private key.

1. Create a Turnkey account at https://app.turnkey.com and create an organization. Put the organization id in `TURNKEY_ORG_ID`.
2. Keep the root user for yourself. Do not give that API key to the agent or to Agent Guard.
3. Create a non-root agent user. It may propose signatures. Put its user id in `TURNKEY_AGENT_USER_ID`. Store its API key for the agent only.
4. Create a non-root approver user. This is the documented Approver persona: it may approve and reject activities, and it must not have a policy that lets it sign. Put its user id in `TURNKEY_APPROVER_USER_ID`. Its API public key is `TURNKEY_API_KEY` (hex, compressed P-256). Its API private key is `TURNKEY_API_PRIVATE_KEY` (32-byte hex) on the Guard host only.
5. Create wallets for Base Sepolia (chain id 84532) and Solana devnet only. Do not create Base mainnet (chain id 8453) or Solana mainnet accounts. Fund them with faucet tokens only.
6. Create policies. `mirrorBackstop` prints the JSON. The required shape is:
   - `EFFECT_ALLOW` with consensus `approvers.any(user, user.id == '<agent>') && approvers.any(user, user.id == '<approver>')` and condition `activity.action == 'SIGN'`, scoped to those wallets.
   - `EFFECT_ALLOW` for the approver limited to `ACTIVITY_TYPE_APPROVE_ACTIVITY` and `ACTIVITY_TYPE_REJECT_ACTIVITY`.
   - `EFFECT_DENY` when the recipient is outside the allowlist, one policy per chain that has a sign ALLOW. A Solana recipient DENY does not satisfy a Base Sepolia ALLOW. Do not OR `eth.tx` with `solana.tx` (or `tron.tx`, `bitcoin.tx`, `tempo.tx`, `eth.eip_712`, or `eth.eip_7702_authorization`) in one condition, and do not OR `wallet.id` with `private_key.id`. Turnkey evaluates every clause and will error that policy on every activity.
   - Each of those DENY policies must use consensus that names the agent user, or consensus that applies to everyone (`true`). A DENY whose consensus names only the approver does not cover the agent's signature request.
   - `EFFECT_DENY` when Base Sepolia `eth.tx.value` is above the native per-transaction cap.
   - `EFFECT_DENY` when `solana.tx.address_table_lookups.count != 0`.
   - `EFFECT_DENY` raw payload signing (`ACTIVITY_TYPE_SIGN_RAW_PAYLOAD` and the v2 variants) for the agent.
   - `EFFECT_DENY` export, recognized as `activity.action == 'EXPORT'` or an `ACTIVITY_TYPE_EXPORT_` type (private key, wallet, or wallet account).
   - `EFFECT_DENY` user, credential, and policy changes, recognized from `activity.resource` values `POLICY`, `USER`, and `CREDENTIAL`, or from activity types such as `ACTIVITY_TYPE_CREATE_POLICY`, `ACTIVITY_TYPE_UPDATE_USER`, `ACTIVITY_TYPE_CREATE_USERS`, and `ACTIVITY_TYPE_CREATE_API_KEYS`.
   - No plain ALLOW whose consensus is only the agent, and no `approvers.count() >= 1` on signing. Turnkey DENY overrides ALLOW, but an agent-only ALLOW is still a fail-open setup.
7. Canary, by hand: with the agent API key, submit a 0-value Base Sepolia or Solana devnet transfer to an allowlisted test address. Do not broadcast. A passing canary is still `ACTIVITY_STATUS_CONSENSUS_NEEDED`, or `ACTIVITY_STATUS_COMPLETED` with `VOTE_SELECTION_APPROVED` from both the agent and the approver. If it completes with no approval vote from the approver, the agent can sign alone. Remove that policy before anything else. Put the activity id in `TURNKEY_CANARY_ACTIVITY_ID`.
8. Optional: `TURNKEY_WALLETS=base-sepolia:<wallet id>,solana-devnet:<wallet id>`, `TURNKEY_API_BASE_URL` (default `https://api.turnkey.com`), and `TURNKEY_EXPECT_READY=1` after the checklist is done.
9. From `packages/agent-guard`, run `npm test`. With the two live variables unset, the live test skips. With them set, the test calls whoami and `startupCheck`. It still does not approve or reject. whoami must be the approver user. `TURNKEY_EXPECT_READY=1` asserts the startup check passed, including a pending canary or a jointly approved completed canary.

Open questions this package does not answer: whether Turnkey bills the approve activity, whether testnet signatures count toward the free tier, and the exact dashboard expiry of a pending activity. Turnkey's activity docs say the activity stays in `ACTIVITY_STATUS_CONSENSUS_NEEDED`, and the first approval ages out after 24 hours. Confirm that in the dashboard before relying on it.

## Run the verifier

```bash
npm run verify -- ./path-to-bundle
npm run verify -- ./path-to-bundle --expect-head <64-hex-chars>
```

The command prints one sentence, then the JSON report. Exit 0 means the chain checked out. Exit 1 means it did not. Exit 2 means the arguments were wrong.

## Run the tests

From `packages/agent-guard`:

```bash
npm ci
npm test
npm run typecheck
```

No network access is required after dependencies are installed. CI runs the same two commands on Ubuntu with Node 22.

## Signature format

```text
body_hash = hex(SHA-256(JCS(ruleset body)))
signature = base64(Ed25519_sign(raw 32-byte body_hash, owner rules key))
```

`generateRulesKeypair` creates an owner rules key. That key is not a wallet key.
