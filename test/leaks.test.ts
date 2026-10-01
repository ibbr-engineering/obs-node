import * as assert from "assert";
import * as http from "http";
import * as net from "net";
import * as zlib from "zlib";
import { it as test } from "mocha";

import { initObservability, OVERFLOW_ROUTE } from "../src/index";
import { instrumentLoopback4 } from "../src/adapters/loopback4";
import { OtlpPusher } from "../src/otlp";
import { compileRouterTable, RouteNormalizer } from "../src/routes";
import { Counter, Registry } from "prom-client";
import { fakeRes } from "./helpers";

const base = {
  service: "leak-test",
  tier: "T1" as const,
  defaultMetrics: false,
  logger: () => undefined,
};

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as net.AddressInfo).port)
    )
  );
}

function registryWithOneSeries(): Registry {
  const registry = new Registry();
  new Counter({ name: "x_total", help: "x", registers: [registry] }).inc();
  return registry;
}

test("time() caps distinct dependency/operation pairs", async () => {
  const obs = initObservability({ ...base, maxDependencySeries: 5 });
  for (let i = 0; i < 500; i++) {
    await obs.time(
      { dependency: "mongo", operation: `find_${i}` },
      async () => 1
    );
  }
  const json = await obs.metrics.registry.getMetricsAsJSON();
  const dependency = json.find((m) => m.name === "dependency_duration_seconds");
  const operations = new Set(
    dependency?.values.map((v) => String(v.labels.operation))
  );
  assert.strictEqual(operations.size, 6);
  assert.ok(operations.has(OVERFLOW_ROUTE));
  await obs.shutdown();
});

test("default runtime collectors are created once per process", async () => {
  const a = initObservability({ ...base, defaultMetrics: true });
  const b = initObservability({ ...base, defaultMetrics: true });
  const name = "process_cpu_user_seconds_total";
  const metricA = a.metrics.registry.getSingleMetric(name);
  assert.ok(metricA);
  assert.strictEqual(metricA, b.metrics.registry.getSingleMetric(name));
  await a.shutdown();
  await b.shutdown();
  assert.strictEqual(a.metrics.registry.getMetricsAsArray().length, 0);
});

test("OTLP push settles when the collector resets mid-body", async () => {
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n0123456789");
      setTimeout(() => socket.destroy(), 20);
    });
  });
  const port = await listen(server);
  const pusher = new OtlpPusher({
    endpoint: `http://127.0.0.1:${port}`,
    registry: registryWithOneSeries(),
    intervalMs: 60_000,
    serviceName: "t",
  });
  const started = Date.now();
  await assert.rejects(pusher.pushOnce());
  assert.ok(Date.now() - started < 2_000);
  server.close();
});

test("OTLP pushes never overlap and bodies are gzip-encoded", async () => {
  const received: Array<{ encoding?: string; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const encoding = req.headers["content-encoding"];
      const text = encoding === "gzip" ? zlib.gunzipSync(raw) : raw;
      received.push({ encoding, body: JSON.parse(text.toString()) });
      setTimeout(() => res.end(), 50);
    });
  });
  const port = await listen(server);
  const pusher = new OtlpPusher({
    endpoint: `http://127.0.0.1:${port}`,
    registry: registryWithOneSeries(),
    intervalMs: 60_000,
    serviceName: "t",
  });

  await Promise.all([pusher.pushOnce(), pusher.pushOnce(), pusher.pushOnce()]);
  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].encoding, "gzip");
  assert.ok((received[0].body as any).resourceMetrics);
  server.close();
});

test("shutdown performs a final push", async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    req.resume();
    req.on("end", () => res.end());
  });
  const port = await listen(server);
  const obs = initObservability({
    ...base,
    transport: "push",
    otlpEndpoint: `http://127.0.0.1:${port}`,
    pushIntervalMs: 60_000,
  });
  await obs.shutdown();
  await obs.shutdown();
  assert.strictEqual(requests, 1);
  server.close();
});

test("static routes win over params regardless of declaration order", () => {
  const table = compileRouterTable([
    { method: "GET", template: "/api/Patients/:id" },
    { method: "GET", template: "/api/Patients/count" },
    { method: "GET", template: "/api/files/:name.json" },
  ]);
  assert.strictEqual(
    table.match("GET", "/api/Patients/count"),
    "/api/Patients/count"
  );
  assert.strictEqual(
    table.match("GET", "/api/Patients/abc"),
    "/api/Patients/:id"
  );
  assert.strictEqual(
    table.match("GET", "/api/files/a.json"),
    "/api/files/:name.json"
  );
  assert.strictEqual(table.match("GET", "/api/files/axjson"), undefined);
  assert.strictEqual(table.match("POST", "/api/Patients/abc"), undefined);
});

