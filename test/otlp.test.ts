import * as assert from "assert";
import { it as test } from "mocha";

import { toOtlpJson } from "../src/otlp";

const START = "1000000000";
const NOW = "2000000000";

test("counter becomes a cumulative monotonic sum", () => {
  const out = toOtlpJson(
    [
      {
        name: "http_server_requests_total",
        help: "x",
        type: "counter",
        values: [{ value: 7, labels: { service: "a", status: "200" } }],
      },
    ],
    START,
    NOW
  ) as any[];

  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].sum.isMonotonic, true);
  assert.strictEqual(out[0].sum.aggregationTemporality, 2);
  assert.strictEqual(out[0].sum.dataPoints[0].asDouble, 7);
});

test("cumulative Prometheus buckets become per-bucket OTLP counts", () => {
  const out = toOtlpJson(
    [
      {
        name: "http_server_duration_seconds",
        help: "x",
        type: "histogram",
        values: [
          {
            metricName: "http_server_duration_seconds_bucket",
            value: 2,
            labels: { service: "a", le: "0.005" },
          },
          {
            metricName: "http_server_duration_seconds_bucket",
            value: 5,
            labels: { service: "a", le: "0.01" },
          },
          {
            metricName: "http_server_duration_seconds_bucket",
            value: 9,
            labels: { service: "a", le: "+Inf" },
          },
          {
            metricName: "http_server_duration_seconds_sum",
            value: 1.25,
            labels: { service: "a" },
          },
          {
            metricName: "http_server_duration_seconds_count",
            value: 9,
            labels: { service: "a" },
          },
        ],
      },
    ],
    START,
    NOW
  ) as any[];

  const dp = out[0].histogram.dataPoints[0];
  assert.deepStrictEqual(dp.bucketCounts, ["2", "3", "4"]);
  assert.deepStrictEqual(dp.explicitBounds, [0.005, 0.01]);
  assert.strictEqual(dp.bucketCounts.length, dp.explicitBounds.length + 1);
  assert.strictEqual(dp.count, "9");
  assert.strictEqual(dp.sum, 1.25);
});

test("the le label is omitted from data point attributes", () => {
  const out = toOtlpJson(
    [
      {
        name: "h",
        help: "x",
        type: "histogram",
        values: [
          {
            metricName: "h_bucket",
            value: 1,
            labels: { route: "/a", le: "0.005" },
          },
          {
            metricName: "h_bucket",
            value: 1,
            labels: { route: "/a", le: "+Inf" },
          },
          { metricName: "h_sum", value: 0.001, labels: { route: "/a" } },
          { metricName: "h_count", value: 1, labels: { route: "/a" } },
        ],
      },
    ],
    START,
    NOW
  ) as any[];

  const keys = out[0].histogram.dataPoints[0].attributes.map((a: any) => a.key);
  assert.deepStrictEqual(keys, ["route"]);
});

test("distinct label sets become separate data points", () => {
  const out = toOtlpJson(
    [
      {
        name: "h",
        help: "x",
        type: "histogram",
        values: [
          {
            metricName: "h_bucket",
            value: 1,
            labels: { route: "/a", le: "+Inf" },
          },
          { metricName: "h_sum", value: 0.1, labels: { route: "/a" } },
          { metricName: "h_count", value: 1, labels: { route: "/a" } },
          {
            metricName: "h_bucket",
            value: 3,
            labels: { route: "/b", le: "+Inf" },
          },
          { metricName: "h_sum", value: 0.9, labels: { route: "/b" } },
          { metricName: "h_count", value: 3, labels: { route: "/b" } },
        ],
      },
    ],
    START,
    NOW
  ) as any[];

  assert.strictEqual(out[0].histogram.dataPoints.length, 2);
});

test("gauge is not wrapped as a sum", () => {
  const out = toOtlpJson(
    [
      {
        name: "app_build_info",
        help: "x",
        type: "gauge",
        values: [{ value: 1, labels: { service: "a" } }],
      },
    ],
    START,
    NOW
  ) as any[];

  assert.ok(out[0].gauge);
  assert.ok(!out[0].sum);
});
