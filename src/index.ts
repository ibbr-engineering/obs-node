import {
  CONTRACT_VERSION,
  OVERFLOW_ROUTE,
  statusClass,
  type Tier,
} from "./contract";
import { sanitizeLabels } from "./guard";
import { Metrics } from "./metrics";
import { resolveEnv } from "./env";
import { allowsPlaintextOtlp } from "./endpoint";
import { OtlpPusher } from "./otlp";
import { REPLICA_ID } from "./replica";
import { RouteNormalizer, type RouterTable, type RoutesConfig } from "./routes";

export { CONTRACT_VERSION, OVERFLOW_ROUTE, statusClass } from "./contract";
export {
  RouteNormalizer,
  heuristic,
  type RouterTable,
  type RoutesConfig,
} from "./routes";
export { sanitizeLabels } from "./guard";
export type { Tier } from "./contract";

export type Transport = "scrape" | "push" | "both";

export class ObservabilityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObservabilityConfigError";
  }
}

export interface ObservabilityConfig {
  service: string;
  version?: string;
  commit?: string;
  tier: Tier;

  env?: string;

  displayName?: string;
  description?: string;
  public?: boolean;

  transport?: Transport;

  routeConfig?: string | RoutesConfig;
  routerTable?: RouterTable;
  maxRoutes?: number;

  metricsPath?: string;
  defaultMetrics?: boolean;

  otlpEndpoint?: string;
  pushIntervalMs?: number;

  unmatchedSampleRate?: number;
  logger?: (event: Record<string, unknown>) => void;
}

export interface DependencyTiming {
  dependency: string;
  operation: string;
  outcome?: "ok" | "error";
}

export interface Observability {
  readonly metrics: Metrics;
  readonly normalizer: RouteNormalizer;
  middleware(): (req: any, res: any, next: (err?: any) => void) => void;
  metricsHandler(): (req: any, res: any) => void;
  time<T>(timing: DependencyTiming, fn: () => Promise<T>): Promise<T>;
  render(): Promise<string>;
  pushOnce(): Promise<void>;
  shutdown(): void;
}

const defaultLogger = (event: Record<string, unknown>): void => {
  console.log(JSON.stringify(event));
};

export function initObservability(config: ObservabilityConfig): Observability {
  validateConfig(config);
  const service = config.service;
  const transport: Transport = config.transport ?? "scrape";
  const metricsPath = config.metricsPath ?? "/metrics";
  const log = config.logger ?? defaultLogger;
  const unmatchedSampleRate = config.unmatchedSampleRate ?? 0.01;

  const env = resolveEnv(config.env);

  const metrics = new Metrics({
    service,
    env,
    version: config.version ?? process.env.BUILD_SHA ?? "unknown",
    commit: config.commit ?? process.env.GIT_COMMIT ?? "unknown",
    tier: config.tier,
    displayName: config.displayName ?? "",
    description: config.description ?? "",
    public: config.public ?? false,
    defaultMetrics: config.defaultMetrics ?? true,
  });

  const normalizer = new RouteNormalizer({
    maxRoutes: config.maxRoutes,
    routeConfig: config.routeConfig,
    routerTable: config.routerTable,
    onUnmatched: (method, path) => {
      metrics.routeOverflow.inc({ service, env, replica_id: REPLICA_ID });
      if (Math.random() < unmatchedSampleRate) {
        log({
          level: "info",
          msg: "obs.route.unmatched",
          service,
          method,
          path,
        });
      }
    },
  });

  let pusher: OtlpPusher | undefined;
  if (transport === "push" || transport === "both") {
    const endpoint =
      config.otlpEndpoint ??
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
      "http://localhost:4318";
    pusher = new OtlpPusher({
      endpoint,
      registry: metrics.registry,
      intervalMs: config.pushIntervalMs ?? 30_000,
      serviceName: service,
      beforeCollect: () => metrics.bindRouteStats(normalizer),
      onError: (err) =>
        log({
          level: "warn",
          msg: "obs.push.failed",
          service,
          error: err.message,
        }),
    });
    pusher.start();
  }

  function middleware() {
    return function observabilityMiddleware(
      req: any,
      res: any,
      next: (err?: any) => void
    ): void {
      const path: string = req.originalUrl ?? req.url ?? "/";

      if (normalizer.shouldIgnore(path) || path.split("?")[0] === metricsPath) {
        return next();
      }

      const method = String(req.method ?? "GET").toUpperCase();
      const startedAt = process.hrtime.bigint();
      metrics.inFlight.inc({ service, env, replica_id: REPLICA_ID });

      let bytesOut = 0;
      const origWrite = res.write;
      const origEnd = res.end;
      const countChunk = (chunk: any, encoding?: any): void => {
        if (!chunk) return;
        try {
          bytesOut += Buffer.isBuffer(chunk)
            ? chunk.length
            : Buffer.byteLength(
                chunk,
                typeof encoding === "string"
                  ? (encoding as BufferEncoding)
                  : undefined
              );
        } catch {}
      };
      res.write = function patchedWrite(chunk: any, encoding?: any, cb?: any) {
        countChunk(chunk, encoding);
        return origWrite.call(this, chunk, encoding, cb);
      };
      res.end = function patchedEnd(chunk: any, encoding?: any, cb?: any) {
        if (typeof chunk !== "function") countChunk(chunk, encoding);
        return origEnd.call(this, chunk, encoding, cb);
      };

      let finished = false;
      const onDone = (): void => {
        if (finished) return;
        finished = true;
        res.removeListener("finish", onDone);
        res.removeListener("close", onDone);

        metrics.inFlight.dec({ service, env, replica_id: REPLICA_ID });

        const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
        const status = Number(res.statusCode ?? 0);

        const route = normalizer.normalize(method, routeHint(req) ?? path);

        const labels = sanitizeLabels({
          service,
          env,
          method,
          route,
          status_class: statusClass(status),
          replica_id: REPLICA_ID,
        });

        metrics.duration.observe(labels, seconds);
        metrics.requests.inc({ ...labels, status: String(status) });
        metrics.responseBytes.inc(labels, bytesOut);
      };

      res.on("finish", onDone);
      res.on("close", onDone);

      next();
    };
  }

  function metricsHandler() {
    return function handleMetrics(_req: any, res: any): void {
      metrics
        .render(normalizer)
        .then((body) => {
          res.setHeader("content-type", metrics.contentType);
          res.end(body);
        })
        .catch((err: Error) => {
          res.statusCode = 500;
          res.end(`# metric rendering failed: ${err.message}\n`);
        });
    };
  }

  async function time<T>(
    timing: DependencyTiming,
    fn: () => Promise<T>
  ): Promise<T> {
    const startedAt = process.hrtime.bigint();
    let outcome: "ok" | "error" = "ok";
    try {
      return await fn();
    } catch (err) {
      outcome = "error";
      throw err;
    } finally {
      metrics.dependency.observe(
        sanitizeLabels({
          service,
          env,
          dependency: timing.dependency,
          operation: timing.operation,
          outcome: timing.outcome ?? outcome,
          replica_id: REPLICA_ID,
        }),
        Number(process.hrtime.bigint() - startedAt) / 1e9
      );
    }
  }

  log({
    level: "info",
    msg: "obs.initialized",
    service,
    tier: config.tier,
    transport,
    contract_version: CONTRACT_VERSION,
    metrics_path: transport === "push" ? null : metricsPath,
  });

  return {
    metrics,
    normalizer,
    middleware,
    metricsHandler,
    time,
    render: () => metrics.render(normalizer),
    pushOnce: () => pusher?.pushOnce() ?? Promise.resolve(),
    shutdown: () => pusher?.stop(),
  };
}

