"use strict";

const { Buffer } = require("buffer");
globalThis.Buffer = Buffer;

const { Keypair, PublicKey, VersionedTransaction } = require("@solana/web3.js");
const { WebUploader } = require("@irys/web-upload");
const { WebSolana } = require("@irys/web-upload-solana");
const validate = require("./validate.cjs");
const launch = require("./launch.cjs");

const STORE_KEY = "infidrip.launches";
const IMAGE_LIMIT = 2 * 1024 * 1024;

function $(id) {
  return document.getElementById(id);
}

function provider() {
  const phantom = window.phantom && window.phantom.solana;
  if (phantom && phantom.isPhantom) return phantom;
  if (window.solana && window.solana.isPhantom) return window.solana;
  return null;
}

function shortKey(value) {
  const text = String(value || "");
  if (text.length < 12) return text;
  return text.slice(0, 4) + "..." + text.slice(-4);
}

function explain(err) {
  const code = err && (err.code != null ? err.code : err.error && err.error.code);
  const msg = String((err && (err.message || err)) || "");
  const low = msg.toLowerCase();
  if (code === 4001 || low.includes("user rejected") || low.includes("rejected the request")) {
    return "The signature was rejected. Nothing was sent.";
  }
  if (
    low.includes("insufficient") ||
    low.includes("not enough sol") ||
    low.includes("debit an account") ||
    low.includes("insufficient lamports")
  ) {
    return "Not enough SOL in this wallet for the fees and the initial buy.";
  }
  if (
    code === 4900 ||
    low.includes("wrong network") ||
    low.includes("blockhash not found") ||
    low.includes("network mismatch") ||
    low.includes("failed to get recent blockhash")
  ) {
    return "Phantom is on the wrong network. Switch it to match the network selected here.";
  }
  const clean = msg.replace(/[—–]/g, ", ").replace(/\s+/g, " ").trim();
  if (!clean) return "The launch stopped. Nothing was sent.";
  return "The launch stopped. Nothing was sent. " + clean.slice(0, 180);
}

function readForm() {
  const twitter = validate.httpsUrl($("twitter").value);
  const website = validate.httpsUrl($("website").value);
  const buy = validate.parseSolToLamports($("slice").value);
  return {
    name: validate.cleanName($("name").value),
    symbol: validate.cleanSymbol($("ticker").value),
    buyLamports: buy,
    description: $("description").value,
    twitter: twitter,
    website: website,
    chain: document.querySelector("#chains .chip.on")
      ? document.querySelector("#chains .chip.on").getAttribute("data-chain")
      : "Solana",
    cluster: document.querySelector("#networks .chip.on")
      ? document.querySelector("#networks .chip.on").getAttribute("data-net")
      : "mainnet-beta",
    file: $("image-file").files && $("image-file").files[0],
  };
}

function formProblems(form) {
  if (!form.name) return "Enter a name, up to 32 characters.";
  if (!form.symbol) return "Enter a ticker, 1 to 13 letters or numbers.";
  if (form.buyLamports == null) return "Your slice must be a SOL amount, or empty.";
  if (!form.twitter.ok) return "The X link must be an https URL, or empty.";
  if (!form.website.ok) return "The website link must be an https URL, or empty.";
  const description = validate.cleanDescription(form.description);
  if (!description) return "Description is too long.";
  if (form.file && form.file.size > IMAGE_LIMIT) return "Use an image under 2 MB.";
  return "";
}

function defaultImageBlob(ticker) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#4a4a4a";
  ctx.fillRect(0, 0, 512, 512);
  ctx.fillStyle = "#f4f4f4";
  ctx.font = "700 92px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const label = (ticker || "COIN").slice(0, 8);
  ctx.fillText(label, 256, 256);
  return new Promise(function (resolve, reject) {
    canvas.toBlob(function (blob) {
      if (!blob) reject(new Error("Could not prepare the image."));
      else resolve(blob);
    }, "image/png");
  });
}

async function imageBlob(form) {
  if (form.file) return form.file;
  return defaultImageBlob(form.symbol || "COIN");
}

let previewUrl = "";
let previewKey = "";

function setPreview(blob) {
  const img = $("card-image");
  const preview = $("image-preview");
  const url = URL.createObjectURL(blob);
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = url;
  img.hidden = false;
  img.src = url;
  preview.hidden = false;
  preview.src = url;
}

