import * as assert from 'assert';
import { test } from 'node:test';

import { RouteNormalizer, heuristic } from '../src/routes';
import { OVERFLOW_ROUTE } from '../src/contract';

test('heuristik mengganti ObjectId MongoDB jadi :id', () => {
  assert.strictEqual(
    heuristic('/api/patients/507f1f77bcf86cd799439011/visits'),
    '/api/patients/:id/visits'
  );
});

test('heuristik membedakan tanggal dari angka biasa', () => {
  // Urutan aturan penting di sini: 2026-08-03 tidak boleh pecah jadi angka.
  assert.strictEqual(heuristic('/api/reports/2026-08-03'), '/api/reports/:date');
  assert.strictEqual(heuristic('/api/reports/2026/08'), '/api/reports/:n/:n');
});

test('heuristik mengenali UUID dan token panjang', () => {
  assert.strictEqual(
    heuristic('/s/3f2504e0-4f89-11d3-9a0c-0305e82c3301'),
    '/s/:uuid'
  );
  assert.strictEqual(heuristic(`/d/${'a'.repeat(48)}`), '/d/:token');
});

test('query string tidak pernah masuk ke template', () => {
  assert.strictEqual(heuristic('/api/search?q=budi&page=2'), '/api/search');
});

test('cardinality guard adalah plafon keras', () => {
  const n = new RouteNormalizer({ maxRoutes: 3, routeConfig: {} });

  // Satu slot sudah dipakai __other__, jadi hanya 2 route nyata yang muat.
  assert.strictEqual(n.normalize('GET', '/a'), '/a');
  assert.strictEqual(n.normalize('GET', '/b'), '/b');
  assert.strictEqual(n.normalize('GET', '/c'), OVERFLOW_ROUTE);
  assert.strictEqual(n.normalize('GET', '/d'), OVERFLOW_ROUTE);

  // Route yang sudah dikenal tetap dilayani meski plafon sudah penuh.
  assert.strictEqual(n.normalize('GET', '/a'), '/a');
  assert.strictEqual(n.cardinality, 3);
  assert.strictEqual(n.overflows, 2);
});

test('override routes.yaml menang atas heuristik', () => {
  const n = new RouteNormalizer({
    routeConfig: {
      overrides: [{ pattern: '^/api/clinics/[^/]+/slots$', template: '/api/clinics/:slug/slots' }],
    },
  });

  // "jakarta-pusat" bukan ObjectId/UUID/angka, jadi heuristik akan
  // membiarkannya apa adanya — di sinilah override berguna.
  assert.strictEqual(
    n.normalize('GET', '/api/clinics/jakarta-pusat/slots'),
    '/api/clinics/:slug/slots'
  );
});

test('path di daftar ignore dikenali', () => {
  const n = new RouteNormalizer({ routeConfig: { ignore: ['^/health$', '^/readyz$'] } });
  assert.ok(n.shouldIgnore('/health'));
  assert.ok(n.shouldIgnore('/readyz?verbose=1'));
  assert.ok(!n.shouldIgnore('/api/patients'));
});

test('tabel rute framework (lapis 1) menang atas heuristik', () => {
  const n = new RouteNormalizer({
    routerTable: {
      match: (_m, path) => (path.startsWith('/api/Patients/') ? '/api/Patients/:id' : undefined),
    },
  });

  // Heuristik akan menghasilkan /api/Patients/:n untuk ini; lapis 1 lebih tahu.
  assert.strictEqual(n.normalize('GET', '/api/Patients/12345'), '/api/Patients/:id');
  assert.strictEqual(n.normalize('GET', '/other/12345'), '/other/:n');
});

test('onUnmatched menerima path mentah, bukan template', () => {
  const seen: string[] = [];
  const n = new RouteNormalizer({
    maxRoutes: 1,
    onUnmatched: (_m, path) => seen.push(path),
  });

  n.normalize('GET', '/api/patients/507f1f77bcf86cd799439011');
  // Path mentah inilah yang dipakai laporan mingguan untuk mengisi
  // routes.yaml — kalau di sini sudah ternormalisasi, laporannya tidak berguna.
  assert.deepStrictEqual(seen, ['/api/patients/507f1f77bcf86cd799439011']);
});