function validateConfig(config: ObservabilityConfig): void {
  if (typeof config.service !== "string" || config.service.trim() === "") {
    throw new ObservabilityConfigError("service must be a non-empty string");
  }
  if (!["T1", "T2", "T3"].includes(config.tier)) {
    throw new ObservabilityConfigError("tier must be T1, T2, or T3");
  }
  if (
    config.transport !== undefined &&
    !["scrape", "push", "both"].includes(config.transport)
  ) {
    throw new ObservabilityConfigError(
      "transport must be scrape, push, or both"
    );
  }
  if (
    config.maxRoutes !== undefined &&
    (!Number.isInteger(config.maxRoutes) || config.maxRoutes < 2)
  ) {
    throw new ObservabilityConfigError(
      "maxRoutes must be an integer greater than or equal to 2"
    );
  }
  if (
    config.pushIntervalMs !== undefined &&
    (!Number.isFinite(config.pushIntervalMs) || config.pushIntervalMs <= 0)
  ) {
    throw new ObservabilityConfigError(
      "pushIntervalMs must be greater than zero"
    );
  }

  const transport = config.transport ?? "scrape";
  if (transport !== "push" && transport !== "both") return;

  const endpoint =
    config.otlpEndpoint ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
    "http://localhost:4318";
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ObservabilityConfigError("otlpEndpoint must be a valid URL");
  }

  if (!allowsPlaintextOtlp(url)) {
    throw new ObservabilityConfigError(
      "otlpEndpoint must use HTTPS for public hosts"
    );
  }
}

function routeHint(req: any): string | undefined {
  const routePath = req?.route?.path;
  if (typeof routePath !== "string") return undefined;

  if (routePath.includes("*")) return undefined;

  const base = typeof req.baseUrl === "string" ? req.baseUrl : "";
  let template = `${base}${routePath}` || "/";

  const original = String(req.originalUrl ?? req.url ?? "").split("?")[0];
  const templateSegments = template.split("/").filter(Boolean).length;
  const originalSegments = original.split("/").filter(Boolean);

  if (originalSegments.length > templateSegments) {
    const prefix = originalSegments
      .slice(0, originalSegments.length - templateSegments)
      .map((s) => `/${s}`)
      .join("");
    template = template === "/" ? prefix : `${prefix}${template}`;
  }

  return template || "/";
}
