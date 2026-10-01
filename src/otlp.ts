import * as http from "http";
import * as https from "https";
import { URL } from "url";
import { promisify } from "util";
import * as zlib from "zlib";
import type { Registry } from "prom-client";

const AGGREGATION_TEMPORALITY_CUMULATIVE = 2;
const PUSH_TIMEOUT_MS = 10_000;
const gzip = promisify(zlib.gzip);

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface OtlpPusherOptions {
  endpoint: string;
  registry: Registry;
  intervalMs: number;
  serviceName: string;
  headers?: Record<string, string>;
  compression?: "gzip" | "none";
  timeoutMs?: number;
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

interface HistogramGroup {
  labels: Record<string, string | number>;
  size: number;
  buckets: Array<[number, number]>;
  sum: number;
  count: number;
}

function seriesSize(labels: Record<string, string | number>): number {
  let n = 0;
  for (const k in labels) if (k !== "le") n++;
  return n;
}

function sameSeries(
  labels: Record<string, string | number>,
  group: HistogramGroup
): boolean {
  let n = 0;
  for (const k in labels) {
    if (k === "le") continue;
    if (labels[k] !== group.labels[k]) return false;
    n++;
  }
  return n === group.size;
}

function histogramToOtlp(
  m: PromMetric,
  startTimeNano: string,
  nowNano: string
): unknown[] {
  const groups = new Map<string, HistogramGroup>();
  let previous: HistogramGroup | undefined;

  for (const v of m.values) {
    // prom-client emits a series' buckets, sum and count back to back, so
    // the previous group usually matches without building a sorted key.
    let g = previous && sameSeries(v.labels, previous) ? previous : undefined;
    if (!g) {
      const key = labelKey(v.labels);
      g = groups.get(key);
      if (!g) {
        g = {
          labels: v.labels,
          size: seriesSize(v.labels),
          buckets: [],
          sum: 0,
          count: 0,
        };
        groups.set(key, g);
      }
      previous = g;
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
  private inFlight?: Promise<void>;
  private readonly startTimeNano = String(Date.now() * 1e6);
  private readonly url: URL;

  constructor(private readonly options: OtlpPusherOptions) {
    const base = options.endpoint.replace(/\/+$/, "");
    this.url = new URL(`${base}/v1/metrics`);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // A tick that lands while a push is still running is skipped rather
      // than stacking another payload behind a slow collector.
      if (this.inFlight) return;
      void this.pushOnce().catch((err: Error) => this.options.onError?.(err));
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Concurrent callers share the push that is already in flight. */
  pushOnce(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.push().finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  private async push(): Promise<void> {
    this.options.beforeCollect?.();
    // Collect and convert one metric at a time, yielding in between, so a
    // large registry never blocks the event loop in a single long task.
    const otlpMetrics: unknown[] = [];
    const nowNano = String(Date.now() * 1e6);
    const registered =
      this.options.registry.getMetricsAsArray() as unknown as Array<{
        get(): Promise<PromMetric> | PromMetric;
      }>;
    for (const metric of registered) {
      const collected = await metric.get();
      await yieldToEventLoop();
      for (const m of toOtlpJson(
        [collected],
        this.startTimeNano,
        nowNano
      ) as unknown[]) {
        otlpMetrics.push(m);
      }
      await yieldToEventLoop();
    }

    const json = JSON.stringify({
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
              metrics: otlpMetrics,
            },
          ],
        },
      ],
    });

    if ((this.options.compression ?? "gzip") === "gzip") {
      await this.post(await gzip(json), "gzip");
    } else {
      await this.post(Buffer.from(json), undefined);
    }
  }

  private post(body: Buffer, encoding: string | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      // Every exit path (error, timeout, reset mid-body) must settle exactly
      // once, otherwise the request and its closures are retained forever.
      let settled = false;
      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      const transport = this.url.protocol === "https:" ? https : http;
      const req = transport.request(
        {
          protocol: this.url.protocol,
          hostname: this.url.hostname,
          port: this.url.port,
          path: this.url.pathname,
          method: "POST",
          timeout: this.options.timeoutMs ?? PUSH_TIMEOUT_MS,
          headers: {
            "content-type": "application/json",
            "content-length": body.length,
            ...(encoding ? { "content-encoding": encoding } : {}),
            ...this.options.headers,
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          res.on("error", (err) => settle(err));
          res.on("end", () =>
            status >= 200 && status < 300
              ? settle()
              : settle(new Error(`collector returned HTTP ${status}`))
          );
          res.on("close", () =>
            settle(new Error("collector closed the response early"))
          );
          res.resume();
        }
      );

      req.on("error", (err) => settle(err));
      req.on("timeout", () => req.destroy(new Error("push OTLP timeout")));
      req.on("close", () =>
        settle(new Error("collector closed the connection"))
      );
      req.end(body);
    });
  }
}