// --- regresi: prefiks mount yang hilang -----------------------------------
// Ditemukan saat memasang ke ibbr-backend: LB3 me-mount seluruh REST API di
// restApiRoot (/api), sehingga req.route.path relatif dan req.baseUrl sudah
// dipulihkan Express saat event 'finish'. Tanpa koreksi, /api/Accounts/:id
// terbaca "/:id" dan SETIAP model bertabrakan jadi label yang sama.
import { initObservability } from '../src/index';
import { fakeRes } from './helpers';

async function routeLabelFor(req: any): Promise<string> {
  const obs = initObservability({
    service: 'mount-test', tier: 'T1', defaultMetrics: false, logger: () => undefined,
  });
  const res = fakeRes(200);
  obs.middleware()(req, res, () => undefined);
  res.emit('finish');
  const body = await obs.render();
  obs.shutdown();
  return (body.match(/route="([^"]*)"/) ?? [])[1] ?? '';
}

test('prefiks mount dikembalikan saat route.path relatif', async () => {
  // Persis bentuk yang dihasilkan LB3: route ":id" relatif, baseUrl kosong.
  const label = await routeLabelFor({
    method: 'GET',
    originalUrl: '/api/Accounts/507f1f77bcf86cd799439011',
    url: '/api/Accounts/507f1f77bcf86cd799439011',
    baseUrl: '',
    route: { path: '/:id' },
  });
  assert.strictEqual(label, '/api/Accounts/:id');
});

test('route "/" pada sub-router dapat prefiks penuh', async () => {
  const label = await routeLabelFor({
    method: 'GET',
    originalUrl: '/api/Accounts',
    url: '/api/Accounts',
    baseUrl: '',
    route: { path: '/' },
  });
  assert.strictEqual(label, '/api/Accounts');
});

test('route absolut tidak diubah', async () => {
  // Express biasa yang mendaftarkan rute penuh — tidak boleh dapat prefiks.
  const label = await routeLabelFor({
    method: 'GET',
    originalUrl: '/api/patients/123',
    url: '/api/patients/123',
    baseUrl: '',
    route: { path: '/api/patients/:id' },
  });
  assert.strictEqual(label, '/api/patients/:id');
});

// Skenario ini kembar dengan TestOverrideIsSubjectToCap di libs/go.
// Keduanya harus memberi angka yang sama; itu yang menjadikan "satu kontrak,
// dua implementasi" bisa dipercaya.
test('override tunduk pada plafon, bukan kebal terhadapnya', () => {
  const n = new RouteNormalizer({
    maxRoutes: 3, // __other__ memakai satu slot, jadi sisa 2 untuk route nyata
    routeConfig: {
      overrides: [
        { pattern: '^/a$', template: '/a' },
        { pattern: '^/b$', template: '/b' },
        { pattern: '^/c$', template: '/c' },
      ],
    },
  });

  assert.strictEqual(n.normalize('GET', '/a'), '/a');
  assert.strictEqual(n.normalize('GET', '/b'), '/b');
  // Slot habis. Meski /c punya override eksplisit, ia tetap jatuh ke __other__.
  assert.strictEqual(n.normalize('GET', '/c'), OVERFLOW_ROUTE);

  assert.strictEqual(n.cardinality, 3);
  assert.strictEqual(n.overflows, 1);
});

// Regresi: SPA fallback `app.get('*')` membuat req.route.path = '*'.
// Sebelum perbaikan, koreksi prefiks menempelkan segmen path asli ke '*'
// dan menghasilkan "/promo/507f1f77bcf86cd799439011*" — ID mentah bocor
// jadi label metrik, dan heuristik tidak pernah kebagian menormalkannya.
test('route catch-all tidak dipakai sebagai template, heuristik yang menangani', async () => {
  const label = await routeLabelFor({
    method: 'GET',
    originalUrl: '/promo/507f1f77bcf86cd799439011/edit',
    url: '/promo/507f1f77bcf86cd799439011/edit',
    baseUrl: '',
    route: { path: '*' },
  });
  assert.strictEqual(label, '/promo/:id/edit');
});
