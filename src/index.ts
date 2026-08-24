import { CONTRACT_VERSION, OVERFLOW_ROUTE, statusClass, type Tier } from './contract';
import { sanitizeLabels } from './guard';
import { Metrics } from './metrics';
import { resolveEnv } from './env';
import { OtlpPusher } from './otlp';
import { REPLICA_ID } from './replica';
import { RouteNormalizer, type RouterTable, type RoutesConfig } from './routes';

export { CONTRACT_VERSION, OVERFLOW_ROUTE, statusClass } from './contract';
export { RouteNormalizer, heuristic, type RouterTable, type RoutesConfig } from './routes';
export { sanitizeLabels } from './guard';
export type { Tier } from './contract';

export type Transport = 'scrape' | 'push' | 'both';

export interface ObservabilityConfig {
  /** Harus sama persis dengan label `service` di targets/apps.yml. */
  service: string;
  version?: string;
  commit?: string;
  tier: Tier;

  /**
   * Nama environment (`prod`, `uat`, `dev`, `local`). Kalau tidak diisi,
   * diambil dari `ENV` → `APP_ENV` → `NODE_ENV`, dan terakhir `"unknown"`.
   *
   * Nilainya TIDAK PERNAH kosong dengan sengaja: job `apps` di Prometheus
   * memakai `honor_labels: true`, jadi label dari aplikasi menang atas label
   * target. Mengirim env kosong akan menghapus `env` dari setiap dashboard
   * yang memfilternya, tanpa error apa pun. Lihat src/env.ts.
   */
  env?: string;

  /** Nama publik yang ditampilkan di status page/Perses (bukan label `service`). */
  displayName?: string;
  /** Deskripsi singkat, satu-dua kalimat, untuk status page. */
  description?: string;
  /** Tampil di status page publik. Default false — harus didaftarkan sengaja. */
  public?: boolean;

  /**
   * scrape — expose /metrics, Prometheus yang menarik (VM, dev lokal)
   * push   — dorong OTLP ke collector terpusat (Cloud Run, zero sidecar)
   * both   — keduanya; berguna saat migrasi supaya bisa dibandingkan
   */
  transport?: Transport;

  /** Path atau objek routes.yaml (lapis 4 route templating). */
  routeConfig?: string | RoutesConfig;
  /** Tabel rute framework (lapis 1). Diisi adaptor. */
  routerTable?: RouterTable;
  maxRoutes?: number;

  metricsPath?: string;
  /** Metrik proses Node: heap, event loop lag, GC. Default true. */
  defaultMetrics?: boolean;

  otlpEndpoint?: string;
  pushIntervalMs?: number;

  /**
   * Porsi path tak dikenali yang dicatat sebagai log terstruktur.
   * Bukan sebagai label — kalau path mentah jadi label, ledakan kardinalitas
   * yang dicegah lapis 3 masuk lagi lewat pintu belakang (§5.4).
   */
  unmatchedSampleRate?: number;
  logger?: (event: Record<string, unknown>) => void;
}

export interface DependencyTiming {
  dependency: string;
  operation: string;
  outcome?: 'ok' | 'error';
}

export interface Observability {
  readonly metrics: Metrics;
  readonly normalizer: RouteNormalizer;
  /** Middleware gaya Express: (req, res, next). */
  middleware(): (req: any, res: any, next: (err?: any) => void) => void;
  /** Handler untuk endpoint /metrics. */
  metricsHandler(): (req: any, res: any) => void;
  /** Bungkus panggilan dependency dan catat durasinya. */
  time<T>(timing: DependencyTiming, fn: () => Promise<T>): Promise<T>;
  /** Render teks eksposisi Prometheus — dipakai test & debugging. */
  render(): Promise<string>;
  pushOnce(): Promise<void>;
  shutdown(): void;
}

const defaultLogger = (event: Record<string, unknown>): void => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(event));
};

