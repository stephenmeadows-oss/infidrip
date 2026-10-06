import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
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
  const live = `${sep}turnkey${sep}live.ts`;
  const sources = filesUnder(join(root, "src")).filter((path) => path.endsWith(".ts"));
  assert.ok(sources.length > 0);
  const liveFiles = sources.filter((path) => path.endsWith(live));
  assert.equal(liveFiles.length, 1);
  for (const path of sources) {
    const text = readFileSync(path, "utf8");
    if (path.endsWith(live)) {
      assert.equal(banned.test(text), true, path);
      continue;
    }
    assert.equal(banned.test(text), false, path);
  }
  for (const name of ["evaluate.ts", "receipt.ts", "verify.ts"]) {
    const text = readFileSync(join(root, "src", name), "utf8");
    assert.equal(text.includes("turnkey/live"), false, name);
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
