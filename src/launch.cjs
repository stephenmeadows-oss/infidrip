"use strict";

const { Connection, PublicKey, TransactionMessage, VersionedTransaction } = require("@solana/web3.js");
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
  const block = await args.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: user,
    recentBlockhash: block.blockhash,
    instructions: instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  const feeInfo = await args.connection.getFeeForMessage(message, "confirmed");
  if (feeInfo.value == null) throw new Error("Could not price the network fee.");
  const bytes = tx.serialize().length;
  if (bytes > 1232) {
    throw new Error("The transaction is too large. Shorten the name or ticker.");
  }
  return {
    tx: tx,
    tokenAmount: tokenAmount,
    feeLamports: feeInfo.value.toString(),
    bytes: bytes,
    blockhash: block.blockhash,
    lastValidBlockHeight: block.lastValidBlockHeight,
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