export function initObservability(config: ObservabilityConfig): Observability {
  const service = config.service;
  const transport: Transport = config.transport ?? 'scrape';
  const metricsPath = config.metricsPath ?? '/metrics';
  const log = config.logger ?? defaultLogger;
  const unmatchedSampleRate = config.unmatchedSampleRate ?? 0.01;

  const env = resolveEnv(config.env);

  const metrics = new Metrics({
    service,
    env,
    version: config.version ?? process.env.BUILD_SHA ?? 'unknown',
    commit: config.commit ?? process.env.GIT_COMMIT ?? 'unknown',
    tier: config.tier,
    displayName: config.displayName ?? '',
    description: config.description ?? '',
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
          level: 'info',
          msg: 'obs.route.unmatched',
          service,
          method,
          // Field log, bukan label metrik. Inilah yang dibaca laporan
          // mingguan untuk mengisi routes.yaml.
          path,
        });
      }
    },
  });

  let pusher: OtlpPusher | undefined;
  if (transport === 'push' || transport === 'both') {
    const endpoint =
      config.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
    pusher = new OtlpPusher({
      endpoint,
      registry: metrics.registry,
      intervalMs: config.pushIntervalMs ?? 30_000,
      serviceName: service,
      beforeCollect: () => metrics.bindRouteStats(normalizer),
      onError: (err) =>
        log({ level: 'warn', msg: 'obs.push.failed', service, error: err.message }),
    });
    pusher.start();
  }

  function middleware() {
    return function observabilityMiddleware(req: any, res: any, next: (err?: any) => void): void {
      const path: string = req.originalUrl ?? req.url ?? '/';

      // Health check dan readiness probe tidak dihitung: mereka mendominasi
      // jumlah request dan mengaburkan error rate yang sebenarnya.
      if (normalizer.shouldIgnore(path) || path.split('?')[0] === metricsPath) {
        return next();
      }

      const method = String(req.method ?? 'GET').toUpperCase();
      const startedAt = process.hrtime.bigint();
      metrics.inFlight.inc({ service, env, replica_id: REPLICA_ID });

      // Byte body dihitung dengan membungkus write/end, BUKAN dari header
      // Content-Length: respons chunked (streaming, compression, SSE) tidak
      // pernah menyetelnya, dan justru respons besar yang paling sering
      // chunked — persis yang ingin diukur. Yang dihitung hanya body;
      // header tidak termasuk.
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
                typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined
              );
        } catch {
          // Chunk bertipe tak terduga tidak boleh menjatuhkan response.
        }
      };
      res.write = function patchedWrite(chunk: any, encoding?: any, cb?: any) {
        countChunk(chunk, encoding);
        return origWrite.call(this, chunk, encoding, cb);
      };
      res.end = function patchedEnd(chunk: any, encoding?: any, cb?: any) {
        if (typeof chunk !== 'function') countChunk(chunk, encoding);
        return origEnd.call(this, chunk, encoding, cb);
      };

      let finished = false;
      const onDone = (): void => {
        if (finished) return;
        finished = true;
        res.removeListener('finish', onDone);
        res.removeListener('close', onDone);

        metrics.inFlight.dec({ service, env, replica_id: REPLICA_ID });

        const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
        const status = Number(res.statusCode ?? 0);

        // Rute baru diketahui SETELAH handler jalan — di Express dan LB3,
        // req.route diisi router saat mencocokkan. Menormalkan di awal
        // request akan selalu melewatkan lapis 1.
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

      res.on('finish', onDone);
      // 'close' menangkap klien yang memutus sambungan sebelum respons
      // selesai. Tanpa ini, in-flight gauge bocor naik dan tidak pernah turun.
      res.on('close', onDone);

      next();
    };
  }

  function metricsHandler() {
    return function handleMetrics(_req: any, res: any): void {
      metrics
        .render(normalizer)
        .then((body) => {
          res.setHeader('content-type', metrics.contentType);
          res.end(body);
        })
        .catch((err: Error) => {
          res.statusCode = 500;
          res.end(`# gagal render metrik: ${err.message}\n`);
        });
    };
  }

  async function time<T>(timing: DependencyTiming, fn: () => Promise<T>): Promise<T> {
    const startedAt = process.hrtime.bigint();
    let outcome: 'ok' | 'error' = 'ok';
    try {
      return await fn();
    } catch (err) {
      outcome = 'error';
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
    level: 'info',
    msg: 'obs.initialized',
    service,
    tier: config.tier,
    transport,
    contract_version: CONTRACT_VERSION,
    metrics_path: transport === 'push' ? null : metricsPath,
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

/**
 * Template rute yang sudah dicocokkan framework, kalau ada. Ini lapis 1 dalam
 * bentuk paling murah — tidak perlu tabel rute sama sekali kalau router
 * kebetulan sudah menuliskannya di request.
 */
function routeHint(req: any): string | undefined {
  const routePath = req?.route?.path;
  if (typeof routePath !== 'string') return undefined;

  // Route catch-all (`app.get('*')`, umum untuk SPA fallback) tidak membawa
  // informasi template apa pun. Kalau tetap dikembalikan, koreksi prefiks di
  // bawah menempelkan segmen path ASLI ke '*' — menghasilkan label seperti
  // "/promo/507f1f77bcf86cd799439011*": ID mentah bocor jadi label, dan
  // lapis 2 (heuristik) maupun lapis 4 (override) tidak pernah kebagian
  // memperbaikinya. Menolak di sini membuat path asli jatuh ke lapis itu.
  if (routePath.includes('*')) return undefined;

  const base = typeof req.baseUrl === 'string' ? req.baseUrl : '';
  let template = `${base}${routePath}` || '/';

  // Kembalikan prefiks mount yang hilang.
  //
  // `req.route.path` bersifat RELATIF terhadap router yang menanganinya, dan
  // Express memulihkan `req.baseUrl` sebelum event 'finish' — yaitu saat
  // middleware ini mengukur. Di LB3, seluruh REST API di-mount di
  // `restApiRoot` (/api), sehingga tanpa koreksi ini /api/Accounts/:id
  // terbaca sebagai "/:id" dan SETIAP model bertabrakan jadi label yang sama.
  //
  // Prefiksnya dipulihkan dengan mencocokkan jumlah segmen terhadap path
  // asli: kelebihan segmen di path asli adalah mount point yang terpotong.
  const original = String(req.originalUrl ?? req.url ?? '').split('?')[0];
  const templateSegments = template.split('/').filter(Boolean).length;
  const originalSegments = original.split('/').filter(Boolean);

  if (originalSegments.length > templateSegments) {
    const prefix = originalSegments
      .slice(0, originalSegments.length - templateSegments)
      .map((s) => `/${s}`)
      .join('');
    template = template === '/' ? prefix : `${prefix}${template}`;
  }

  return template || '/';
}
