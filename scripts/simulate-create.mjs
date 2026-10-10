import { createRequire } from "module";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const require = createRequire(import.meta.url);
const { Keypair, PublicKey, SystemProgram } = require("@solana/web3.js");
const {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} = require("@solana/spl-token");
const { bondingCurvePda, creatorVaultPda } = require("@pump-fun/pump-sdk");
const validate = require("../src/validate.cjs");
const launch = require("../src/launch.cjs");

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const proofPath = join(root, "proof", "simulation.json");
const DONATE = "EEQzHtX66bqacFvkb8hi1Xrovrek8GmXBGP8kFrh5Y6H";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertNeutral(value, label) {
  const text = JSON.stringify(value);
  const banned = [
    "Infidrip",
    "infidrip",
    "Enable normie tokenization",
    "We meet them where they are",
    "normie",
  ];
  banned.forEach(function (word) {
    if (text.includes(word)) throw new Error(label + " contains a site line: " + word);
  });
}

function checkValidators() {
  assert(validate.httpsUrl("").ok && validate.httpsUrl("").value === "", "empty url");
  assert(!validate.httpsUrl("http://example.com/a").ok, "http");
  assert(!validate.httpsUrl("javascript:alert(1)").ok, "javascript");
  assert(!validate.httpsUrl("https://").ok, "malformed");
  assert(validate.httpsUrl("https://example.com/path").ok, "https");
  assert(validate.cleanSymbol("test") === "TEST", "symbol");
  assert(validate.cleanName("Test Coin") === "Test Coin", "name");
  assert(validate.parseSolToLamports("") === 0n, "empty slice");
  assert(validate.parseSolToLamports("0.001") === 1000000n, "slice");
  assert(validate.parseSolToLamports("-1") == null, "negative");
}

const COIN = {
  name: "Test Coin",
  symbol: "TEST",
  description: "A plain test coin.",
  twitter: "",
  website: "",
};

function accountKey(entry) {
  if (!entry) return null;
  if (typeof entry === "string") return new PublicKey(entry);
  if (entry.pubkey) return entry.pubkey instanceof PublicKey ? entry.pubkey : new PublicKey(entry.pubkey);
  if (entry instanceof PublicKey) return entry;
  return null;
}

async function findFundedPayers(connection) {
  const slot = await connection.getSlot("confirmed");
  const found = [];
  const seen = new Set();
  const candidates = [];
  for (const offset of [0, 40, 120]) {
    const block = await connection.getBlock(slot - offset, {
      maxSupportedTransactionVersion: 1,
      transactionDetails: "accounts",
      rewards: false,
      commitment: "confirmed",
    });
    if (!block) continue;
    for (const tx of block.transactions || []) {
    const keys = tx.transaction && tx.transaction.accountKeys;
    const payer = accountKey(keys && keys[0]);
    if (!payer) continue;
    const address = payer.toBase58();
    if (seen.has(address) || address === DONATE) continue;
    seen.add(address);
    const balance = tx.meta && tx.meta.preBalances && tx.meta.preBalances[0];
    if (!(balance >= 50000000 && balance <= 100000000000)) continue;
    candidates.push(payer);
    if (candidates.length >= 6) break;
    }
    if (candidates.length >= 6) break;
  }
  for (const payer of candidates) {
    let info;
    try {
      info = await connection.getAccountInfo(payer, "confirmed");
    } catch (err) {
      continue;
    }
    if (!info || !info.owner.equals(SystemProgram.programId)) continue;
    if (info.lamports < 50000000 || info.lamports > 100000000000) continue;
    found.push({ address: payer.toBase58(), lamports: info.lamports.toString() });
    if (found.length >= 1) break;
  }
  if (!found.length) throw new Error("No funded system account found to use as a public fee payer.");
  return found;
}

