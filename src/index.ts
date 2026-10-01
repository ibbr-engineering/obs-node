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
import {
  RouteNormalizer,
  stripQuery,
  type RouterTable,
  type RoutesConfig,
} from "./routes";

export { CONTRACT_VERSION, OVERFLOW_ROUTE, statusClass } from "./contract";
export {
  RouteNormalizer,
  compileRouterTable,
  heuristic,
  type RouteSpec,
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
  /** Budget for heuristic templates of paths the router table did not match. */
  maxUnmatchedRoutes?: number;
  /** Cap on distinct (dependency, operation) pairs recorded by time(). */
  maxDependencySeries?: number;

  metricsPath?: string;
  defaultMetrics?: boolean;

  otlpEndpoint?: string;
  pushIntervalMs?: number;
  /** OTLP request body encoding. Defaults to gzip. */
  otlpCompression?: "gzip" | "none";

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
  /**
   * Stops the push timer, flushes once more (bounded by the push timeout) and
   * releases the registry. Safe to call more than once.
   */
  shutdown(): Promise<void>;
}

const DEFAULT_MAX_DEPENDENCY_SERIES = 200;

const KNOWN_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

function normalizeMethod(raw: unknown): string {
  const method = String(raw ?? "GET").toUpperCase();
  return KNOWN_METHODS.has(method) ? method : "OTHER";
}

