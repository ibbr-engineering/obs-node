import { initObservability, type Observability, type ObservabilityConfig } from '../index';
import type { RouterTable } from '../routes';

/**
 * Adaptor LoopBack 3.
 *
 * LB3 tidak menghasilkan OpenAPI yang bisa diandalkan (§5.4), tapi ia tetap
 * punya tabel rute: strong-remoting tahu persis endpoint REST apa saja yang
 * ia daftarkan. Itulah lapis 1 untuk LB3.
 *
 * Tabel dibangun malas (lazy) karena rute belum lengkap saat middleware
 * dipasang — LB3 mendaftarkan REST adapter-nya saat boot selesai, sedangkan
 * instrumentasi harus dipasang lebih awal supaya ikut mengukur middleware
 * lain di depannya.
 */

interface CompiledRoute {
  method: string;
  re: RegExp;
  template: string;
}

interface Lb3Route {
  verb?: string;
  method?: string;
  path?: string;
}

const PARAM = /:([A-Za-z0-9_]+)/g;

function toRegExp(template: string): RegExp {
  const escaped = template
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // `\\:param` setelah escape di atas — kembalikan jadi penangkap segmen.
    .replace(/:([A-Za-z0-9_]+)/g, '[^/]+');
  return new RegExp(`^${escaped}/?$`);
}

function collectRoutes(app: any): Lb3Route[] {
  const remotes = typeof app?.remotes === 'function' ? app.remotes() : undefined;
  if (!remotes) return [];

  // Jalur utama: RestAdapter LB3 mengekspos seluruh rute REST-nya.
  const adapter = remotes.adapter;
  if (adapter && typeof adapter.allRoutes === 'function') {
    try {
      return adapter.allRoutes() as Lb3Route[];
    } catch {
      /* jatuh ke cadangan di bawah */
    }
  }

  // Cadangan: metadata strong-remoting mentah. Kurang rapi, tapi tetap jauh
  // lebih akurat daripada menebak dari path.
  if (typeof remotes.listMethods === 'function') {
    try {
      return (remotes.listMethods() as any[])
        .filter((m) => m?.http)
        .flatMap((m) => (Array.isArray(m.http) ? m.http : [m.http]))
        .map((h: any) => ({ verb: h.verb, path: h.path }));
    } catch {
      /* menyerah — heuristik lapis 2 yang menangani */
    }
  }

  return [];
}

export function loopback3RouterTable(app: any): RouterTable {
  let compiled: CompiledRoute[] | undefined;
  let attempts = 0;

  const build = (): CompiledRoute[] => {
    const restApiRoot: string = app?.get?.('restApiRoot') ?? '/api';
    const routes = collectRoutes(app);

    return (
      routes
        .filter((r) => typeof r.path === 'string')
        .map((r) => {
          const path = r.path as string;
          const template = path.startsWith(restApiRoot) ? path : `${restApiRoot}${path}`;
          return {
            method: String(r.verb ?? r.method ?? 'GET').toUpperCase(),
            re: toRegExp(template),
            template,
          };
        })
        // Rute paling spesifik lebih dulu: tanpa ini `/api/Patients/:id`
        // akan menelan `/api/Patients/count` dan endpoint itu hilang dari
        // dashboard tanpa jejak.
        .sort((a, b) => {
          const paramsA = (a.template.match(PARAM) ?? []).length;
          const paramsB = (b.template.match(PARAM) ?? []).length;
          if (paramsA !== paramsB) return paramsA - paramsB;
          return b.template.length - a.template.length;
        })
    );
  };

  return {
    match(method: string, path: string): string | undefined {
      if (!compiled || (compiled.length === 0 && attempts < 5)) {
        attempts += 1;
        compiled = build();
      }
      const wanted = method.toUpperCase();
      for (const r of compiled) {
        if ((r.method === wanted || r.method === 'ALL') && r.re.test(path)) {
          return r.template;
        }
      }
      return undefined;
    },
  };
}

export interface Loopback3Options extends Omit<ObservabilityConfig, 'routerTable'> {
  /**
   * Fase middleware LB3. `initial` mengukur seluruh pipeline termasuk
   * middleware lain — itu yang diinginkan, karena latensi yang dirasakan
   * klien mencakup semuanya.
   */
  phase?: string;
}

/**
 * Pasang instrumentasi ke aplikasi LB3.
 *
 *   const obs = instrumentLoopback3(app, {
 *     service: 'ibbr-backend', tier: 'T1', routeConfig: './routes.yaml',
 *   });
 *
 * Panggil SEBELUM `boot()` selesai — idealnya di server/server.js tepat
 * setelah `var app = loopback()`.
 */
export function instrumentLoopback3(app: any, options: Loopback3Options): Observability {
  const obs = initObservability({
    ...options,
    routerTable: loopback3RouterTable(app),
  });

  const phase = options.phase ?? 'initial';
  const metricsPath = options.metricsPath ?? '/metrics';
  const needsEndpoint = (options.transport ?? 'scrape') !== 'push';

  const measure = obs.middleware();
  const serveMetrics = obs.metricsHandler();

  // /metrics DILAYANI DARI DALAM MIDDLEWARE FASE `initial`, bukan sebagai
  // route lewat app.get().
  //
  // Route Express berjalan SETELAH seluruh fase middleware LB3 — termasuk
  // `auth`. Aplikasi yang memasang autentikasi di sana akan membalas 401
  // untuk /metrics, dan Prometheus melihatnya sebagai target down tanpa
  // petunjuk apa pun bahwa penyebabnya auth. Menyajikannya di fase `initial`
  // membuatnya kebal terhadap apa pun yang dipasang aplikasi sesudahnya.
  //
  // Ini juga alasan endpoint-nya tidak boleh ikut terukur: ia dilayani dan
  // dihentikan sebelum measure() sempat dipanggil.
  app.middleware(phase, function observabilityPhase(req: any, res: any, next: (err?: any) => void) {
    if (needsEndpoint) {
      const pathname = String(req.originalUrl ?? req.url ?? '').split('?')[0];
      if (pathname === metricsPath) {
        return serveMetrics(req, res);
      }
    }
    return measure(req, res, next);
  });

  return obs;
}