function labelsFor(mint, user) {
  const curve = bondingCurvePda(mint);
  const curveAta = getAssociatedTokenAddressSync(mint, curve, true, TOKEN_2022_PROGRAM_ID);
  const userAta = getAssociatedTokenAddressSync(mint, user, true, TOKEN_2022_PROGRAM_ID);
  const vault = creatorVaultPda(user);
  const map = new Map();
  map.set(user.toBase58(), "fee payer and creator");
  map.set(launch.FEE_RECIPIENT, "Infidrip fee recipient");
  map.set(mint.toBase58(), "mint");
  map.set(curve.toBase58(), "bonding curve");
  map.set(curveAta.toBase58(), "curve token account");
  map.set(userAta.toBase58(), "creator token account");
  map.set(vault.toBase58(), "creator vault");
  map.set(launch.PUMP_PROGRAM_ID.toBase58(), "program");
  map.set(SystemProgram.programId.toBase58(), "system program");
  map.set(TOKEN_2022_PROGRAM_ID.toBase58(), "token program");
  return map;
}

async function withRetry(label, fn) {
  let last;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const msg = String(err && err.message || err);
      if (!msg.includes("403") && !msg.includes("429") && !msg.includes("blocked")) throw err;
      console.error("retry", label, attempt + 1);
      await new Promise(function (resolve) { setTimeout(resolve, 1500 * (attempt + 1)); });
    }
  }
  throw last;
}

async function rpcSimulate(connection, tx, addresses) {
  const wire = Buffer.from(tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  })).toString("base64");
  const response = await connection._rpcRequest("simulateTransaction", [
    wire,
    {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "processed",
      accounts: {
        encoding: "base64",
        addresses: addresses,
      },
    },
  ]);
  if (response.error) {
    throw new Error(response.error.message || JSON.stringify(response.error));
  }
  return response.result.value;
}

function accountRows(addresses, preInfos, postAccounts, labels) {
  const rows = [];
  for (let i = 0; i < addresses.length; i++) {
    const pre = preInfos[i];
    const post = postAccounts && postAccounts[i];
    const preLamports = pre ? pre.lamports.toString() : null;
    const postLamports = post ? String(post.lamports) : null;
    const dataLen = post && post.data && post.data[0]
      ? Buffer.from(post.data[0], "base64").length
      : null;
    rows.push({
      address: addresses[i],
      label: labels.get(addresses[i]) || "other",
      existedBefore: Boolean(pre),
      preLamports: preLamports,
      postLamports: postLamports,
      ownerAfter: post ? post.owner : null,
      dataLengthAfter: dataLen,
    });
  }
  return rows;
}

async function measure(connection, rows) {
  let payerSpent = 0n;
  let retained = 0n;
  let rentFloor = 0n;
  let excessOnNew = 0n;
  const liveDrift = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const pre = row.preLamports == null ? null : BigInt(row.preLamports);
    const post = row.postLamports == null ? null : BigInt(row.postLamports);
    if (i === 0) {
      if (pre == null || post == null) throw new Error("Fee payer missing from simulation accounts.");
      payerSpent = pre - post;
      continue;
    }
    const before = pre == null ? 0n : pre;
    const after = post == null ? 0n : post;
    const delta = after - before;
    if (row.address === launch.FEE_RECIPIENT) {
      retained += delta;
      row.feeDeltaLamports = delta.toString();
      continue;
    }
    if (pre != null && (delta > 2000000n || delta < -2000000n)) {
      liveDrift.push({ address: row.address, label: row.label, deltaLamports: delta.toString() });
      continue;
    }
    retained += delta;
    if (pre == null && post != null && post > 0n && row.dataLengthAfter != null) {
      const floor = BigInt(await connection.getMinimumBalanceForRentExemption(row.dataLengthAfter));
      rentFloor += floor;
      if (post > floor) excessOnNew += post - floor;
      row.rentFloorLamports = floor.toString();
      row.lamportsAboveRent = (post - floor).toString();
    }
  }
  return {
    payerSpentLamports: payerSpent.toString(),
    lamportsRetainedInOtherAccounts: retained.toString(),
    networkFeeLamports: (payerSpent - retained).toString(),
    rentFloorLamports: rentFloor.toString(),
    lamportsAboveRentOnNewAccounts: excessOnNew.toString(),
    ignoredLiveDrift: liveDrift,
  };
}