test("LoopBack 4 router table ignores non-verb path item keys", async () => {
  let obsMiddleware: any;
  const app = {
    restServer: {
      getApiSpec: async () => ({
        paths: {
          "/api/Patients/{id}": { get: {}, parameters: [] },
          "/api/Patients/count": { get: {} },
        },
      }),
    },
    expressMiddleware: (factory: any) => (obsMiddleware = factory()),
    controller: () => undefined,
  };
  const obs = await instrumentLoopback4(app, base);
  assert.ok(obsMiddleware);
  assert.strictEqual(
    obs.normalizer.normalize("GET", "/api/Patients/count"),
    "/api/Patients/count"
  );
  assert.strictEqual(
    obs.normalizer.normalize("PARAMETERS", "/api/Patients/1"),
    "/api/Patients/:n"
  );
  await obs.shutdown();
});

test("404 scanners cannot evict real routes into __other__", () => {
  const n = new RouteNormalizer({
    maxRoutes: 50,
    routerTable: {
      match: (_m, p) => (p === "/api/real" ? "/api/real" : undefined),
    },
  });
  for (let i = 0; i < 5_000; i++) n.normalize("GET", `/wp-admin/x${i}.php`);
  assert.ok(n.cardinality <= 1 + 5);
  assert.strictEqual(n.normalize("GET", "/api/real"), "/api/real");
});

test("PHI-shaped templates become __other__ instead of dropping the label", () => {
  const n = new RouteNormalizer({ maxRoutes: 10 });
  assert.strictEqual(
    n.normalize("GET", "/users/a.b@example.com"),
    OVERFLOW_ROUTE
  );
});

async function recordOne(req: any, res: any, chunk?: string): Promise<string> {
  const obs = initObservability(base);
  res.write = () => true;
  res.end = () => true;
  obs.middleware()(req, res, () => undefined);
  if (chunk) res.end(chunk);
  res.emit("finish");
  const body = await obs.render();
  await obs.shutdown();
  return body;
}

test("unknown HTTP methods are bucketed as OTHER", async () => {
  const body = await recordOne({ method: "PROPFIND", url: "/x" }, fakeRes(200));
  assert.match(body, /method="OTHER"/);
});

test("declared Content-Length replaces per-chunk byte counting", async () => {
  const res = fakeRes(200);
  res.getHeader = (name: string) =>
    name === "content-length" ? "1234" : undefined;
  const body = await recordOne({ method: "GET", url: "/x" }, res, "x");
  assert.match(body, /http_server_response_bytes_total\{[^}]*\} 1234/);
});

test("a failure while recording never escapes the response event", async () => {
  const obs = initObservability(base);
  const res = fakeRes(200);
  Object.defineProperty(res, "statusCode", {
    get() {
      throw new Error("boom");
    },
  });
  obs.middleware()({ method: "GET", url: "/x" }, res, () => undefined);
  assert.doesNotThrow(() => res.emit("finish"));
  await obs.shutdown();
});

test("config rejects invalid new limits", () => {
  for (const bad of [{ maxDependencySeries: 0 }, { maxUnmatchedRoutes: 1.5 }]) {
    assert.throws(() => initObservability({ ...base, ...bad }));
  }
  assert.throws(() =>
    initObservability({ ...base, otlpCompression: "brotli" as any })
  );
});

test("single-shot bodies reuse Node's measured length", async () => {
  const obs = initObservability(base);
  const measure = obs.middleware();
  const server = http.createServer((req, res) =>
    measure(req, res, () => res.end("héllo wörld"))
  );
  const port = await listen(server);
  // Explicit IPv4 host: Node 18 resolves "localhost" to ::1 without fallback.
  await new Promise<void>((resolve, reject) =>
    http
      .get({ host: "127.0.0.1", port, path: "/x" }, (r) => {
        r.resume();
        r.on("end", () => resolve());
      })
      .on("error", reject)
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const body = await obs.render();
  assert.match(body, /http_server_response_bytes_total\{[^}]*\} 13/);
  server.close();
  await obs.shutdown();
});
