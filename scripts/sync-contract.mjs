import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const sourceIndex = args.indexOf("--source");
if (sourceIndex === -1 || !args[sourceIndex + 1] || args.length !== 2) {
  throw new Error("usage: npm run contract:sync -- --source <local-directory>");
}

const sourceArg = args[sourceIndex + 1];
if (sourceArg.includes("://")) {
  throw new Error("contract source must be a local directory");
}

const sourceRoot = resolve(sourceArg);
if (!statSync(sourceRoot).isDirectory()) {
  throw new Error("contract source must be a local directory");
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  ["metrics-contract.yaml", "contract/metrics-contract.yaml"],
  ["golden/metrics.txt", "contract/golden/metrics.txt"],
];

for (const [sourceName, targetName] of files) {
  const source = join(sourceRoot, sourceName);
  const target = join(repoRoot, targetName);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  const checksum = createHash("sha256")
    .update(readFileSync(target))
    .digest("hex");
  process.stdout.write(`${checksum}  ${targetName}\n`);
}