function fundingRelated(err, logs) {
  const text = JSON.stringify(err || "") + " " + (logs || []).join(" ");
  const low = text.toLowerCase();
  return low.includes("accountnotfound") || low.includes("insufficient");
}

async function runCaseOnce(connection, cluster, user, buyLamports, uri, global, feeConfig) {
  const mint = Keypair.generate();
  const built = await withRetry("build", function () {
    return launch.buildLaunchTransaction({
      connection: connection,
      user: user,
      mint: mint.publicKey,
      name: COIN.name,
      symbol: COIN.symbol,
      uri: uri,
      buyLamports: buyLamports,
      global: global,
      feeConfig: feeConfig,
    });
  });
  built.tx.sign([mint]);
  const resolved = built.tx.message.getAccountKeys({
    addressLookupTableAccounts: built.lookupTables || [],
  });
  const accountKeys = resolved.staticAccountKeys.slice();
  if (resolved.accountKeysFromLookups) {
    accountKeys.push.apply(accountKeys, resolved.accountKeysFromLookups.writable);
    accountKeys.push.apply(accountKeys, resolved.accountKeysFromLookups.readonly);
  }
  const addresses = accountKeys.map(function (key) {
    return key.toBase58();
  });
  const preInfos = [];
  for (let i = 1; i < addresses.length; i++) {
    const info = await withRetry("account " + addresses[i].slice(0, 4), function () {
      return connection.getAccountInfo(new PublicKey(addresses[i]), "processed");
    });
    preInfos.push(info);
  }
  const payerInfo = await withRetry("payer", function () {
    return connection.getAccountInfo(user, "processed");
  });
  preInfos.unshift(payerInfo);
  const feeIndex = addresses.indexOf(launch.FEE_RECIPIENT);
  if (feeIndex > 0) {
    preInfos[feeIndex] = await withRetry("fee recipient", function () {
      return connection.getAccountInfo(new PublicKey(launch.FEE_RECIPIENT), "processed");
    });
  }
  const sim = await withRetry("simulate", function () {
    return rpcSimulate(connection, built.tx, addresses);
  });
  const labels = labelsFor(mint.publicKey, user);
  const accounts = accountRows(addresses, preInfos, sim.accounts || [], labels);
  let balances = null;
  if (sim.err == null) balances = await measure(connection, accounts);
  return {
    cluster: cluster,
    rpc: launch.endpointFor(cluster),
    kind: BigInt(buyLamports) === 0n ? "createV2" : "createV2AndBuy",
    buyLamports: buyLamports.toString(),
    mint: mint.publicKey.toBase58(),
    feePayer: user.toBase58(),
    feePayerKeyHeld: false,
    mintSigned: true,
    feePayerSigned: false,
    sigVerify: false,
    replaceRecentBlockhash: true,
    approach: built.approach,
    lookupTable: built.lookupTables && built.lookupTables[0]
      ? built.lookupTables[0].key.toBase58()
      : null,
    bytes: built.bytes,
    feeTxBytes: built.feeTxBytes || null,
    infidripFeeLamports: built.infidripFeeLamports,
    quotedFeeLamports: built.feeLamports,
    tokenAmount: built.tokenAmount,
    err: sim.err,
    unitsConsumed: sim.unitsConsumed,
    logs: sim.logs || [],
    accounts: accounts,
    balances: balances,
    sent: false,
  };
}