function paintCard(form) {
  const name = form.name || "Name";
  const symbol = form.symbol || "TICKER";
  const slice = form.buyLamports == null ? "0" : launch.formatSol(form.buyLamports);
  $("card-name").textContent = name;
  $("card-ticker").textContent = symbol;
  $("post-name").textContent = name;
  $("card-slice").textContent = slice + " SOL";
  $("card-chain").textContent = form.chain || "Solana";
  const links = $("card-links");
  links.replaceChildren();
  const items = [];
  if (form.twitter && form.twitter.ok && form.twitter.value) items.push(["X", form.twitter.value]);
  if (form.website && form.website.ok && form.website.value) items.push(["Website", form.website.value]);
  if (!form.file) {
    const key = form.symbol || "COIN";
    if (previewKey !== "default:" + key) {
      previewKey = "default:" + key;
      defaultImageBlob(key).then(function (blob) {
        if (previewKey === "default:" + key) setPreview(blob);
      }).catch(function () {});
    }
  }
  if (!items.length) {
    links.hidden = true;
    return;
  }
  links.hidden = false;
  items.forEach(function (item) {
    const a = document.createElement("a");
    a.href = item[1];
    a.textContent = item[0];
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    links.appendChild(a);
  });
}

function loadStored() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    return [];
  }
}

function saveStored(list) {
  localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 20)));
}

function renderFeed() {
  const list = $("feed-list");
  list.replaceChildren();
  loadStored().forEach(function (item) {
    const article = document.createElement("article");
    article.className = "card launched";
    const title = document.createElement("h3");
    title.textContent = item.name || "";
    const ticker = document.createElement("div");
    ticker.className = "ticker";
    ticker.textContent = item.symbol || "";
    const meta = document.createElement("div");
    meta.className = "meta";
    const slice = document.createElement("div");
    const sliceLabel = document.createElement("small");
    sliceLabel.textContent = "Your slice";
    const sliceB = document.createElement("b");
    sliceB.textContent = (item.sliceSol || "0") + " SOL";
    slice.appendChild(sliceLabel);
    slice.appendChild(sliceB);
    const chain = document.createElement("div");
    const chainLabel = document.createElement("small");
    chainLabel.textContent = "Chain";
    const chainB = document.createElement("b");
    chainB.textContent = item.cluster === "devnet" ? "Solana devnet" : "Solana";
    chain.appendChild(chainB);
    meta.appendChild(slice);
    meta.appendChild(chain);
    article.appendChild(title);
    article.appendChild(ticker);
    article.appendChild(meta);
    if (item.twitter) {
      const a = document.createElement("a");
      a.href = item.twitter;
      a.textContent = "X";
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      article.appendChild(a);
    }
    if (item.website) {
      const a = document.createElement("a");
      a.href = item.website;
      a.textContent = "Website";
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      article.appendChild(a);
    }
    if (item.mint) {
      const mint = document.createElement("p");
      mint.className = "mint-line";
      mint.textContent = item.mint;
      article.appendChild(mint);
      const row = document.createElement("p");
      row.className = "result-links";
      if (item.trade) {
        const a = document.createElement("a");
        a.href = item.trade;
        a.textContent = "Trading page";
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        row.appendChild(a);
      }
      if (item.solscan) {
        const a = document.createElement("a");
        a.href = item.solscan;
        a.textContent = "Solscan";
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        row.appendChild(a);
      }
      article.appendChild(row);
    }
    list.appendChild(article);
  });
}

function setStatus(text, isError) {
  const el = $("launch-status");
  el.textContent = text;
  el.classList.toggle("is-error", Boolean(isError));
}

function renderCost(cost) {
  const root = $("cost");
  root.hidden = false;
  const rows = [
    ["Network fee", launch.formatSol(cost.networkFee) + " SOL"],
    ["Account rent, estimate", launch.formatSol(cost.rent) + " SOL"],
    ["Creation fee", "0 SOL"],
    ["Your slice, initial buy", launch.formatSol(cost.buy) + " SOL"],
    ["Curve fee inside that buy", cost.feeText],
    ["Image storage", cost.storageText],
    ["Infidrip fee", "0 SOL"],
    ["Total", launch.formatSol(cost.total) + " SOL"],
  ];
  root.replaceChildren();
  rows.forEach(function (row, index) {
    const line = document.createElement("div");
    if (index === rows.length - 1) line.className = "total";
    const label = document.createElement("span");
    label.textContent = row[0];
    const value = document.createElement("b");
    value.textContent = row[1];
    line.appendChild(label);
    line.appendChild(value);
    root.appendChild(line);
  });
  const note = document.createElement("p");
  note.className = "hint";
  note.textContent = cost.note;
  root.appendChild(note);
}

