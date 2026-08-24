import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";
import {
  CONTRACT_VERSION,
  DEPENDENCY_BUCKETS,
  DURATION_BUCKETS,
  LABELS,
  METRIC,
} from "./contract";
import { resolveEnv } from "./env";
import { REPLICA_ID } from "./replica";
import type { RouteNormalizer } from "./routes";

export interface MetricsOptions {
  service: string;
  env: string;
  version: string;
  commit: string;
  tier: string;
  displayName: string;
  description: string;
  public: boolean;
  defaultMetrics: boolean;
}

export class Metrics {
  readonly registry = new Registry();

  readonly requests: Counter<string>;
  readonly duration: Histogram<string>;
  readonly responseBytes: Counter<string>;
  readonly inFlight: Gauge<string>;
  readonly buildInfo: Gauge<string>;
  readonly routeCardinality: Gauge<string>;
  readonly routeOverflow: Counter<string>;
  readonly dependency: Histogram<string>;

  constructor(private readonly options: MetricsOptions) {
    const { registry } = this;

    this.requests = new Counter({
      name: METRIC.requests,
      help: "Total HTTP requests received by the server.",
      labelNames: LABELS.requests as unknown as string[],
      registers: [registry],
    });

    this.duration = new Histogram({
      name: METRIC.duration,
      help: "HTTP request handling duration in seconds.",
      labelNames: LABELS.duration as unknown as string[],
      buckets: [...DURATION_BUCKETS],
      registers: [registry],
    });

    this.responseBytes = new Counter({
      name: METRIC.responseBytes,
      help: "Total response body bytes sent by the server.",
      labelNames: LABELS.responseBytes as unknown as string[],
      registers: [registry],
    });

    this.inFlight = new Gauge({
      name: METRIC.inFlight,
      help: "Number of HTTP requests currently being processed.",
      labelNames: LABELS.inFlight as unknown as string[],
      registers: [registry],
    });

    this.buildInfo = new Gauge({
      name: METRIC.buildInfo,
      help: "Always 1. Labels carry build identity and contract version.",
      labelNames: LABELS.buildInfo as unknown as string[],
      registers: [registry],
    });

    this.routeCardinality = new Gauge({
      name: METRIC.routeCardinality,
      help: "Number of unique route templates tracked by this service.",
      labelNames: LABELS.routeCardinality as unknown as string[],
      registers: [registry],
    });

    this.routeOverflow = new Counter({
      name: METRIC.routeOverflow,
      help: "Number of requests assigned to the __other__ route label.",
      labelNames: LABELS.routeOverflow as unknown as string[],
      registers: [registry],
    });

    this.dependency = new Histogram({
      name: METRIC.dependency,
      help: "External dependency call duration.",
      labelNames: LABELS.dependency as unknown as string[],
      buckets: [...DEPENDENCY_BUCKETS],
      registers: [registry],
    });

    this.inFlight.set(
      { service: options.service, env: options.env, replica_id: REPLICA_ID },
      0
    );
    this.routeOverflow.inc(
      { service: options.service, env: options.env, replica_id: REPLICA_ID },
      0
    );

    this.buildInfo.set(
      {
        service: options.service,
        env: options.env,
        version: options.version,
        commit: options.commit,
        tier: options.tier,
        contract_version: CONTRACT_VERSION,
        lang: "node",
        display_name: options.displayName,
        description: options.description,
        public: String(options.public),
        replica_id: REPLICA_ID,
      },
      1
    );

    if (options.defaultMetrics) {
      collectDefaultMetrics({ register: registry });
    }
  }

  bindRouteStats(normalizer: RouteNormalizer): void {
    this.routeCardinality.set(
      {
        service: this.options.service,
        env: this.options.env,
        replica_id: REPLICA_ID,
      },
      normalizer.cardinality
    );
  }

  async render(normalizer?: RouteNormalizer): Promise<string> {
    if (normalizer) this.bindRouteStats(normalizer);
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
