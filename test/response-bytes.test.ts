import * as assert from 'assert';
import * as http from 'http';
import { test } from 'node:test';
import { initObservability } from '../src/index';

/**
 * Byte respons dihitung dari write/end, bukan dari Content-Length.
 * Test ini menjaga dua hal yang mudah rusak diam-diam:
 *
 *  1. Angkanya benar untuk respons biasa.
 *  2. Angkanya tetap benar untuk respons CHUNKED — yang tidak punya
 *     Content-Length sama sekali. Kalau implementasinya kembali membaca
 *     header, kasus kedua ini akan mencatat 0 dan tidak ada yang tahu,
 *     karena justru respons besar yang paling sering chunked.
 */

async function measure(handler: (req: any, res: any) => void): Promise<string> {
  const obs = initObservability({
    service: 'bytes-test',
    tier: 'T1',
    env: 'test',
    defaultMetrics: false,
    logger: () => {},
  });
  const measured = obs.middleware();

  const server = http.createServer((req, res) => {
    measured(req, res, () => handler(req, res));
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  await new Promise<void>((resolve, reject) => {
    http
      .get({ port, path: '/x' }, (res) => {
        res.resume();
        res.on('end', () => resolve());
      })
      .on('error', reject);
  });

  const body = await obs.render();
  server.close();
  obs.shutdown();
  return body;
}

function bytesFrom(exposition: string): number {
  const line = exposition
    .split('\n')
    .find((l) => l.startsWith('http_server_response_bytes_total{'));
  assert.ok(line, `metrik tidak ada:\n${exposition}`);
  return Number(line.slice(line.lastIndexOf(' ') + 1));
}

test('byte respons dihitung untuk body biasa', async () => {
  const payload = 'halo dunia';
  const body = await measure((_req, res) => {
    res.statusCode = 200;
    res.end(payload);
  });
  assert.strictEqual(bytesFrom(body), Buffer.byteLength(payload));
});

test('byte respons tetap terhitung untuk respons chunked tanpa Content-Length', async () => {
  const chunks = ['satu', 'dua', 'tiga'];
  const body = await measure((_req, res) => {
    res.statusCode = 200;
    // Tanpa Content-Length: Node mengirimnya sebagai chunked.
    for (const c of chunks) res.write(c);
    res.end();
  });
  const expected = chunks.reduce((n, c) => n + Buffer.byteLength(c), 0);
  assert.strictEqual(bytesFrom(body), expected);
});

test('env dari config muncul sebagai label, bukan string kosong', async () => {
  const body = await measure((_req, res) => res.end('x'));
  const line = body.split('\n').find((l) => l.startsWith('app_build_info{'));
  assert.ok(line?.includes('env="test"'), `env tidak benar:\n${line}`);
});
