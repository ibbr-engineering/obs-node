import * as assert from 'assert';
import { test } from 'node:test';

import { toOtlpJson } from '../src/otlp';

/**
 * Konversi histogram adalah bagian paling mudah salah di jalur push, dan
 * salahnya tidak terlihat: dashboard tetap tampil, angkanya saja yang keliru.
 * Prometheus menghitung bucket secara kumulatif, OTLP tidak.
 */

const START = '1000000000';
const NOW = '2000000000';

test('counter jadi sum monotonik kumulatif', () => {
  const out = toOtlpJson(
    [
      {
        name: 'http_server_requests_total',
        help: 'x',
        type: 'counter',
        values: [{ value: 7, labels: { service: 'a', status: '200' } }],
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

test('bucket kumulatif Prometheus jadi hitungan per-bucket OTLP', () => {
  const out = toOtlpJson(
    [
      {
        name: 'http_server_duration_seconds',
        help: 'x',
        type: 'histogram',
        values: [
          { metricName: 'http_server_duration_seconds_bucket', value: 2, labels: { service: 'a', le: '0.005' } },
          { metricName: 'http_server_duration_seconds_bucket', value: 5, labels: { service: 'a', le: '0.01' } },
          { metricName: 'http_server_duration_seconds_bucket', value: 9, labels: { service: 'a', le: '+Inf' } },
          { metricName: 'http_server_duration_seconds_sum', value: 1.25, labels: { service: 'a' } },
          { metricName: 'http_server_duration_seconds_count', value: 9, labels: { service: 'a' } },
        ],
      },
    ],
    START,
    NOW
  ) as any[];

  const dp = out[0].histogram.dataPoints[0];
  // Kumulatif 2, 5, 9 → selisih 2, 3, 4.
  assert.deepStrictEqual(dp.bucketCounts, ['2', '3', '4']);
  // +Inf tidak boleh muncul sebagai batas eksplisit.
  assert.deepStrictEqual(dp.explicitBounds, [0.005, 0.01]);
  // OTLP mewajibkan bucketCounts tepat satu lebih banyak dari explicitBounds.
  assert.strictEqual(dp.bucketCounts.length, dp.explicitBounds.length + 1);
  assert.strictEqual(dp.count, '9');
  assert.strictEqual(dp.sum, 1.25);
});

test('label `le` tidak ikut jadi atribut data point', () => {
  const out = toOtlpJson(
    [
      {
        name: 'h',
        help: 'x',
        type: 'histogram',
        values: [
          { metricName: 'h_bucket', value: 1, labels: { route: '/a', le: '0.005' } },
          { metricName: 'h_bucket', value: 1, labels: { route: '/a', le: '+Inf' } },
          { metricName: 'h_sum', value: 0.001, labels: { route: '/a' } },
          { metricName: 'h_count', value: 1, labels: { route: '/a' } },
        ],
      },
    ],
    START,
    NOW
  ) as any[];

  const keys = out[0].histogram.dataPoints[0].attributes.map((a: any) => a.key);
  assert.deepStrictEqual(keys, ['route']);
});

test('label set berbeda jadi data point terpisah', () => {
  const out = toOtlpJson(
    [
      {
        name: 'h',
        help: 'x',
        type: 'histogram',
        values: [
          { metricName: 'h_bucket', value: 1, labels: { route: '/a', le: '+Inf' } },
          { metricName: 'h_sum', value: 0.1, labels: { route: '/a' } },
          { metricName: 'h_count', value: 1, labels: { route: '/a' } },
          { metricName: 'h_bucket', value: 3, labels: { route: '/b', le: '+Inf' } },
          { metricName: 'h_sum', value: 0.9, labels: { route: '/b' } },
          { metricName: 'h_count', value: 3, labels: { route: '/b' } },
        ],
      },
    ],
    START,
    NOW
  ) as any[];

  assert.strictEqual(out[0].histogram.dataPoints.length, 2);
});

test('gauge tidak dibungkus sebagai sum', () => {
  const out = toOtlpJson(
    [{ name: 'app_build_info', help: 'x', type: 'gauge', values: [{ value: 1, labels: { service: 'a' } }] }],
    START,
    NOW
  ) as any[];

  assert.ok(out[0].gauge);
  assert.ok(!out[0].sum);
});
