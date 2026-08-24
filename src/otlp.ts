import * as http from "http";
import * as https from "https";
import { URL } from "url";
import type { Registry } from "prom-client";

const AGGREGATION_TEMPORALITY_CUMULATIVE = 2;

export interface OtlpPusherOptions {
  endpoint: string;
  registry: Registry;
  intervalMs: number;
  serviceName: string;
  headers?: Record<string, string>;
  onError?: (err: Error) => void;
  beforeCollect?: () => void;
}

interface PromValue {
  value: number;
  labels: Record<string, string | number>;
  metricName?: string;
}

interface PromMetric {
  name: string;
  help: string;
  type: string;
  values: PromValue[];
}

function attributes(labels: Record<string, string | number>) {
  return Object.entries(labels)
    .filter(([k]) => k !== "le" && k !== "quantile")
    .map(([key, value]) => ({
      key,
      value: { stringValue: String(value) },
    }));
}

function labelKey(labels: Record<string, string | number>): string {
  return Object.entries(labels)
    .filter(([k]) => k !== "le")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

export function toOtlpJson(
  metrics: PromMetric[],
  startTimeNano: string,
  nowNano: string
): unknown {
  const out: unknown[] = [];

  for (const m of metrics) {
    if (m.type === "counter" || m.type === "gauge") {
      const dataPoints = m.values.map((v) => ({
        attributes: attributes(v.labels),
        startTimeUnixNano: startTimeNano,
        timeUnixNano: nowNano,
        asDouble: v.value,
      }));
      if (dataPoints.length === 0) continue;

      out.push(
        m.type === "counter"
          ? {
              name: m.name,
              description: m.help,
              sum: {
                aggregationTemporality: AGGREGATION_TEMPORALITY_CUMULATIVE,
                isMonotonic: true,
                dataPoints,
              },
            }
          : { name: m.name, description: m.help, gauge: { dataPoints } }
      );
      continue;
    }

    if (m.type === "histogram") {
      out.push(...histogramToOtlp(m, startTimeNano, nowNano));
      continue;
    }
  }

  return out;
}

function histogramToOtlp(
  m: PromMetric,
  startTimeNano: string,
  nowNano: string
): unknown[] {
  const groups = new Map<
    string,
    {
      labels: Record<string, string | number>;
      buckets: Array<[number, number]>;
      sum: number;
      count: number;
    }
  >();

  for (const v of m.values) {
    const key = labelKey(v.labels);
    let g = groups.get(key);
    if (!g) {
      g = { labels: v.labels, buckets: [], sum: 0, count: 0 };
      groups.set(key, g);
    }

    if (v.metricName?.endsWith("_bucket")) {
      const rawLe = v.labels.le;
      const le = rawLe === "+Inf" ? Infinity : Number(rawLe);
      g.buckets.push([le, v.value]);
    } else if (v.metricName?.endsWith("_sum")) {
      g.sum = v.value;
    } else if (v.metricName?.endsWith("_count")) {
      g.count = v.value;
    }
  }

  const dataPoints = [];
  for (const g of groups.values()) {
    g.buckets.sort((a, b) => a[0] - b[0]);

    const explicitBounds: number[] = [];
    const bucketCounts: string[] = [];
    let previous = 0;

    for (const [le, cumulative] of g.buckets) {
      bucketCounts.push(String(Math.max(0, cumulative - previous)));
      previous = cumulative;
      if (Number.isFinite(le)) explicitBounds.push(le);
    }
    if (bucketCounts.length === explicitBounds.length) {
      bucketCounts.push(String(Math.max(0, g.count - previous)));
    }

    dataPoints.push({
      attributes: attributes(g.labels),
      startTimeUnixNano: startTimeNano,
      timeUnixNano: nowNano,
      count: String(g.count),
      sum: g.sum,
      bucketCounts,
      explicitBounds,
    });
  }

  if (dataPoints.length === 0) return [];
  return [
    {
      name: m.name,
      description: m.help,
      unit: m.name.endsWith("_seconds") ? "s" : "1",
      histogram: {
        aggregationTemporality: AGGREGATION_TEMPORALITY_CUMULATIVE,
        dataPoints,
      },
    },
  ];
}

export class OtlpPusher {
  private timer?: NodeJS.Timeout;
  private readonly startTimeNano = String(Date.now() * 1e6);
  private readonly url: URL;

  constructor(private readonly options: OtlpPusherOptions) {
    const base = options.endpoint.replace(/\/+$/, "");
    this.url = new URL(`${base}/v1/metrics`);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pushOnce().catch((err: Error) => this.options.onError?.(err));
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async pushOnce(): Promise<void> {
    this.options.beforeCollect?.();
    const metrics =
      (await this.options.registry.getMetricsAsJSON()) as unknown as PromMetric[];
    const nowNano = String(Date.now() * 1e6);

    const body = JSON.stringify({
      resourceMetrics: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                value: { stringValue: this.options.serviceName },
              },
            ],
          },
          scopeMetrics: [
            {
              scope: {},
              metrics: toOtlpJson(metrics, this.startTimeNano, nowNano),
            },
          ],
        },
      ],
    });

    await this.post(body);
  }

  private post(body: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const transport = this.url.protocol === "https:" ? https : http;
      const req = transport.request(
        {
          protocol: this.url.protocol,
          hostname: this.url.hostname,
          port: this.url.port,
          path: this.url.pathname,
          method: "POST",
          timeout: 10_000,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            ...this.options.headers,
          },
        },
        (res) => {
          res.resume();
          const status = res.statusCode ?? 0;
          res.on("end", () =>
            status >= 200 && status < 300
              ? resolve()
              : reject(new Error(`collector returned HTTP ${status}`))
          );
        }
      );

      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("push OTLP timeout")));
      req.end(body);
    });
  }
}
