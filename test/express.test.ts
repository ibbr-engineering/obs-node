import * as assert from "assert";
import { it as test } from "mocha";

import { instrumentExpress } from "../src/adapters/express";
import { fakeRes } from "./helpers";

function fakeExpressApp() {
  const middleware: Array<(req: any, res: any, next: () => void) => void> = [];
  const routes = new Map<string, (req: any, res: any) => void>();
  return {
    middleware,
    routes,
    use(handler: (req: any, res: any, next: () => void) => void) {
      middleware.push(handler);
    },
    get(path: string, handler: (req: any, res: any) => void) {
      routes.set(path, handler);
    },
  };
}

function response(statusCode = 200): any {
  return {
    ...fakeRes(statusCode),
    write(_chunk: unknown) {
      return true;
    },
    end(_chunk?: unknown) {
      return this;
    },
  };
}

test("Express records the matched route after routing completes", async () => {
  const app = fakeExpressApp();
  const obs = instrumentExpress(app, {
    service: "express-test",
    tier: "T1",
    defaultMetrics: false,
    logger: () => undefined,
  });
  const req: any = {
    method: "GET",
    originalUrl: "/users/123",
    url: "/users/123",
  };
  const res = response();

  app.middleware[0](req, res, () => {
    req.route = { path: "/users/:id" };
  });
  res.emit("finish");

  const exposition = await obs.render();
  obs.shutdown();
  assert.match(exposition, /route="\/users\/:id"/);
});

test("Express excludes the metrics endpoint from request metrics", async () => {
  const app = fakeExpressApp();
  const obs = instrumentExpress(app, {
    service: "express-metrics-test",
    tier: "T1",
    defaultMetrics: false,
    logger: () => undefined,
  });
  const res = response();
  let nextCalled = false;

  app.middleware[0]({ method: "GET", originalUrl: "/metrics" }, res, () => {
    nextCalled = true;
  });
  res.emit("finish");

  const exposition = await obs.render();
  obs.shutdown();
  assert.strictEqual(nextCalled, true);
  assert.ok(
    !exposition
      .split("\n")
      .some((line) => line.startsWith("http_server_requests_total{"))
  );
  assert.strictEqual(typeof app.routes.get("/metrics"), "function");
});

test("Express counts streamed response bytes once", async () => {
  const app = fakeExpressApp();
  const obs = instrumentExpress(app, {
    service: "express-stream-test",
    tier: "T1",
    defaultMetrics: false,
    logger: () => undefined,
  });
  const res = response();

  app.middleware[0]({ method: "GET", originalUrl: "/stream" }, res, () => {
    res.write("first");
    res.write(Buffer.from("second"));
    res.end("third");
  });
  res.emit("finish");
  res.emit("close");

  const exposition = await obs.render();
  obs.shutdown();
  const line = exposition
    .split("\n")
    .find((sample) => sample.startsWith("http_server_response_bytes_total{"));
  assert.ok(line);
  assert.strictEqual(Number(line.slice(line.lastIndexOf(" ") + 1)), 16);
});
