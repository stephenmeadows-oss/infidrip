import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "./canonical.js";
import { ReceiptError, type InMemoryBundle, type StoredRuleset } from "./receipt.js";

/**
 * On-disk export a verifier can read with no network.
 * entries.jsonl and checkpoints.jsonl are one canonical JSON object per line.
 * proof.json is the small file a UI can offer as a download.
 * rulesets/ holds each signed (or, for a deny, hashed) ruleset body.
 * keys.json holds log public keys and the owner rules public key.
 * anchors/ is reserved for milestone M5 and is not read.
 */
export function writeBundle(dir: string, bundle: InMemoryBundle): void {
  mkdirSync(join(dir, "rulesets"), { recursive: true });
  writeFileSync(join(dir, "entries.jsonl"), jsonl(bundle.entries));
  writeFileSync(join(dir, "checkpoints.jsonl"), jsonl(bundle.checkpoints));
  writeFileSync(join(dir, "keys.json"), pretty(bundle.keys));
  writeFileSync(join(dir, "proof.json"), pretty(bundle.proof));
  for (const ruleset of bundle.rulesets) {
    if (!/^[0-9a-f]{64}$/.test(ruleset.body_hash)) {
      throw new ReceiptError("Ruleset body hash is not 32 bytes of lowercase hex.");
    }
    writeFileSync(join(dir, "rulesets", `${ruleset.body_hash}.json`), pretty(ruleset));
  }
}

export interface BundleRead {
  bundle: InMemoryBundle | null;
  errors: string[];
  notes: string[];
}

export function readBundle(dir: string): BundleRead {
  const errors: string[] = [];
  const notes: string[] = [];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { bundle: null, errors: [`Bundle directory is missing: ${dir}`], notes };
  }
  const anchorDir = join(dir, "anchors");
  if (existsSync(anchorDir)) {
    notes.push("Anchors are present and were not checked.");
  }
  const entries = readJsonl(join(dir, "entries.jsonl"), errors);
  const checkpoints = readJsonl(join(dir, "checkpoints.jsonl"), errors);
  const keys = readJson(join(dir, "keys.json"), errors);
  const proof = readJson(join(dir, "proof.json"), errors);
  const rulesets = readRulesets(join(dir, "rulesets"), errors);
  if (errors.length > 0 || !keys || !proof) {
    return { bundle: null, errors, notes };
  }
  return {
    bundle: {
      entries: entries as InMemoryBundle["entries"],
      checkpoints: checkpoints as InMemoryBundle["checkpoints"],
      rulesets,
      keys: keys as InMemoryBundle["keys"],
      proof: proof as InMemoryBundle["proof"],
    },
    errors,
    notes,
  };
}

function jsonl(rows: readonly unknown[]): string {
  if (rows.length === 0) return "";
  const lines = rows.map((row) => {
    const line = canonicalJson(row);
    if (line === null) throw new ReceiptError("Bundle value cannot be canonicalized.");
    return line;
  });
  return `${lines.join("\n")}\n`;
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJsonl(path: string, errors: string[]): unknown[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    errors.push(`Missing bundle file: ${path}`);
    return [];
  }
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const rows: unknown[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      errors.push(`Blank line in ${path} at line ${i + 1}.`);
      return rows;
    }
    try {
      rows.push(JSON.parse(line) as unknown);
    } catch {
      errors.push(`Invalid JSON in ${path} at line ${i + 1}.`);
      return rows;
    }
  }
  return rows;
}

function readJson(path: string, errors: string[]): unknown | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    errors.push(`Missing bundle file: ${path}`);
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    errors.push(`Invalid JSON in ${path}.`);
    return null;
  }
}

function readRulesets(dir: string, errors: string[]): StoredRuleset[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  } catch {
    errors.push(`Ruleset directory cannot be read: ${dir}`);
    return [];
  }
  const rulesets: StoredRuleset[] = [];
  for (const name of names) {
    const parsed = readJson(join(dir, name), errors);
    if (!parsed || typeof parsed !== "object") continue;
    rulesets.push(parsed as StoredRuleset);
  }
  return rulesets;
}
