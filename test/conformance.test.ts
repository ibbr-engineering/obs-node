import * as assert from "assert";
import * as fs from "fs";
import { it as test } from "mocha";
import * as yaml from "js-yaml";

import { initObservability } from "../src/index";
import { CONTRACT_VERSION, DURATION_BUCKETS } from "../src/contract";
import { contractPath, fakeRes, goldenPath, shapeOf } from "./helpers";

interface ContractFile {
  version: string;
  metrics: Array<{
    name: string;
    type: string;
    labels: string[];
    buckets?: number[];
    optional?: boolean;
  }>;
  constraints: { max_routes_per_service: number; overflow_label: string };
}

function loadContract(): ContractFile {
  return yaml.load(fs.readFileSync(contractPath(), "utf8")) as ContractFile;
}

async function exerciseSampleApp(): Promise<string> {
  const obs = initObservability({
    service: "conformance-app",
    version: "1.2.3",
    commit: "abc1234",
    tier: "T1",
    transport: "scrape",
    defaultMetrics: false,
    logger: () => undefined,
  });

  const mw = obs.middleware();
  for (const [path, status] of [
    ["/api/patients/507f1f77bcf86cd799439011", 200],
    ["/api/patients", 500],
    ["/api/reports/2026/08", 404],
  ] as Array<[string, number]>) {
    const res = fakeRes(status);
    mw({ method: "GET", url: path, originalUrl: path }, res, () => undefined);
    res.emit("finish");
  }

  await obs.time(
    { dependency: "mongodb", operation: "find" },
    async () => "ok"
  );

  const tight = initObservability({
    service: "conformance-app",
    tier: "T1",
    maxRoutes: 2,
    defaultMetrics: false,
    logger: () => undefined,
  });
  const tightMw = tight.middleware();
  for (const path of ["/a", "/b", "/c"]) {
    const res = fakeRes(200);
    tightMw(
      { method: "GET", url: path, originalUrl: path },
      res,
      () => undefined
    );
    res.emit("finish");
  }
  const overflowShapes = await tight.render();
  tight.shutdown();

  const main = await obs.render();
  obs.shutdown();
  return `${main}\n${overflowShapes}`;
}

test("library contract version matches the YAML snapshot", () => {
  assert.strictEqual(CONTRACT_VERSION, loadContract().version);
});

test("golden file contains every required contract metric", () => {
  const goldenNames = new Set(
    fs
      .readFileSync(goldenPath(), "utf8")
      .trim()
      .split("\n")
      .map((shape) => shape.split("{")[0].replace(/_(bucket|sum|count)$/, ""))
  );

  for (const metric of loadContract().metrics) {
    if (metric.optional) continue;
    assert.ok(
      goldenNames.has(metric.name),
      `golden file is missing "${metric.name}"`
    );
  }
});

test("histogram buckets exactly match the contract", () => {
  const contract = loadContract();
  const duration = contract.metrics.find(
    (m) => m.name === "http_server_duration_seconds"
  );
  assert.ok(duration?.buckets, "contract must define duration buckets");
  assert.deepStrictEqual([...DURATION_BUCKETS], duration.buckets);
});

test("every required contract metric is emitted by the registry", async () => {
  const exposition = await exerciseSampleApp();
  const emitted = new Set(shapeOf(exposition).map((s) => s.split("{")[0]));

  for (const metric of loadContract().metrics) {
    if (metric.optional && !emitted.has(metric.name)) continue;

    const present =
      emitted.has(metric.name) ||
      emitted.has(`${metric.name}_bucket`) ||
      emitted.has(`${metric.name}_count`);

    assert.ok(present, `contract metric "${metric.name}" was not emitted`);
  }
});

test("metric label keys exactly match the contract", async () => {
  const exposition = await exerciseSampleApp();
  const contract = loadContract();

  for (const shape of shapeOf(exposition)) {
    const [name, rest] = shape.split("{");
    const keys = rest.replace("}", "").split(",").filter(Boolean);

    const base = name.replace(/_(bucket|sum|count)$/, "");
    const spec = contract.metrics.find(
      (m) => m.name === base || m.name === name
    );
    if (!spec) continue;

    const allowed = new Set(spec.labels);
    if (name.endsWith("_bucket")) allowed.add("le");

    for (const key of keys) {
      assert.ok(
        allowed.has(key),
        `label "${key}" on "${name}" is not allowed by the contract (${[
          ...allowed,
        ].join(", ")})`
      );
    }
  }
});

test("metric exposition shapes match the golden file", async () => {
  const exposition = await exerciseSampleApp();
  const actual = shapeOf(exposition).filter(
    (s) => !s.startsWith("nodejs_") && !s.startsWith("process_")
  );

  const golden = goldenPath();
  if (process.env.UPDATE_GOLDEN === "1") {
    fs.writeFileSync(golden, `${actual.join("\n")}\n`);
    return;
  }

  assert.ok(
    fs.existsSync(golden),
    "golden file is missing; create it with UPDATE_GOLDEN=1 npm test"
  );
  const expected = fs.readFileSync(golden, "utf8").trim().split("\n");
  assert.deepStrictEqual(
    actual,
    expected,
    "metric shapes changed; update the contract version before regenerating the golden file"
  );
});