const state = {
  wallet: null,
  quote: null,
  storageLamports: null,
  storageKnown: false,
};

async function curveFor(cluster) {
  const urls = launch.RPCS[cluster];
  let last;
  for (let i = 0; i < urls.length; i++) {
    try {
      const connection = launch.connectionFor(cluster, urls[i]);
      const loaded = await launch.loadCurve(connection);
      return { connection: connection, global: loaded.global, feeConfig: loaded.feeConfig, rpc: urls[i] };
    } catch (err) {
      last = err;
    }
  }
  throw last || new Error("Could not reach the network.");
}

async function refreshQuote() {
  const form = readForm();
  paintCard(form);
  const problem = formProblems(form);
  const launchBtn = $("launch-btn");
  if (form.chain !== "Solana") {
    setStatus("Coming soon.", false);
    launchBtn.disabled = true;
    return;
  }
  if (problem) {
    setStatus(problem, true);
    launchBtn.disabled = true;
    state.quote = null;
    return;
  }
  try {
    const loaded = await curveFor(form.cluster);
    const rates = launch.feeRates(loaded.global, loaded.feeConfig);
    const rent = await launch.estimateRent(loaded.connection, {
      name: form.name,
      symbol: form.symbol,
      uri: launch.ESTIMATE_URI,
      buyLamports: form.buyLamports,
    });
    const built = await launch.buildLaunchTransaction({
      connection: loaded.connection,
      user: state.wallet || Keypair.generate().publicKey,
      mint: Keypair.generate().publicKey,
      name: form.name,
      symbol: form.symbol,
      uri: launch.ESTIMATE_URI,
      buyLamports: form.buyLamports,
      global: loaded.global,
      feeConfig: loaded.feeConfig,
    });
    const storage = state.storageKnown ? BigInt(state.storageLamports || 0) : 0n;
    const networkFee = BigInt(built.feeLamports);
    const rentTotal = BigInt(rent.total);
    const buy = BigInt(form.buyLamports);
    const total = networkFee + rentTotal + buy + storage;
    const feePct = ((rates.protocolFeeBps + rates.creatorFeeBps + rates.lpFeeBps) / 100).toFixed(2);
    const cost = {
      networkFee: networkFee.toString(),
      rent: rentTotal.toString(),
      buy: buy.toString(),
      storage: storage.toString(),
      total: total.toString(),
      feeText: feePct + "% from the buy (" +
        (rates.protocolFeeBps / 100).toFixed(2) + "% protocol, " +
        (rates.creatorFeeBps / 100).toFixed(2) + "% creator, " +
        (rates.lpFeeBps / 100).toFixed(2) + "% liquidity). Not added on top.",
      storageText: state.storageKnown
        ? launch.formatSol(storage) + " SOL"
        : "Priced after you connect.",
      note: "You pay this. Infidrip does not add a fee. The coins you do not buy stay on the curve, where anyone can trade them.",
      rates: rates,
      rentParts: rent,
      cluster: form.cluster,
      rpc: loaded.rpc,
    };
    state.quote = cost;
    renderCost(cost);
    const devnetNote = $("devnet-note");
    devnetNote.hidden = form.cluster !== "devnet";
    launchBtn.disabled = !state.wallet || !state.storageKnown;
    if (!state.wallet) setStatus("Connect Phantom to price image storage and launch.", false);
    else if (!state.storageKnown) setStatus("Pricing image storage.", false);
    else setStatus("Review the cost, then launch.", false);
  } catch (err) {
    state.quote = null;
    launchBtn.disabled = true;
    setStatus("Could not load the network cost. Nothing was sent.", true);
  }
}

function irysWallet(phantom) {
  return {
    publicKey: phantom.publicKey,
    signTransaction: function (tx) { return phantom.signTransaction(tx); },
    signAllTransactions: function (txs) {
      if (phantom.signAllTransactions) return phantom.signAllTransactions(txs);
      return Promise.all(txs.map(function (tx) { return phantom.signTransaction(tx); }));
    },
    signMessage: async function (message) {
      const result = await phantom.signMessage(message, "utf8");
      if (result instanceof Uint8Array) return result;
      if (result && result.signature instanceof Uint8Array) return result.signature;
      throw new Error("Could not read the signature.");
    },
  };
}

