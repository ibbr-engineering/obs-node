import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { it as test } from "mocha";

import { repoRoot } from "./helpers";

test("package exports resolve to JavaScript and declarations in the tarball", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "obs-node-pack-"));
  const output = execFileSync("npm", ["pack", repoRoot(), "--silent"], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_cache: path.join(workspace, ".npm-cache"),
    },
  });
  const lines = output.trim().split("\n");
  const filename = lines[lines.length - 1];
  assert.ok(filename);
  const tarball = path.join(workspace, filename);
  execFileSync("tar", ["-xzf", tarball], { cwd: workspace });

  const packageRoot = path.join(workspace, "package");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")
  ) as {
    exports: Record<string, { types: string; default: string }>;
  };

  for (const exportPath of [".", "./express", "./loopback3", "./loopback4"]) {
    const entry = manifest.exports[exportPath];
    assert.ok(entry, `missing export ${exportPath}`);
    assert.ok(
      fs.existsSync(path.join(packageRoot, entry.default)),
      `missing ${entry.default}`
    );
    assert.ok(
      fs.existsSync(path.join(packageRoot, entry.types)),
      `missing ${entry.types}`
    );
  }

  assert.strictEqual(fs.existsSync(path.join(packageRoot, "test")), false);
  assert.strictEqual(fs.existsSync(path.join(packageRoot, "contract")), false);
  fs.rmSync(workspace, { recursive: true, force: true });
});
