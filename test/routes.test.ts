import * as assert from "assert";
import { it as test } from "mocha";

import { RouteNormalizer, heuristic } from "../src/routes";
import { OVERFLOW_ROUTE } from "../src/contract";

test("heuristic replaces MongoDB ObjectId with :id", () => {
  assert.strictEqual(
    heuristic("/api/patients/507f1f77bcf86cd799439011/visits"),
    "/api/patients/:id/visits"
  );
});

test("heuristic distinguishes dates from ordinary numbers", () => {
  assert.strictEqual(
    heuristic("/api/reports/2026-08-03"),
    "/api/reports/:date"
  );
  assert.strictEqual(heuristic("/api/reports/2026/08"), "/api/reports/:n/:n");
});

test("heuristic recognizes UUIDs and long tokens", () => {
  assert.strictEqual(
    heuristic("/s/3f2504e0-4f89-11d3-9a0c-0305e82c3301"),
    "/s/:uuid"
  );
  assert.strictEqual(heuristic(`/d/${"a".repeat(48)}`), "/d/:token");
});

test("query strings never enter route templates", () => {
  assert.strictEqual(heuristic("/api/search?q=budi&page=2"), "/api/search");
});

test("cardinality guard enforces a hard cap", () => {
  const n = new RouteNormalizer({ maxRoutes: 3, routeConfig: {} });

  assert.strictEqual(n.normalize("GET", "/a"), "/a");
  assert.strictEqual(n.normalize("GET", "/b"), "/b");
  assert.strictEqual(n.normalize("GET", "/c"), OVERFLOW_ROUTE);
  assert.strictEqual(n.normalize("GET", "/d"), OVERFLOW_ROUTE);

  assert.strictEqual(n.normalize("GET", "/a"), "/a");
  assert.strictEqual(n.cardinality, 3);
  assert.strictEqual(n.overflows, 2);
});

test("routes.yaml override wins over heuristic matching", () => {
  const n = new RouteNormalizer({
    routeConfig: {
      overrides: [
        {
          pattern: "^/api/clinics/[^/]+/slots$",
          template: "/api/clinics/:slug/slots",
        },
      ],
    },
  });

  assert.strictEqual(
    n.normalize("GET", "/api/clinics/jakarta-pusat/slots"),
    "/api/clinics/:slug/slots"
  );
});

test("ignored paths are recognized", () => {
  const n = new RouteNormalizer({
    routeConfig: { ignore: ["^/health$", "^/readyz$"] },
  });
  assert.ok(n.shouldIgnore("/health"));
  assert.ok(n.shouldIgnore("/readyz?verbose=1"));
  assert.ok(!n.shouldIgnore("/api/patients"));
});

test("framework route table wins over heuristic matching", () => {
  const n = new RouteNormalizer({
    routerTable: {
      match: (_m, path) =>
        path.startsWith("/api/Patients/") ? "/api/Patients/:id" : undefined,
    },
  });

  assert.strictEqual(
    n.normalize("GET", "/api/Patients/12345"),
    "/api/Patients/:id"
  );
  assert.strictEqual(n.normalize("GET", "/other/12345"), "/other/:n");
});

test("onUnmatched receives a raw path rather than a template", () => {
  const seen: string[] = [];
  const n = new RouteNormalizer({
    maxRoutes: 1,
    onUnmatched: (_m, path) => seen.push(path),
  });

  n.normalize("GET", "/api/patients/507f1f77bcf86cd799439011");
  assert.deepStrictEqual(seen, ["/api/patients/507f1f77bcf86cd799439011"]);
});

import { initObservability } from "../src/index";
import { fakeRes } from "./helpers";

async function routeLabelFor(req: any): Promise<string> {
  const obs = initObservability({
    service: "mount-test",
    tier: "T1",
    defaultMetrics: false,
    logger: () => undefined,
  });
  const res = fakeRes(200);
  obs.middleware()(req, res, () => undefined);
  res.emit("finish");
  const body = await obs.render();
  obs.shutdown();
  return (body.match(/route="([^"]*)"/) ?? [])[1] ?? "";
}

test("mount prefix is restored for a relative route path", async () => {
  const label = await routeLabelFor({
    method: "GET",
    originalUrl: "/api/Accounts/507f1f77bcf86cd799439011",
    url: "/api/Accounts/507f1f77bcf86cd799439011",
    baseUrl: "",
    route: { path: "/:id" },
  });
  assert.strictEqual(label, "/api/Accounts/:id");
});

test("sub-router root route receives its full prefix", async () => {
  const label = await routeLabelFor({
    method: "GET",
    originalUrl: "/api/Accounts",
    url: "/api/Accounts",
    baseUrl: "",
    route: { path: "/" },
  });
  assert.strictEqual(label, "/api/Accounts");
});

test("absolute routes remain unchanged", async () => {
  const label = await routeLabelFor({
    method: "GET",
    originalUrl: "/api/patients/123",
    url: "/api/patients/123",
    baseUrl: "",
    route: { path: "/api/patients/:id" },
  });
  assert.strictEqual(label, "/api/patients/:id");
});

test("route overrides remain subject to the cardinality cap", () => {
  const n = new RouteNormalizer({
    maxRoutes: 3,
    routeConfig: {
      overrides: [
        { pattern: "^/a$", template: "/a" },
        { pattern: "^/b$", template: "/b" },
        { pattern: "^/c$", template: "/c" },
      ],
    },
  });

  assert.strictEqual(n.normalize("GET", "/a"), "/a");
  assert.strictEqual(n.normalize("GET", "/b"), "/b");
  assert.strictEqual(n.normalize("GET", "/c"), OVERFLOW_ROUTE);

  assert.strictEqual(n.cardinality, 3);
  assert.strictEqual(n.overflows, 1);
});

test("catch-all routes fall back to heuristic matching", async () => {
  const label = await routeLabelFor({
    method: "GET",
    originalUrl: "/promo/507f1f77bcf86cd799439011/edit",
    url: "/promo/507f1f77bcf86cd799439011/edit",
    baseUrl: "",
    route: { path: "*" },
  });
  assert.strictEqual(label, "/promo/:id/edit");
});
