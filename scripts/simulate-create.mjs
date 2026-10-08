import { createRequire } from "module";
import { mkdirSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const require = createRequire(import.meta.url);
const { Keypair, VersionedTransaction } = require("@solana/web3.js");
const validate = require("../src/validate.cjs");
const launch = require("../src/launch.cjs");
const { solidPng } = require("../src/png.cjs");
const { uploadServiceMetadata } = require("./service-upload.cjs");

const root = dirname(dirname(fileURLToPath(import.meta.url)));

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

async function simulateCluster(cluster, uri, buyLamports, keypair) {
  const connection = launch.connectionFor(cluster);
  const loaded = await launch.loadCurve(connection);
  const mint = Keypair.generate();
  const user = keypair.publicKey;
  const built = await launch.buildLaunchTransaction({
    connection: connection,
    user: user,
    mint: mint.publicKey,
    name: COIN.name,
    symbol: COIN.symbol,
    uri: uri,
    buyLamports: buyLamports,
    global: loaded.global,
    feeConfig: loaded.feeConfig,
  });
  built.tx.sign([keypair, mint]);
  const sim = await connection.simulateTransaction(built.tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "processed",
  });
  return {
    cluster: cluster,
    rpc: launch.endpointFor(cluster),
    mint: mint.publicKey.toBase58(),
    feePayer: user.toBase58(),
    bytes: built.bytes,
    feeLamports: built.feeLamports,
    tokenAmount: built.tokenAmount,
    err: sim.value.err,
    logs: sim.value.logs || [],
    unitsConsumed: sim.value.unitsConsumed,
    sent: false,
  };
}

async function tryAirdrop(connection, pubkey) {
  const attempts = [];
  for (let i = 0; i < 3; i++) {
    try {
      const signature = await connection.requestAirdrop(pubkey, 1000000000);
      const block = await connection.getLatestBlockhash();
      await connection.confirmTransaction({
        signature: signature,
        blockhash: block.blockhash,
        lastValidBlockHeight: block.lastValidBlockHeight,
      }, "confirmed");
      return { ok: true, balance: await connection.getBalance(pubkey), attempts: attempts };
    } catch (err) {
      attempts.push(String(err.message || err).slice(0, 180));
      await new Promise(function (resolve) { setTimeout(resolve, 1500); });
    }
  }
  return { ok: false, attempts: attempts };
}

