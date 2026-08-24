import * as assert from "assert";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { it as test } from "mocha";

import { repoRoot } from "./helpers";

test("contract sync requires an explicit local source and copies exact bytes", () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "obs-node-contract-")
  );
  const target = path.join(workspace, "target");
  const source = path.join(workspace, "source");
  fs.mkdirSync(path.join(target, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(source, "golden"), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot(), "scripts", "sync-contract.mjs"),
    path.join(target, "scripts", "sync-contract.mjs")
  );

  const contract = "version: 9.9.9\nmetrics: []\n";
  const golden = "sample_metric{service}\n";
  fs.writeFileSync(path.join(source, "metrics-contract.yaml"), contract);
  fs.writeFileSync(path.join(source, "golden", "metrics.txt"), golden);

  const missing = spawnSync(process.execPath, ["scripts/sync-contract.mjs"], {
    cwd: target,
    encoding: "utf8",
  });
  assert.notStrictEqual(missing.status, 0);

  const synced = spawnSync(
    process.execPath,
    ["scripts/sync-contract.mjs", "--source", source],
    { cwd: target, encoding: "utf8" }
  );
  assert.strictEqual(synced.status, 0, synced.stderr);
  assert.strictEqual(
    fs.readFileSync(
      path.join(target, "contract", "metrics-contract.yaml"),
      "utf8"
    ),
    contract
  );
  assert.strictEqual(
    fs.readFileSync(
      path.join(target, "contract", "golden", "metrics.txt"),
      "utf8"
    ),
    golden
  );
  assert.match(
    synced.stdout,
    new RegExp(crypto.createHash("sha256").update(contract).digest("hex"))
  );
  assert.match(
    synced.stdout,
    new RegExp(crypto.createHash("sha256").update(golden).digest("hex"))
  );

  fs.rmSync(workspace, { recursive: true, force: true });
});
