import { verifyDirectory } from "./verify.js";

/**
 * Offline verifier CLI.
 * Usage: agent-guard verify <bundle-dir> [--expect-head <hex>] [--expect-size <count>] [--json]
 * Exit 0 when the log checks out, 1 when it does not, 2 when the arguments are wrong.
 */
export function main(argv: string[]): number {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    writeUsage();
    return argv.length === 0 ? 2 : 0;
  }
  if (argv[0] !== "verify") {
    writeUsage();
    return 2;
  }
  const dir = argv[1];
  if (!dir || dir.startsWith("--")) {
    writeUsage();
    return 2;
  }
  let expectedHeadHash: string | undefined;
  let expectedTreeSize: number | undefined;
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--json") continue;
    if (flag === "--expect-head") {
      const value = argv[i + 1];
      if (!value) {
        writeUsage();
        return 2;
      }
      expectedHeadHash = value;
      i += 1;
      continue;
    }
    if (flag === "--expect-size") {
      const value = argv[i + 1];
      if (!value || !/^[0-9]+$/.test(value)) {
        writeUsage();
        return 2;
      }
      expectedTreeSize = Number(value);
      i += 1;
      continue;
    }
    writeUsage();
    return 2;
  }
  const report = verifyDirectory(dir, { expectedHeadHash, expectedTreeSize });
  process.stdout.write(`${report.summary}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

function writeUsage(): void {
  process.stderr.write(
    "Usage: agent-guard verify <bundle-dir> [--expect-head <hex>] [--expect-size <count>] [--json]\n",
  );
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("cli.ts") || entry.endsWith("cli.js")) {
  process.exit(main(process.argv.slice(2)));
}