async function main() {
  checkValidators();
  assertNeutral(COIN, "coin");
  const png = solidPng(64, [136, 136, 136]);
  assert(png[0] === 137 && png[1] === 80, "png");
  const uploaded = await uploadServiceMetadata(COIN, png, "square.png");
  assertNeutral({
    name: COIN.name,
    symbol: COIN.symbol,
    description: COIN.description,
  }, "upload fields");
  const connection = launch.connectionFor("mainnet-beta");
  const loaded = await launch.loadCurve(connection);
  const rates = launch.feeRates(loaded.global, loaded.feeConfig);
  const buy = "1000000";
  const rent = await launch.estimateRent(connection, {
    name: COIN.name,
    symbol: COIN.symbol,
    uri: uploaded.metadataUri,
    buyLamports: buy,
  });
  const payer = Keypair.generate();
  const priced = await launch.buildLaunchTransaction({
    connection: connection,
    user: payer.publicKey,
    mint: Keypair.generate().publicKey,
    name: COIN.name,
    symbol: COIN.symbol,
    uri: uploaded.metadataUri,
    buyLamports: buy,
    global: loaded.global,
    feeConfig: loaded.feeConfig,
  });
  const mainnet = await simulateCluster("mainnet-beta", uploaded.metadataUri, buy, Keypair.generate());
  const devnetKey = Keypair.generate();
  const devnetConnection = launch.connectionFor("devnet");
  const airdrop = await tryAirdrop(devnetConnection, devnetKey.publicKey);
  let devnet;
  if (airdrop.ok) {
    const loadedDev = await launch.loadCurve(devnetConnection);
    const mint = Keypair.generate();
    const built = await launch.buildLaunchTransaction({
      connection: devnetConnection,
      user: devnetKey.publicKey,
      mint: mint.publicKey,
      name: COIN.name,
      symbol: COIN.symbol,
      uri: uploaded.metadataUri,
      buyLamports: buy,
      global: loadedDev.global,
      feeConfig: loadedDev.feeConfig,
    });
    const before = BigInt(await devnetConnection.getBalance(devnetKey.publicKey));
    built.tx.sign([devnetKey, mint]);
    const sim = await devnetConnection.simulateTransaction(built.tx, {
      sigVerify: true,
      replaceRecentBlockhash: true,
      commitment: "processed",
      accounts: {
        encoding: "base64",
        addresses: [devnetKey.publicKey.toBase58()],
      },
    });
    devnet = {
      cluster: "devnet",
      rpc: launch.endpointFor("devnet"),
      mint: mint.publicKey.toBase58(),
      feePayer: devnetKey.publicKey.toBase58(),
      airdrop: { ok: true, balance: airdrop.balance },
      balanceBefore: before.toString(),
      bytes: built.bytes,
      feeLamports: built.feeLamports,
      tokenAmount: built.tokenAmount,
      err: sim.value.err,
      logs: sim.value.logs || [],
      unitsConsumed: sim.value.unitsConsumed,
      sent: false,
    };
  } else {
    devnet = await simulateCluster("devnet", uploaded.metadataUri, buy, Keypair.generate());
    devnet.airdrop = airdrop;
  }
  const networkFee = BigInt(priced.feeLamports);
  const rentTotal = BigInt(rent.total);
  const buyLamports = BigInt(buy);
  const proof = {
    testCoin: {
      name: COIN.name,
      symbol: COIN.symbol,
      description: COIN.description,
      image: "64px solid square, rgb 136,136,136, no text",
      links: "none",
    },
    metadataUpload: {
      metadataUri: uploaded.metadataUri,
      accessControlAllowOrigin: uploaded.accessControlAllowOrigin,
      browserCanRead: uploaded.browserCanRead,
      solChargedByUpload: "0",
    },
    program: launch.PUMP_PROGRAM_ID.toBase58(),
    supplyTokens: launch.TOTAL_SUPPLY_TOKENS,
    decimals: launch.DECIMALS,
    mainnetCost: {
      networkFeeLamports: networkFee.toString(),
      rentLamports: rentTotal.toString(),
      rentParts: rent,
      creationFeeLamports: "0",
      initialBuyLamports: buyLamports.toString(),
      curveFeeBps: rates,
      storageLamports: "0 for this server-side upload",
      siteFeeLamports: "0",
      thirdPartyApiFee: "0, instructions are built locally",
      totalWithoutStorageLamports: (networkFee + rentTotal + buyLamports).toString(),
      measuredBy: [
        "getFeeForMessage on the built transaction",
        "getMinimumBalanceForRentExemption for mint, curve, and token accounts",
        "computeFeesBps and selectCurveFeeSchedule on live accounts",
      ],
    },
    mainnet: mainnet,
    devnet: devnet,
    notes: [
      "The create transaction was simulated and not sent.",
      "A real launch still needs a funded wallet.",
      "The test coin uses a neutral name, ticker, and solid color image.",
    ],
  };
  assertNeutral(proof.testCoin, "proof coin");
  mkdirSync(join(root, "proof"), { recursive: true });
  writeFileSync(join(root, "proof", "simulation.json"), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({
    metadataUri: uploaded.metadataUri,
    browserCanRead: uploaded.browserCanRead,
    mainnetErr: mainnet.err,
    mainnetLogs: mainnet.logs.slice(0, 12),
    devnetErr: devnet.err,
    devnetLogs: (devnet.logs || []).slice(0, 20),
    airdrop: devnet.airdrop || null,
    cost: proof.mainnetCost,
  }, null, 2));
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
