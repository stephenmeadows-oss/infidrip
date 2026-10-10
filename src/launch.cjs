"use strict";

const { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } = require("@solana/web3.js");
const { getMintLen, ExtensionType, ACCOUNT_SIZE } = require("@solana/spl-token");
const BN = require("bn.js");
const {
  OnlinePumpSdk,
  PUMP_SDK,
  PUMP_PROGRAM_ID,
  BONDING_CURVE_NEW_SIZE,
  getBuyTokenAmountFromSolAmount,
  computeFeesBps,
  selectCurveFeeSchedule,
  bondingCurveMarketCap,
} = require("@pump-fun/pump-sdk");

const TOTAL_SUPPLY_TOKENS = 1000000000;
const DECIMALS = 6;
const ESTIMATE_URI = "https://gateway.irys.xyz/" + "a".repeat(43);
const TX_LIMIT = 1232;
// Confirmed by owner 2026-10-10.
const FEE_RECIPIENT = "EEQzHtX66bqacFvkb8hi1Xrovrek8GmXBGP8kFrh5Y6H";
const FEE_LAMPORTS = 50000000;
// Active mainnet lookup table that already stores the shared program accounts.
// It is not Infidrip's. Used only when the fee transfer would pass 1232 bytes.
const LAUNCH_LOOKUP_TABLE = "Hyif6eWb8x88RVrvjPfabsgRYnwkVnyByEXTVTXbUcyP";
const NOT_DEACTIVATED = "18446744073709551615";

const RPCS = {
  "mainnet-beta": [
    "https://solana-rpc.publicnode.com",
    "https://api.mainnet-beta.solana.com",
  ],
  devnet: ["https://api.devnet.solana.com"],
};

function endpointFor(cluster) {
  const list = RPCS[cluster];
  if (!list) throw new Error("Unknown network.");
  return list[0];
}

function connectionFor(cluster, url) {
  return new Connection(url || endpointFor(cluster), "confirmed");
}

function bn(value) {
  return new BN(value.toString());
}

function tokenMetadataLen(name, symbol, uri) {
  return 32 + 32 + 4 + Buffer.byteLength(name) + 4 + Buffer.byteLength(symbol) + 4 + Buffer.byteLength(uri) + 4;
}

async function rentExemption(connection, bytes) {
  return BigInt(await connection.getMinimumBalanceForRentExemption(bytes));
}

async function estimateRent(connection, fields) {
  const uri = fields.uri || ESTIMATE_URI;
  const metaLen = tokenMetadataLen(fields.name, fields.symbol, uri);
  const mintLen = getMintLen([ExtensionType.MetadataPointer], {
    [ExtensionType.TokenMetadata]: metaLen,
  });
  const mint = await rentExemption(connection, mintLen);
  const curve = await rentExemption(connection, BONDING_CURVE_NEW_SIZE);
  const ata = await rentExemption(connection, ACCOUNT_SIZE);
  const withBuy = BigInt(fields.buyLamports || 0) > 0n;
  const userAta = withBuy ? ata : 0n;
  return {
    mintLen: mintLen,
    curveLen: BONDING_CURVE_NEW_SIZE,
    ataLen: ACCOUNT_SIZE,
    mint: mint.toString(),
    curve: curve.toString(),
    curveAta: ata.toString(),
    userAta: userAta.toString(),
    total: (mint + curve + ata + userAta).toString(),
  };
}

async function loadCurve(connection) {
  const online = new OnlinePumpSdk(connection);
  const global = await online.fetchGlobal();
  const feeConfig = await online.fetchFeeConfig();
  return { global: global, feeConfig: feeConfig };
}

function feeRates(global, feeConfig) {
  const marketCap = bondingCurveMarketCap({
    mintSupply: global.tokenTotalSupply,
    virtualQuoteReserves: global.initialVirtualSolReserves,
    virtualTokenReserves: global.initialVirtualTokenReserves,
  });
  const schedule = selectCurveFeeSchedule({
    feeConfig: feeConfig,
    quoteMint: PublicKey.default,
    marketCap: marketCap,
  });
  const computed = computeFeesBps({
    global: global,
    feeConfig: feeConfig,
    mintSupply: global.tokenTotalSupply,
    virtualQuoteReserves: global.initialVirtualSolReserves,
    virtualTokenReserves: global.initialVirtualTokenReserves,
    quoteMint: PublicKey.default,
  });
  return {
    protocolFeeBps: Number(computed.protocolFeeBps.toString(10)),
    creatorFeeBps: Number(computed.creatorFeeBps.toString(10)),
    lpFeeBps: Number(schedule.lpFeeBps.toString(10)),
    marketCapLamports: marketCap.toString(10),
  };
}

function tokensForBuy(global, feeConfig, buyLamports) {
  if (BigInt(buyLamports) === 0n) return "0";
  const quoted = getBuyTokenAmountFromSolAmount({
    global: global,
    feeConfig: feeConfig,
    mintSupply: null,
    bondingCurve: null,
    amount: bn(buyLamports),
    quoteMint: PublicKey.default,
  });
  const slipped = quoted.muln(99).divn(100);
  return (slipped.isZero() ? quoted : slipped).toString(10);
}

function feeTransfer(user) {
  return SystemProgram.transfer({
    fromPubkey: user,
    toPubkey: new PublicKey(FEE_RECIPIENT),
    lamports: FEE_LAMPORTS,
  });
}

const lookupCache = new Map();