/** Declared body length, or null when the body must be counted. */
function contentLength(res: any): number | null {
  if (typeof res.getHeader !== "function") return null;
  const status = Number(res.statusCode ?? 0);
  if (status === 204 || status === 304 || (status >= 100 && status < 200)) {
    return null;
  }
  const raw = res.getHeader("content-length");
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  return raw !== undefined && Number.isInteger(value) && value >= 0
    ? value
    : null;
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
    maxUnmatchedRoutes: config.maxUnmatchedRoutes,
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
      compression: config.otlpCompression,
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

  const baseLabels = sanitizeLabels({ service, env, replica_id: REPLICA_ID });
  const inFlight = metrics.inFlight.labels(baseLabels);

  // Every key component is bounded (route by the normalizer, method by
  // KNOWN_METHODS, status by the HTTP status range), so these caches are too.
  const routeChildren = new Map<
    string,
    {
      duration: ReturnType<typeof metrics.duration.labels>;
      bytes: ReturnType<typeof metrics.responseBytes.labels>;
    }
  >();
  const requestChildren = new Map<
    string,
    ReturnType<typeof metrics.requests.labels>
  >();
  let recordFailureLogged = false;

  function record(
    method: string,
    route: string,
    status: number,
    seconds: number,
    bytes: number
  ): void {
    const cls = statusClass(status);
    const key = `${method} ${cls} ${route}`;
    let children = routeChildren.get(key);
    if (!children) {
      const labels = { ...baseLabels, method, route, status_class: cls };
      children = {
        duration: metrics.duration.labels(labels),
        bytes: metrics.responseBytes.labels(labels),
      };
      routeChildren.set(key, children);
    }
    const statusKey = `${status} ${key}`;
    let requests = requestChildren.get(statusKey);
    if (!requests) {
      requests = metrics.requests.labels({
        ...baseLabels,
        method,
        route,
        status_class: cls,
        status: String(status),
      });
      requestChildren.set(statusKey, requests);
    }

    children.duration.observe(seconds);
    requests.inc();
    children.bytes.inc(bytes);
  }

  function middleware() {
    return function observabilityMiddleware(
      req: any,
      res: any,
      next: (err?: any) => void
    ): void {
      const path: string = req.originalUrl ?? req.url ?? "/";
      const pathname = stripQuery(path);

      if (pathname === metricsPath || normalizer.shouldIgnore(pathname)) {
        return next();
      }

      const method = normalizeMethod(req.method);
      const startedAt = process.hrtime.bigint();
      inFlight.inc();

      let bytesOut = 0;
      let wrote = false;
      let declaredLength: number | null | undefined;
      const origWrite = res.write;
      const origEnd = res.end;
      const countChunk = (chunk: any, encoding?: any): void => {
        if (!chunk) return;
        if (declaredLength === undefined) declaredLength = contentLength(res);
        if (declaredLength !== null) return;
        countBytes(chunk, encoding);
      };
      const countBytes = (chunk: any, encoding?: any): void => {
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
        wrote = true;
        countChunk(chunk, encoding);
        return origWrite.call(this, chunk, encoding, cb);
      };
      res.end = function patchedEnd(chunk: any, encoding?: any, cb?: any) {
        const body = typeof chunk === "function" ? undefined : chunk;
        if (wrote || !body) {
          countChunk(body, encoding);
          return origEnd.call(this, chunk, encoding, cb);
        }
        if (declaredLength === undefined) declaredLength = contentLength(res);
        const result = origEnd.call(this, chunk, encoding, cb);
        if (declaredLength === null) {
          // Node already measured a single-shot body to build the implicit
          // Content-Length header; reuse it instead of measuring twice.
          const measured = (this as any)?._contentLength;
          if (typeof measured === "number") bytesOut += measured;
          else countBytes(body, encoding);
        }
        return result;
      };

      let finished = false;
      const onDone = (): void => {
        if (finished) return;
        finished = true;
        res.removeListener("finish", onDone);
        res.removeListener("close", onDone);

        // Runs inside a response event: a throw here would be uncaught.
        try {
          inFlight.dec();
          const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
          const status = Number(res.statusCode ?? 0);
          const hint = routeHint(req);
          const route = normalizer.normalize(
            method,
            hint ?? pathname,
            hint !== undefined
          );
          const bytes =
            typeof declaredLength === "number" ? declaredLength : bytesOut;
          record(method, route, status, seconds, bytes);
        } catch (err) {
          if (!recordFailureLogged) {
            recordFailureLogged = true;
            log({
              level: "warn",
              msg: "obs.record.failed",
              service,
              error: (err as Error).message,
            });
          }
        }
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

  const maxDependencySeries =
    config.maxDependencySeries ?? DEFAULT_MAX_DEPENDENCY_SERIES;
  const dependencyPairs = new Set<string>();

  function dependencyLabels(timing: DependencyTiming): {
    dependency: string;
    operation: string;
  } {
    const key = `${timing.dependency}\u0000${timing.operation}`;
    if (dependencyPairs.has(key)) return timing;
    if (dependencyPairs.size < maxDependencySeries) {
      dependencyPairs.add(key);
      return timing;
    }
    return { dependency: OVERFLOW_ROUTE, operation: OVERFLOW_ROUTE };
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
      const { dependency, operation } = dependencyLabels(timing);
      metrics.dependency.observe(
        sanitizeLabels({
          service,
          env,
          dependency,
          operation,
          outcome: timing.outcome ?? outcome,
          replica_id: REPLICA_ID,
        }),
        Number(process.hrtime.bigint() - startedAt) / 1e9
      );
    }
  }

  let shutdownPromise: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        if (pusher) {
          pusher.stop();
          try {
            await pusher.pushOnce();
          } catch (err) {
            log({
              level: "warn",
              msg: "obs.push.final_failed",
              service,
              error: (err as Error).message,
            });
          }
        }
        metrics.dispose();
        routeChildren.clear();
        requestChildren.clear();
        dependencyPairs.clear();
      })();
    }
    return shutdownPromise;
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
    shutdown,
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
    config.otlpCompression !== undefined &&
    !["gzip", "none"].includes(config.otlpCompression)
  ) {
    throw new ObservabilityConfigError("otlpCompression must be gzip or none");
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
  for (const [name, value] of [
    ["maxUnmatchedRoutes", config.maxUnmatchedRoutes],
    ["maxDependencySeries", config.maxDependencySeries],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new ObservabilityConfigError(
        `${name} must be an integer greater than or equal to 1`
      );
    }
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
