"use strict";

const DEFAULT_DESCRIPTION = "A new coin.";
const MAX_NAME = 32;
const MAX_SYMBOL = 13;
const MAX_DESCRIPTION = 200;
const MAX_URL = 300;

function cleanName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > MAX_NAME) return null;
  if (/[\u0000-\u001f]/.test(name)) return null;
  return name;
}

function cleanSymbol(value) {
  const symbol = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{1,13}$/.test(symbol)) return null;
  if (symbol.length > MAX_SYMBOL) return null;
  return symbol;
}

function parseSolToLamports(value) {
  const raw = String(value ?? "").trim();
  if (raw === "") return 0n;
  if (!/^\d+(\.\d{1,9})?$/.test(raw)) return null;
  const parts = raw.split(".");
  const whole = parts[0];
  const frac = parts[1] || "";
  const lamports = BigInt(whole) * 1000000000n + BigInt((frac + "000000000").slice(0, 9));
  if (lamports > 1000n * 1000000000n) return null;
  return lamports;
}

function httpsUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return { ok: true, value: "" };
  if (raw.length > MAX_URL) return { ok: false, value: "" };
  let url;
  try {
    url = new URL(raw);
  } catch (err) {
    return { ok: false, value: "" };
  }
  if (url.protocol !== "https:") return { ok: false, value: "" };
  if (url.username || url.password) return { ok: false, value: "" };
  if (!url.hostname || url.hostname.indexOf(".") === -1) return { ok: false, value: "" };
  return { ok: true, value: url.toString() };
}

function cleanDescription(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return DEFAULT_DESCRIPTION;
  if (text.length > MAX_DESCRIPTION) return null;
  return text;
}

function buildMetadata(fields) {
  const description = cleanDescription(fields.description);
  if (!description) {
    throw new Error("Description is too long.");
  }
  const meta = {
    name: fields.name,
    symbol: fields.symbol,
    description: description,
    image: fields.image,
    showName: true,
  };
  if (fields.twitter) meta.twitter = fields.twitter;
  if (fields.website) meta.website = fields.website;
  return meta;
}

module.exports = {
  DEFAULT_DESCRIPTION,
  MAX_DESCRIPTION,
  cleanName,
  cleanSymbol,
  parseSolToLamports,
  httpsUrl,
  cleanDescription,
  buildMetadata,
};