async function priceStorage(form) {
  const phantom = provider();
  if (!phantom || !phantom.publicKey) throw new Error("Phantom is not connected.");
  const blob = await imageBlob(form);
  setPreview(blob);
  const description = validate.cleanDescription(form.description);
  const sample = validate.buildMetadata({
    name: form.name,
    symbol: form.symbol,
    description: description,
    image: launch.ESTIMATE_URI,
    twitter: form.twitter.value,
    website: form.website.value,
  });
  const jsonBytes = Buffer.byteLength(JSON.stringify(sample));
  let builder = WebUploader(WebSolana).withProvider(irysWallet(phantom)).withRpc(launch.endpointFor(form.cluster));
  builder = form.cluster === "devnet" ? builder.devnet() : builder.mainnet();
  const irys = await builder;
  const imagePrice = await irys.getPrice(blob.size);
  const jsonPrice = await irys.getPrice(jsonBytes);
  const storage = BigInt(imagePrice.toString(10)) + BigInt(jsonPrice.toString(10));
  state.storageLamports = storage.toString();
  state.storageKnown = true;
  state.irys = irys;
  state.imageBlob = blob;
  return storage;
}

async function connect() {
  const phantom = provider();
  if (!phantom) {
    setStatus("Phantom is not installed.", true);
    return;
  }
  try {
    await phantom.connect();
  } catch (err) {
    setStatus(explain(err), true);
    return;
  }
  state.wallet = phantom.publicKey;
  $("connect-btn").textContent = "Phantom " + shortKey(phantom.publicKey.toBase58());
  setStatus("Pricing image storage.", false);
  try {
    await priceStorage(readForm());
  } catch (err) {
    state.storageKnown = false;
    setStatus(explain(err), true);
  }
  await refreshQuote();
}

async function ensureStorage(form, quote) {
  const blob = state.imageBlob || await imageBlob(form);
  const description = validate.cleanDescription(form.description);
  const placeholder = validate.buildMetadata({
    name: form.name,
    symbol: form.symbol,
    description: description,
    image: launch.ESTIMATE_URI,
    twitter: form.twitter.value,
    website: form.website.value,
  });
  const jsonSize = Buffer.byteLength(JSON.stringify(placeholder));
  const irys = state.irys;
  const imagePrice = BigInt((await irys.getPrice(blob.size)).toString(10));
  const jsonPrice = BigInt((await irys.getPrice(jsonSize)).toString(10));
  const needed = imagePrice + jsonPrice;
  state.storageLamports = needed.toString();
  state.storageKnown = true;
  const balance = BigInt((await irys.getLoadedBalance()).toString(10));
  if (balance < needed) {
    const connection = launch.connectionFor(form.cluster, quote.rpc);
    const walletBalance = BigInt(await connection.getBalance(state.wallet));
    const rest = BigInt(quote.networkFee) + BigInt(quote.rent) + BigInt(quote.buy);
    if (walletBalance < needed + rest + 20000n) {
      throw Object.assign(new Error("insufficient"), { code: "insufficient" });
    }
    setStatus("Confirm image storage in Phantom.", false);
    await irys.fund(needed.toString());
  }
  setStatus("Storing the image and details.", false);
  const imageFile = blob instanceof File ? blob : new File([blob], "coin.png", { type: "image/png" });
  const imageReceipt = await irys.uploadFile(imageFile);
  const imageUri = "https://gateway.irys.xyz/" + imageReceipt.id;
  const meta = validate.buildMetadata({
    name: form.name,
    symbol: form.symbol,
    description: description,
    image: imageUri,
    twitter: form.twitter.value,
    website: form.website.value,
  });
  const jsonFile = new File([JSON.stringify(meta)], "metadata.json", { type: "application/json" });
  const metaReceipt = await irys.uploadFile(jsonFile);
  const metadataUri = "https://gateway.irys.xyz/" + metaReceipt.id;
  if (metadataUri.length > 200) throw new Error("The metadata link is too long.");
  return { metadataUri: metadataUri, imageUri: imageUri, meta: meta };
}

function showResult(result) {
  const box = $("result");
  box.hidden = false;
  $("result-mint").textContent = result.mint;
  const trade = $("result-trade");
  if (result.trade) {
    trade.hidden = false;
    trade.href = result.trade;
  } else {
    trade.hidden = true;
  }
  const scan = $("result-solscan");
  scan.href = result.solscan;
  $("devnet-result").hidden = result.cluster !== "devnet";
}

