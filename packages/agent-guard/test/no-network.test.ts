import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

test("engine source does not open sockets or call a price service", () => {
  const banned =
    /\b(fetch|axios|WebSocket|XMLHttpRequest|undici)\b|node:(http|https|net|dgram|tls)|http\.request|https\.request|net\.connect/;
  const sources = filesUnder(join(root, "src")).filter((path) => path.endsWith(".ts"));
  assert.ok(sources.length > 0);
  for (const path of sources) {
    const text = readFileSync(path, "utf8");
    assert.equal(banned.test(text), false, path);
  }
});

test("package text does not use an em dash", () => {
  const emdash = "\u2014";
  const paths = [
    ...filesUnder(join(root, "src")),
    ...filesUnder(join(root, "test")),
    ...filesUnder(join(root, "schema")),
    join(root, "README.md"),
    join(root, "package.json"),
  ];
  for (const path of paths) {
    assert.equal(readFileSync(path, "utf8").includes(emdash), false, path);
  }
});