async function usableLookupTable(connection) {
  const cacheKey = connection.rpcEndpoint || "";
  const cached = lookupCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.table;
  const result = await connection.getAddressLookupTable(new PublicKey(LAUNCH_LOOKUP_TABLE));
  const table = result && result.value;
  if (!table || String(table.state.deactivationSlot) !== NOT_DEACTIVATED) {
    lookupCache.set(cacheKey, { table: null, expires: Date.now() + 15000 });
    return null;
  }
  lookupCache.set(cacheKey, { table: table, expires: Date.now() + 60000 });
  return table;
}

async function compileLaunch(connection, user, instructions, lookupTables) {
  const block = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: user,
    recentBlockhash: block.blockhash,
    instructions: instructions,
  }).compileToV0Message(lookupTables || []);
  const tx = new VersionedTransaction(message);
  let bytes = TX_LIMIT + 1;
  try {
    bytes = tx.serialize().length;
  } catch (err) {
    bytes = TX_LIMIT + 1;
  }
  const feeInfo = await connection.getFeeForMessage(message, "confirmed");
  if (feeInfo.value == null) throw new Error("Could not price the network fee.");
  return {
    tx: tx,
    bytes: bytes,
    blockhash: block.blockhash,
    lastValidBlockHeight: block.lastValidBlockHeight,
    networkFee: feeInfo.value.toString(),
    lookupTables: lookupTables || [],
  };
}

async function buildLaunchTransaction(args) {
  const user = args.user instanceof PublicKey ? args.user : new PublicKey(args.user);
  const mint = args.mint instanceof PublicKey ? args.mint : new PublicKey(args.mint);
  const buyLamports = bn(args.buyLamports || 0);
  let instructions;
  let tokenAmount = "0";
  if (buyLamports.isZero()) {
    instructions = [
      await PUMP_SDK.createV2Instruction({
        mint: mint,
        name: args.name,
        symbol: args.symbol,
        uri: args.uri,
        creator: user,
        user: user,
        mayhemMode: false,
        holderReward: false,
      }),
    ];
  } else {
    tokenAmount = tokensForBuy(args.global, args.feeConfig, buyLamports.toString(10));
    instructions = await PUMP_SDK.createV2AndBuyInstructions({
      global: args.global,
      mint: mint,
      name: args.name,
      symbol: args.symbol,
      uri: args.uri,
      creator: user,
      user: user,
      amount: bn(tokenAmount),
      solAmount: buyLamports,
      mayhemMode: false,
      holderReward: false,
    });
  }
  const withFee = instructions.concat([feeTransfer(user)]);
  let built = await compileLaunch(args.connection, user, withFee, []);
  let approach = "same-transaction";
  if (built.bytes > TX_LIMIT) {
    const table = await usableLookupTable(args.connection);
    if (table) {
      const shrunk = await compileLaunch(args.connection, user, withFee, [table]);
      if (shrunk.bytes <= TX_LIMIT) {
        built = shrunk;
        approach = "address-lookup-table";
      }
    }
  }
  if (built.bytes > TX_LIMIT) {
    const launchBuilt = await compileLaunch(args.connection, user, instructions, []);
    const feeBuilt = await compileLaunch(args.connection, user, [feeTransfer(user)], []);
    if (launchBuilt.bytes > TX_LIMIT || feeBuilt.bytes > TX_LIMIT) {
      throw new Error("The transaction is too large. Shorten the name or ticker.");
    }
    return {
      tx: launchBuilt.tx,
      feeTx: feeBuilt.tx,
      approach: "separate-fee-transaction",
      tokenAmount: tokenAmount,
      feeLamports: (BigInt(launchBuilt.networkFee) + BigInt(feeBuilt.networkFee)).toString(),
      infidripFeeLamports: String(FEE_LAMPORTS),
      bytes: launchBuilt.bytes,
      feeTxBytes: feeBuilt.bytes,
      blockhash: launchBuilt.blockhash,
      lastValidBlockHeight: launchBuilt.lastValidBlockHeight,
      feeBlockhash: feeBuilt.blockhash,
      feeLastValidBlockHeight: feeBuilt.lastValidBlockHeight,
      lookupTables: [],
    };
  }
  return {
    tx: built.tx,
    feeTx: null,
    approach: approach,
    tokenAmount: tokenAmount,
    feeLamports: built.networkFee,
    infidripFeeLamports: String(FEE_LAMPORTS),
    bytes: built.bytes,
    blockhash: built.blockhash,
    lastValidBlockHeight: built.lastValidBlockHeight,
    lookupTables: built.lookupTables,
  };
}

function tradingPageUrl(cluster, mint) {
  if (cluster !== "mainnet-beta") return "";
  return "https://pump.fun/coin/" + mint;
}

function solscanUrl(cluster, mint) {
  const base = "https://solscan.io/token/" + mint;
  return cluster === "devnet" ? base + "?cluster=devnet" : base;
}

function formatSol(lamports) {
  const value = BigInt(lamports || 0);
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const whole = abs / 1000000000n;
  const frac = (abs % 1000000000n).toString().padStart(9, "0").replace(/0+$/, "");
  const text = frac ? whole.toString() + "." + frac : whole.toString();
  return (neg ? "-" : "") + text;
}

module.exports = {
  TOTAL_SUPPLY_TOKENS,
  DECIMALS,
  ESTIMATE_URI,
  TX_LIMIT,
  FEE_RECIPIENT,
  FEE_LAMPORTS,
  LAUNCH_LOOKUP_TABLE,
  RPCS,
  PUMP_PROGRAM_ID,
  endpointFor,
  connectionFor,
  estimateRent,
  loadCurve,
  feeRates,
  tokensForBuy,
  buildLaunchTransaction,
  tradingPageUrl,
  solscanUrl,
  formatSol,
};
