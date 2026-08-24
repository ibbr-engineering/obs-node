import * as assert from 'assert';
import * as fs from 'fs';
import { test } from 'node:test';
import * as yaml from 'js-yaml';

import { initObservability } from '../src/index';
import { CONTRACT_VERSION, DURATION_BUCKETS } from '../src/contract';
import { contractPath, fakeRes, goldenPath, shapeOf } from './helpers';

/**
 * INI GERBANG YANG MENENTUKAN APAKAH DESAIN INI BERTAHAN (§5.2).
 *
 * Tanpa test ini, implementasi Node dan Go akan berbeda dalam 3 bulan dan
 * dashboard lintas-bahasa jadi mustahil. Yang diperiksa: nama metrik dan
 * kunci label yang benar-benar keluar dari /metrics, dibandingkan dengan
 * contract/metrics-contract.yaml — bukan dengan konstanta di dalam library
 * ini, karena itu hanya akan menguji library terhadap dirinya sendiri.
 */

interface ContractFile {
  version: string;
  metrics: Array<{ name: string; type: string; labels: string[]; buckets?: number[]; optional?: boolean }>;
  constraints: { max_routes_per_service: number; overflow_label: string };
}

function loadContract(): ContractFile {
  return yaml.load(fs.readFileSync(contractPath(), 'utf8')) as ContractFile;
}

/** Jalankan sample app secukupnya supaya SETIAP metrik kontrak terisi. */
async function exerciseSampleApp(): Promise<string> {
  const obs = initObservability({
    service: 'conformance-app',
    version: '1.2.3',
    commit: 'abc1234',
    tier: 'T1',
    transport: 'scrape',
    defaultMetrics: false,
    logger: () => undefined,
  });

  const mw = obs.middleware();
  for (const [path, status] of [
    ['/api/patients/507f1f77bcf86cd799439011', 200],
    ['/api/patients', 500],
    ['/api/reports/2026/08', 404],
  ] as Array<[string, number]>) {
    const res = fakeRes(status);
    mw({ method: 'GET', url: path, originalUrl: path }, res, () => undefined);
    res.emit('finish');
  }

  await obs.time({ dependency: 'mongodb', operation: 'find' }, async () => 'ok');

  // Paksa jalur overflow supaya obs_route_overflow_total ikut muncul.
  const tight = initObservability({
    service: 'conformance-app',
    tier: 'T1',
    maxRoutes: 1,
    defaultMetrics: false,
    logger: () => undefined,
  });
  const tightMw = tight.middleware();
  for (const path of ['/a', '/b', '/c']) {
    const res = fakeRes(200);
    tightMw({ method: 'GET', url: path, originalUrl: path }, res, () => undefined);
    res.emit('finish');
  }
  const overflowShapes = await tight.render();
  tight.shutdown();

  const main = await obs.render();
  obs.shutdown();
  return `${main}\n${overflowShapes}`;
}

test('versi kontrak di library sama dengan di YAML', () => {
  assert.strictEqual(CONTRACT_VERSION, loadContract().version);
});

test('bucket histogram sama persis dengan kontrak', () => {
  const contract = loadContract();
  const duration = contract.metrics.find((m) => m.name === 'http_server_duration_seconds');
  assert.ok(duration?.buckets, 'kontrak harus mendefinisikan bucket');
  assert.deepStrictEqual([...DURATION_BUCKETS], duration.buckets);
});

test('setiap metrik wajib di kontrak benar-benar keluar dari /metrics', async () => {
  const exposition = await exerciseSampleApp();
  const emitted = new Set(shapeOf(exposition).map((s) => s.split('{')[0]));

  for (const metric of loadContract().metrics) {
    if (metric.optional && !emitted.has(metric.name)) continue;

    // Histogram terpecah jadi _bucket/_sum/_count di teks eksposisi.
    const present =
      emitted.has(metric.name) ||
      emitted.has(`${metric.name}_bucket`) ||
      emitted.has(`${metric.name}_count`);

    assert.ok(present, `metrik "${metric.name}" ada di kontrak tapi tidak diemisikan`);
  }
});

test('kunci label tiap metrik sama persis dengan kontrak', async () => {
  const exposition = await exerciseSampleApp();
  const contract = loadContract();

  for (const shape of shapeOf(exposition)) {
    const [name, rest] = shape.split('{');
    const keys = rest.replace('}', '').split(',').filter(Boolean);

    const base = name.replace(/_(bucket|sum|count)$/, '');
    const spec = contract.metrics.find((m) => m.name === base || m.name === name);
    if (!spec) continue; // metrik default prom-client — di luar kontrak

    const allowed = new Set(spec.labels);
    if (name.endsWith('_bucket')) allowed.add('le'); // ditambahkan Prometheus

    for (const key of keys) {
      assert.ok(
        allowed.has(key),
        `label "${key}" pada "${name}" tidak ada di kontrak (izin: ${[...allowed].join(', ')})`
      );
    }
  }
});

test('bentuk /metrics cocok dengan golden file', async () => {
  const exposition = await exerciseSampleApp();
  const actual = shapeOf(exposition).filter((s) => !s.startsWith('nodejs_') && !s.startsWith('process_'));

  const golden = goldenPath();
  if (process.env.UPDATE_GOLDEN === '1') {
    fs.writeFileSync(golden, `${actual.join('\n')}\n`);
    return;
  }

  assert.ok(
    fs.existsSync(golden),
    `golden file belum ada. Buat dengan: UPDATE_GOLDEN=1 npm test`
  );
  const expected = fs.readFileSync(golden, 'utf8').trim().split('\n');
  assert.deepStrictEqual(
    actual,
    expected,
    'bentuk metrik berubah. Kalau ini disengaja, bump versi kontrak lalu jalankan UPDATE_GOLDEN=1 npm test'
  );
});
