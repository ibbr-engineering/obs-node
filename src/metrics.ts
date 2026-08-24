import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import {
  CONTRACT_VERSION,
  DEPENDENCY_BUCKETS,
  DURATION_BUCKETS,
  LABELS,
  METRIC,
} from './contract';
import { resolveEnv } from './env';
import { REPLICA_ID } from './replica';
import type { RouteNormalizer } from './routes';

/**
 * Semua instrumen hidup di Registry sendiri, bukan di global default
 * prom-client. Kalau aplikasi sudah memakai prom-client untuk keperluan lain,
 * keduanya tidak saling menimpa dan /metrics kita tetap sesuai kontrak.
 */

export interface MetricsOptions {
  service: string;
  /** Nama environment. Tidak pernah kosong — lihat src/env.ts. */
  env: string;
  version: string;
  commit: string;
  tier: string;
  /** Nama publik, deskripsi singkat, dan status "tampil di status page publik". */
  displayName: string;
  description: string;
  public: boolean;
  /** Sertakan metrik proses Node (heap, event loop lag, GC). */
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
      help: 'Total HTTP request yang diterima server.',
      labelNames: LABELS.requests as unknown as string[],
      registers: [registry],
    });

    this.duration = new Histogram({
      name: METRIC.duration,
      help: 'Durasi penanganan HTTP request dalam detik.',
      labelNames: LABELS.duration as unknown as string[],
      buckets: [...DURATION_BUCKETS],
      registers: [registry],
    });

    this.responseBytes = new Counter({
      name: METRIC.responseBytes,
      help: 'Total byte body respons yang dikirim server.',
      labelNames: LABELS.responseBytes as unknown as string[],
      registers: [registry],
    });

    this.inFlight = new Gauge({
      name: METRIC.inFlight,
      help: 'Jumlah HTTP request yang sedang diproses.',
      labelNames: LABELS.inFlight as unknown as string[],
      registers: [registry],
    });

    this.buildInfo = new Gauge({
      name: METRIC.buildInfo,
      help: 'Selalu 1. Label membawa identitas build & versi kontrak.',
      labelNames: LABELS.buildInfo as unknown as string[],
      registers: [registry],
    });

    this.routeCardinality = new Gauge({
      name: METRIC.routeCardinality,
      help: 'Jumlah template route unik yang sedang dilacak service ini.',
      labelNames: LABELS.routeCardinality as unknown as string[],
      registers: [registry],
    });

    this.routeOverflow = new Counter({
      name: METRIC.routeOverflow,
      help: 'Jumlah request yang jatuh ke label route __other__.',
      labelNames: LABELS.routeOverflow as unknown as string[],
      registers: [registry],
    });

    this.dependency = new Histogram({
      name: METRIC.dependency,
      help: 'Durasi panggilan ke dependency eksternal.',
      labelNames: LABELS.dependency as unknown as string[],
      buckets: [...DEPENDENCY_BUCKETS],
      registers: [registry],
    });

    // Sentuh seri berlabel `service` supaya ia ada sejak proses start, bukan
    // baru muncul setelah request pertama. Panel "in-flight" dan "overflow"
    // di L1 jadi menampilkan 0 alih-alih "no data" untuk service sehat yang
    // sedang sepi — dan "no data" tidak bisa dibedakan dari instrumentasi
    // yang rusak. Implementasi Go melakukan hal yang sama.
    this.inFlight.set({ service: options.service, env: options.env, replica_id: REPLICA_ID }, 0);
    this.routeOverflow.inc({ service: options.service, env: options.env, replica_id: REPLICA_ID }, 0);

    // app_build_info di-set sekali dan tidak pernah berubah selama proses
    // hidup. Ia yang membuat penanda deploy dan deteksi drift kontrak bekerja.
    this.buildInfo.set(
      {
        service: options.service,
        env: options.env,
        version: options.version,
        commit: options.commit,
        tier: options.tier,
        contract_version: CONTRACT_VERSION,
        lang: 'node',
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

  /**
   * obs_route_cardinality adalah gauge yang nilainya hanya diketahui saat
   * ditanya, jadi ia disegarkan tepat sebelum registry di-render — bukan
   * di-set tiap request.
   */
  bindRouteStats(normalizer: RouteNormalizer): void {
    this.routeCardinality.set(
      { service: this.options.service, env: this.options.env, replica_id: REPLICA_ID },
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
