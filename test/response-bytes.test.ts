import * as assert from "assert";
import * as http from "http";
import { it as test } from "mocha";
import { initObservability } from "../src/index";

async function measure(handler: (req: any, res: any) => void): Promise<string> {
  const obs = initObservability({
    service: "bytes-test",
    tier: "T1",
    env: "test",
    defaultMetrics: false,
    logger: () => {},
  });
  const measured = obs.middleware();

  const server = http.createServer((req, res) => {
    measured(req, res, () => handler(req, res));
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  await new Promise<void>((resolve, reject) => {
    http
      .get({ port, path: "/x" }, (res) => {
        res.resume();
        res.on("end", () => resolve());
      })
      .on("error", reject);
  });

  const body = await obs.render();
  server.close();
  obs.shutdown();
  return body;
}

function bytesFrom(exposition: string): number {
  const line = exposition
    .split("\n")
    .find((l) => l.startsWith("http_server_response_bytes_total{"));
  assert.ok(line, `metric is missing:\n${exposition}`);
  return Number(line.slice(line.lastIndexOf(" ") + 1));
}

test("response bytes are counted for an ordinary body", async () => {
  const payload = "halo dunia";
  const body = await measure((_req, res) => {
    res.statusCode = 200;
    res.end(payload);
  });
  assert.strictEqual(bytesFrom(body), Buffer.byteLength(payload));
});

test("response bytes are counted for chunked output without Content-Length", async () => {
  const chunks = ["satu", "dua", "tiga"];
  const body = await measure((_req, res) => {
    res.statusCode = 200;
    for (const c of chunks) res.write(c);
    res.end();
  });
  const expected = chunks.reduce((n, c) => n + Buffer.byteLength(c), 0);
  assert.strictEqual(bytesFrom(body), expected);
});

test("configured environment is emitted instead of an empty label", async () => {
  const body = await measure((_req, res) => res.end("x"));
  const line = body.split("\n").find((l) => l.startsWith("app_build_info{"));
  assert.ok(
    line?.includes('env="test"'),
    `environment label is incorrect:\n${line}`
  );
});