async function runCase(connection, cluster, user, buyLamports, uri, global, feeConfig) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    last = await runCaseOnce(connection, cluster, user, buyLamports, uri, global, feeConfig);
    const row = (last.accounts || []).find(function (item) {
      return item.address === launch.FEE_RECIPIENT;
    });
    const delta = row && row.feeDeltaLamports;
    if (last.err != null) return last;
    if (delta === String(launch.FEE_LAMPORTS)) return last;
    console.error("fee recipient delta", delta, "retry", attempt + 1);
  }
  return last;
}

async function runPair(cluster, uri) {
  const connection = launch.connectionFor(cluster);
  const loaded = await launch.loadCurve(connection);
  const payers = await findFundedPayers(connection);
  const user = new PublicKey(payers[0].address);
  const create = await runCase(connection, cluster, user, "0", uri, loaded.global, loaded.feeConfig);
  const buy = await runCase(connection, cluster, user, "1000000", uri, loaded.global, loaded.feeConfig);
  return {
    payersConsidered: payers,
    feePayer: payers[0],
    rates: launch.feeRates(loaded.global, loaded.feeConfig),
    create: create,
    createAndBuy: buy,
  };
}

async function main() {
  checkValidators();
  assertNeutral(COIN, "coin");
  const previous = JSON.parse(readFileSync(proofPath, "utf8"));
  const metadataUpload = previous.metadataUpload;
  assert(metadataUpload && metadataUpload.metadataUri, "missing metadata uri");
  assertNeutral(COIN, "upload fields");
  const uri = metadataUpload.metadataUri;

  const attempts = [];
  let result = null;
  for (const cluster of ["mainnet-beta", "devnet"]) {
    const pair = await runPair(cluster, uri);
    attempts.push({
      cluster: cluster,
      feePayer: pair.feePayer,
      createErr: pair.create.err,
      createUnits: pair.create.unitsConsumed,
      buyErr: pair.createAndBuy.err,
      buyUnits: pair.createAndBuy.unitsConsumed,
    });
    const failed = pair.create.err != null || pair.createAndBuy.err != null;
    result = pair;
    result.cluster = cluster;
    if (!failed) break;
    const related = fundingRelated(pair.create.err, pair.create.logs) || fundingRelated(pair.createAndBuy.err, pair.createAndBuy.logs);
    if (!related && cluster === "mainnet-beta") continue;
    if (cluster === "mainnet-beta" && related) {
      const connection = launch.connectionFor(cluster);
      const loaded = await launch.loadCurve(connection);
      for (let i = 1; i < pair.payersConsidered.length; i++) {
        const user = new PublicKey(pair.payersConsidered[i].address);
        const create = await runCase(connection, cluster, user, "0", uri, loaded.global, loaded.feeConfig);
        const buy = await runCase(connection, cluster, user, "1000000", uri, loaded.global, loaded.feeConfig);
        attempts.push({
          cluster: cluster,
          feePayer: pair.payersConsidered[i],
          createErr: create.err,
          buyErr: buy.err,
        });
        if (create.err == null && buy.err == null) {
          result = {
            payersConsidered: pair.payersConsidered,
            feePayer: pair.payersConsidered[i],
            rates: pair.rates,
            create: create,
            createAndBuy: buy,
            cluster: cluster,
          };
          break;
        }
        result = {
          payersConsidered: pair.payersConsidered,
          feePayer: pair.payersConsidered[i],
          rates: pair.rates,
          create: create,
          createAndBuy: buy,
          cluster: cluster,
        };
      }
      if (result.create.err == null && result.createAndBuy.err == null) break;
    }
  }

  const buyBalances = result.createAndBuy.balances;
  const createBalances = result.create.balances;
  const proof = {
    testCoin: {
      name: COIN.name,
      symbol: COIN.symbol,
      description: COIN.description,
      image: "64px solid square, rgb 136,136,136, no text",
      links: "none",
    },
    metadataUpload: metadataUpload,
    program: launch.PUMP_PROGRAM_ID.toBase58(),
    supplyTokens: launch.TOTAL_SUPPLY_TOKENS,
    decimals: launch.DECIMALS,
    simulationMethod: {
      rpc: "simulateTransaction",
      sigVerify: false,
      replaceRecentBlockhash: true,
      feePayer: "public funded system account, key not held",
      broadcast: false,
    },
    attempts: attempts,
    cluster: result.cluster,
    feePayer: result.feePayer,
    curveFeeBps: result.rates,
    createV2: result.create,
    createV2AndBuy: result.createAndBuy,
    mainnetCost: buyBalances && createBalances ? {
      infidripFeeLamports: String(launch.FEE_LAMPORTS),
      feeRecipient: launch.FEE_RECIPIENT,
      approach: {
        createOnly: result.create.approach,
        createAndBuy: result.createAndBuy.approach,
        lookupTable: launch.LAUNCH_LOOKUP_TABLE,
      },
      bytes: {
        createOnly: result.create.bytes,
        createAndBuy: result.createAndBuy.bytes,
      },
      createOnly: {
        networkFeeLamports: createBalances.networkFeeLamports,
        rentFloorLamports: createBalances.rentFloorLamports,
        infidripFeeLamports: String(launch.FEE_LAMPORTS),
        creationFeeLamports: (BigInt(createBalances.payerSpentLamports) - BigInt(createBalances.networkFeeLamports) - BigInt(createBalances.rentFloorLamports) - BigInt(launch.FEE_LAMPORTS)).toString(),
        payerSpentLamports: createBalances.payerSpentLamports,
      },
      createAndBuy: {
        networkFeeLamports: buyBalances.networkFeeLamports,
        rentFloorLamports: buyBalances.rentFloorLamports,
        infidripFeeLamports: String(launch.FEE_LAMPORTS),
        creationFeeLamports: "0",
        initialBuyLamports: "1000000",
        lamportsAboveRentOnNewAccounts: buyBalances.lamportsAboveRentOnNewAccounts,
        payerSpentLamports: buyBalances.payerSpentLamports,
        curveFeeBps: result.rates,
        ignoredLiveDrift: buyBalances.ignoredLiveDrift,
      },
      measuredBy: [
        "simulateTransaction pre and post lamports, sigVerify false, replaceRecentBlockhash true",
        "network fee is the fee-payer decrease minus lamports gained by the other accounts",
        "accounts that already existed and moved by more than 0.002 SOL are left out as live drift",
        "rent floor is getMinimumBalanceForRentExemption for each new account's post data length",
        "creation fee is the create-only payer spend minus that network fee, rent floor, and the 50000000 lamport Infidrip fee",
      "the Infidrip fee is the fee recipient lamport increase and must be exactly 50000000",
      ],
    } : null,
    notes: [
      "Both transactions were simulated and not sent.",
      "The fee payer signature was left empty. sigVerify was false.",
      "A real launch still needs the visitor's own funded wallet.",
      "The test coin uses a neutral name, ticker, and solid color image.",
    ],
  };
  assertNeutral(proof.testCoin, "proof coin");
  mkdirSync(join(root, "proof"), { recursive: true });
  writeFileSync(proofPath, JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({
    cluster: result.cluster,
    feePayer: result.feePayer,
    createErr: result.create.err,
    createUnits: result.create.unitsConsumed,
    createLogs: result.create.logs,
    buyErr: result.createAndBuy.err,
    buyUnits: result.createAndBuy.unitsConsumed,
    buyLogs: result.createAndBuy.logs,
    cost: proof.mainnetCost,
    attempts: attempts,
  }, null, 2));
  const feeOk = function (row) {
    const found = (row.accounts || []).find(function (item) {
      return item.address === launch.FEE_RECIPIENT;
    });
    return found && found.feeDeltaLamports === String(launch.FEE_LAMPORTS);
  };
  if (result.create.err != null || result.createAndBuy.err != null || !feeOk(result.create) || !feeOk(result.createAndBuy)) {
    process.exitCode = 2;
  }
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