async function onLaunch(event) {
  event.preventDefault();
  const form = readForm();
  const problem = formProblems(form);
  if (form.chain !== "Solana") {
    setStatus("Coming soon.", false);
    return;
  }
  if (problem) {
    setStatus(problem, true);
    return;
  }
  const phantom = provider();
  if (!phantom) {
    setStatus("Phantom is not installed.", true);
    return;
  }
  if (!state.wallet) {
    await connect();
    return;
  }
  if (!state.storageKnown || !state.quote) {
    setStatus("The cost is not ready. Nothing was sent.", true);
    return;
  }
  const button = $("launch-btn");
  button.disabled = true;
  try {
    const connection = launch.connectionFor(form.cluster, state.quote.rpc);
    const loaded = await launch.loadCurve(connection);
    const stored = await ensureStorage(form, state.quote);
    const mintKey = Keypair.generate();
    const built = await launch.buildLaunchTransaction({
      connection: connection,
      user: state.wallet,
      mint: mintKey.publicKey,
      name: form.name,
      symbol: form.symbol,
      uri: stored.metadataUri,
      buyLamports: form.buyLamports,
      global: loaded.global,
      feeConfig: loaded.feeConfig,
    });
    const rent = await launch.estimateRent(connection, {
      name: form.name,
      symbol: form.symbol,
      uri: stored.metadataUri,
      buyLamports: form.buyLamports,
    });
    const total = BigInt(built.feeLamports) + BigInt(rent.total) + BigInt(form.buyLamports);
    const balance = BigInt(await connection.getBalance(state.wallet));
    if (balance < total) {
      setStatus("Not enough SOL in this wallet for the fees and the initial buy.", true);
      return;
    }
    setStatus("Confirm the launch in Phantom.", false);
    built.tx.sign([mintKey]);
    const signed = await phantom.signTransaction(built.tx);
    const raw = signed instanceof VersionedTransaction ? signed : built.tx;
    const signature = await connection.sendRawTransaction(raw.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction({
      signature: signature,
      blockhash: built.blockhash,
      lastValidBlockHeight: built.lastValidBlockHeight,
    }, "confirmed");
    const mint = mintKey.publicKey.toBase58();
    const result = {
      name: form.name,
      symbol: form.symbol,
      sliceSol: launch.formatSol(form.buyLamports),
      cluster: form.cluster,
      mint: mint,
      signature: signature,
      twitter: form.twitter.value,
      website: form.website.value,
      image: stored.imageUri,
      trade: launch.tradingPageUrl(form.cluster, mint),
      solscan: launch.solscanUrl(form.cluster, mint),
    };
    const list = loadStored();
    list.unshift(result);
    saveStored(list);
    renderFeed();
    showResult(result);
    setStatus("Launched. The coin can be traded on the curve.", false);
  } catch (err) {
    if (err && err.code === "insufficient") {
      setStatus("Not enough SOL in this wallet for the fees and the initial buy.", true);
    } else {
      setStatus(explain(err), true);
    }
  } finally {
    button.disabled = false;
  }
}

let quoteTimer = 0;
function scheduleQuote() {
  state.storageKnown = false;
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(function () {
    refreshQuote().then(function () {
      if (!state.wallet) return null;
      return priceStorage(readForm()).then(function () { return refreshQuote(); });
    }).catch(function (err) {
      setStatus(explain(err), true);
    });
  }, 350);
}

function bind() {
  ["name", "ticker", "slice", "description", "twitter", "website"].forEach(function (id) {
    $(id).addEventListener("input", scheduleQuote);
  });
  $("image-file").addEventListener("change", function () {
    const file = $("image-file").files && $("image-file").files[0];
    if (file) {
      previewKey = "file";
      setPreview(file);
    } else {
      previewKey = "";
    }
    scheduleQuote();
  });
  $("chains").addEventListener("click", function (event) {
    const button = event.target.closest("button");
    if (!button) return;
    document.querySelectorAll("#chains .chip").forEach(function (node) {
      node.classList.toggle("on", node === button);
    });
    refreshQuote();
  });
  $("networks").addEventListener("click", function (event) {
    const button = event.target.closest("button");
    if (!button) return;
    document.querySelectorAll("#networks .chip").forEach(function (node) {
      node.classList.toggle("on", node === button);
    });
    state.storageKnown = false;
    state.irys = null;
    scheduleQuote();
  });
  $("connect-btn").addEventListener("click", function () { connect(); });
  $("launch-form").addEventListener("submit", onLaunch);
  const phantom = provider();
  if (phantom) {
    phantom.connect({ onlyIfTrusted: true }).then(function () {
      state.wallet = phantom.publicKey;
      $("connect-btn").textContent = "Phantom " + shortKey(phantom.publicKey.toBase58());
      return priceStorage(readForm());
    }).then(function () {
      return refreshQuote();
    }).catch(function () {
      refreshQuote();
    });
  } else {
    refreshQuote();
  }
  renderFeed();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bind);
} else {
  bind();
}
