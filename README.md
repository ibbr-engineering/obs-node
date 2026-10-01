# IBBR Observability for Node.js

`@ibbr-engineering/observability` instruments Node.js HTTP services with the
metrics defined by IBBR metrics-contract v1.5.0. It supports Node.js 16 and
later, Prometheus scraping, OTLP/HTTP JSON push, Express, LoopBack 3, and
LoopBack 4.

This package is distributed only through immutable Git tags and GitHub Release
tarballs. npm registry and GitHub Packages publishing are not supported.

## Install

Pin production installations to a semantic-version tag:

```bash
npm install "git+https://github.com/ibbr-engineering/obs-node.git#v1.2.0"
```

The tarball attached to the matching GitHub Release is npm-compatible and can
also be installed directly:

```bash
npm install ./ibbr-engineering-observability-1.2.0.tgz
```

Do not install from `main`; a branch is mutable and cannot identify the exact
client code running in production.

## Core API

```js
const { initObservability } = require("@ibbr-engineering/observability");

const obs = initObservability({
  service: "booking-api",
  tier: "T1",
  version: process.env.BUILD_SHA,
  env: "prod",
  transport: "scrape",
});

app.use(obs.middleware());
app.get("/metrics", obs.metricsHandler());

process.once("SIGTERM", () => obs.shutdown());
```

The same package works through ESM named imports:

```js
import { initObservability } from "@ibbr-engineering/observability";
```

`initObservability()` returns an `Observability` handle with these stable
operations:

- `middleware()` measures HTTP requests.
- `metricsHandler()` serves Prometheus exposition text.
- `render()` returns the exposition text for diagnostics and tests.
- `time()` measures a dependency operation. Distinct `(dependency, operation)`
  pairs are capped by `maxDependencySeries`; later pairs are recorded as
  `__other__`.
- `pushOnce()` performs one explicit OTLP push and rejects on failure.
  Concurrent calls share the push already in flight.
- `shutdown()` stops scheduled pushes, performs one final push for `push` and
  `both`, releases the registry, and returns a promise. It is safe to call
  repeatedly.

Invalid initialization throws `ObservabilityConfigError`. Runtime push failures
do not terminate the application; scheduled failures are reported to `logger`
as `obs.push.failed` and retried at the next interval.

## Configuration

| Option                | Required | Default                                                  | Description                                          |
| --------------------- | -------: | -------------------------------------------------------- | ---------------------------------------------------- |
| `service`             |      yes | —                                                        | Stable service label; blank values are rejected.     |
| `tier`                |      yes | —                                                        | `T1`, `T2`, or `T3`.                                 |
| `version`             |       no | `BUILD_SHA` or `unknown`                                 | Deployed application version.                        |
| `commit`              |       no | `GIT_COMMIT` or `unknown`                                | Source revision.                                     |
| `env`                 |       no | `ENV`, `APP_ENV`, `NODE_ENV`, or `unknown`               | Deployment environment.                              |
| `transport`           |       no | `scrape`                                                 | `scrape`, `push`, or `both`.                         |
| `metricsPath`         |       no | `/metrics`                                               | Prometheus endpoint path.                            |
| `otlpEndpoint`        |       no | `OTEL_EXPORTER_OTLP_ENDPOINT` or `http://localhost:4318` | OTLP/HTTP base URL. Plain HTTP is allowed for loopback and private (RFC1918) hosts; public hosts require HTTPS. |
| `pushIntervalMs`      |       no | `30000`                                                  | Positive scheduled push interval. Ticks that land while a push is running are skipped. |
| `otlpCompression`     |       no | `gzip`                                                   | OTLP request body encoding: `gzip` or `none`.        |
| `maxRoutes`           |       no | `40`                                                     | Route-template cardinality cap; minimum 2.           |
| `maxUnmatchedRoutes`  |       no | `maxRoutes / 10` (minimum 1)                             | Share of `maxRoutes` available to heuristic templates of paths the router table did not match, so 404 scanners cannot crowd out real routes. |
| `maxDependencySeries` |       no | `200`                                                    | Cap on distinct `time()` dependency/operation pairs. |
| `routeConfig`         |       no | empty                                                    | A routes configuration object or local YAML path.    |
| `defaultMetrics`      |       no | `true`                                                   | Enable Node.js runtime metrics.                      |
| `unmatchedSampleRate` |       no | `0.01`                                                   | Fraction of unmatched paths sent to the logger.      |
| `logger`              |       no | structured stdout                                        | Receives initialization and transport events.        |

Label bounds: `method` is one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`,
`HEAD`, `OPTIONS`, or `OTHER`. Route templates that look like PHI are recorded
as `__other__`.

Transport behavior:

- `scrape` exposes the registry through `metricsHandler()` or an adapter.
- `push` schedules gzip-compressed OTLP/HTTP JSON delivery and does not register `/metrics` in
  framework adapters.
- `both` exposes and pushes the same registry, preserving metric and label
  parity during migrations.

## Framework adapters

### Express

```js
const express = require("express");
const {
  instrumentExpress,
} = require("@ibbr-engineering/observability/express");

const app = express();
const obs = instrumentExpress(app, { service: "booking-api", tier: "T1" });
```

Install the adapter before application routes. It reads the matched Express
route after routing completes, excludes the metrics endpoint, and counts
streamed response bytes without relying on `Content-Length`.

### LoopBack 3

```js
const {
  instrumentLoopback3,
} = require("@ibbr-engineering/observability/loopback3");

const obs = instrumentLoopback3(app, {
  service: "legacy-api",
  tier: "T1",
  routeConfig: "./routes.yaml",
});
```

Install the adapter before boot completes. It uses the `initial` middleware
phase by default so `/metrics` remains outside later authentication middleware.

### LoopBack 4

```ts
import { instrumentLoopback4 } from "@ibbr-engineering/observability/loopback4";

await app.boot();
const obs = await instrumentLoopback4(app, {
  service: "modern-api",
  tier: "T1",
  middlewareChain: "middlewareChain.default",
});
```

Install this adapter after `app.boot()` so it can snapshot the completed OpenAPI
route table. Set `middlewareChain` when the application uses a custom sequence.

## Dependency timing

```js
const result = await obs.time(
  { dependency: "postgres", operation: "select-booking" },
  () => repository.findById(id)
);
```

Dependency and operation values must remain bounded categories, never user or
record identifiers.

## Privacy and cardinality

Only route templates enter request labels. Query strings and matched identifier
values are removed, and the route table has a hard cap with overflow mapped to
`__other__`. Known PHI keys and email, Indonesian phone, and national identity
value patterns are removed before labels reach the registry. Never pass raw
request paths, credentials, user identifiers, record numbers, or free-form text
as metric labels.

## Contract updates

The repository vendors its contract snapshot for offline, reproducible builds.
Import an explicitly selected local platform checkout and review the checksum:

```bash
npm run contract:sync -- --source ../observability/contract
npm test
```

The sync command never fetches a remote branch.

## Migration from the platform monorepo

The public API and package name are unchanged. Replace workspace, registry, or
monorepo-path installation with the pinned Git URL above. Imports from the root,
`/express`, `/loopback3`, and `/loopback4` continue to resolve with JavaScript
and TypeScript declarations. The former platform copy remains available during
consumer migration but is not the release source for this repository.

## Development

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run test:git-install
npm run pack:check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contract and release requirements.

## License

Apache License 2.0. See [LICENSE](LICENSE).
