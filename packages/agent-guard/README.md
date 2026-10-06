# @infidrip/agent-guard

Rules engine and append-only receipt log for Agent Guard v1, milestones M1 and M2.

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

- Price feeds are not fetched. Pass a `PriceQuote` per asset. If a USD cap needs a price and none is supplied, the decision is `deny` with `PRICE_UNAVAILABLE`. Chainlink, Pyth, staleness policy, and two-source checks are M4. A second quote is enforced only when the caller supplies one. `PriceQuote.isStable` turns on the depeg band; the ruleset schema has no `is_stable` field.
- `require_price: false` does not skip USD caps. The schema requires those caps, and M1 has no owner-set worst-case USD value, so a missing price still denies.
- The spend ledger is an input list. Persistence, reservations, and concurrency are M4. Held and committed rows inside the rolling window count. Released rows do not. The window is half-open: a spend exactly `period_seconds` old has fallen out.
- Replay, idempotency keys, and payload decoding are later milestones. Kinds other than `native_transfer` and `token_transfer` are denied here.
- Turnkey calls, external anchoring, and the owner CLI are not in this package.
- Fees are added to USD caps only when `count_fees` is true and the intent carries a fee. They are not added to base-unit caps.

## What M2 covers

Every ruleset activation, payment attempt, and evaluate decision can be appended to a receipt log. The log also records provider approve and reject notices, outcomes, gap markers, log key rotation, and references to earlier checkpoints. Each entry is hash-chained to the previous one and signed with a log key. Checkpoints are RFC 6962 Merkle roots over the entry hashes, signed by the log key that is active at the head. The default checkpoint policy is every 256 entries or 10 minutes, and an export always checkpoints the current head.

`exportBundle` writes an in-memory bundle. `writeBundle` stores it as a directory:

- `entries.jsonl` and `checkpoints.jsonl`: one canonical JSON object per line
- `rulesets/<body_hash>.json`: ruleset body plus the detached owner signature
- `keys.json`: log public keys, their validity windows, and the owner rules public key
- `proof.json`: the small download a UI can keep. It carries the latest signed checkpoint, the entry count, and the checkpoint count

`verifyBundle` and `verifyDirectory` recompute every hash, check every signature, rebuild every Merkle root, and run `evaluate` again on the logged inputs. A decision whose fresh result does not match the receipt is rejected. The verifier reads only the export. It does not open a socket.

The log key is a test or deployment signing key for the receipt log. It is not a wallet key, and the secret is not written into the export. `provider: "turnkey"` is a label on the receipt. This package does not call Turnkey.

Checkpoint signatures use `agent-guard/checkpoint/v1` concatenated with SHA-256 of the canonical checkpoint object without `sig`. Receipt signatures use `agent-guard/receipt/v1` concatenated with the raw entry hash.

## Verifier limits

A consistent prefix of the log, paired with an older checkpoint that was honestly signed for that prefix, looks valid on its own. Dropping entries while keeping the original `proof.json` fails. To reject a swapped older proof, pass `expectedHeadHash` from a proof the operator saved earlier. External timestamp anchoring is milestone M5. If an `anchors/` directory is present, the verifier reports that it was not checked and does not treat the log as anchored.

Payload hashes are recorded as supplied by the caller. M2 does not decode transaction bytes.

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
