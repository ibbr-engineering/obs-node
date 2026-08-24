import {inject} from '@loopback/context';
import {get, Response, RestBindings} from '@loopback/rest';
import { initObservability, type Observability, type ObservabilityConfig } from '../index';
import type { RouterTable } from '../routes';

/**
 * Adaptor LoopBack 4.
 *
 * Beda dari adaptor Express/LB3 dalam tiga hal:
 *
 * 1. Async, dan harus dipanggil SETELAH `app.boot()` — bukan sebelum boot
 *    seperti LB3. Controller LB4 baru terdaftar (lewat booter atau
 *    `this.controller(...)`) di titik itu, dan lapis 1 di sini memakai
 *    OpenAPI spec aplikasi (`getApiSpec()`, async) sebagai tabel rute —
 *    spec-nya sendiri sudah berupa template path yang benar (`{id}`
 *    tinggal diganti `:id`).
 *
 * 2. `/metrics` didaftarkan sebagai controller LB4 sungguhan (`@get`),
 *    bukan middleware yang mencoba bypass routing. `app.expressMiddleware()`
 *    di versi LoopBack ini dijembatani lewat sistem INTERCEPTOR (lihat
 *    @loopback/express), yang hanya jalan untuk request yang SUDAH cocok
 *    dengan rute — tidak pernah kena giliran untuk path yang tidak
 *    terdaftar. Controller biasa tidak match `@authenticate()` apa pun,
 *    jadi otomatis publik tanpa trik bypass tambahan.
 *
 * 3. Middleware pengukur RED (`measure`) tetap lewat `expressMiddleware()` —
 *    konsekuensinya ia hanya jalan untuk request yang berhasil di-invoke ke
 *    suatu method (dampak: 404 dan penolakan sebelum invokeMethod tidak
 *    ikut terukur di sini). Liveness tetap independen lewat blackbox probe
 *    (`up`), jadi ini bukan lubang buta total — cuma cakupan RED-nya lebih
 *    sempit dari adaptor Express/LB3.
 */

interface ApiSpecPaths {
  paths?: Record<string, Record<string, unknown>>;
}

interface RestServerLike {
  getApiSpec(): Promise<ApiSpecPaths>;
}

export interface Loopback4App {
  restServer: RestServerLike;
  expressMiddleware(
    factory: (...args: unknown[]) => unknown,
    config: unknown,
    options?: Record<string, unknown>
  ): unknown;
  controller(ctor: unknown, name?: string): unknown;
}

interface CompiledRoute {
  method: string;
  re: RegExp;
  template: string;
}

/**
 * Snapshot SEKALI dari OpenAPI spec, bukan dibaca ulang tiap request —
 * spec tidak berubah lagi setelah boot() selesai.
 */
async function openApiRouterTable(app: Loopback4App): Promise<RouterTable> {
  const spec = await app.restServer.getApiSpec();
  const compiled: CompiledRoute[] = [];

  for (const [openApiPath, methods] of Object.entries(spec.paths ?? {})) {
    const template = openApiPath.replace(/\{([^}]+)\}/g, ':$1');
    const re = new RegExp(`^${template.replace(/:[^/]+/g, '[^/]+')}/?$`);
    for (const verb of Object.keys(methods ?? {})) {
      compiled.push({ method: verb.toUpperCase(), re, template });
    }
  }

  return {
    match(method: string, path: string): string | undefined {
      const wanted = method.toUpperCase();
      for (const r of compiled) {
        if (r.method === wanted && r.re.test(path)) return r.template;
      }
      return undefined;
    },
  };
}

function buildMetricsController(obs: Observability, path: string) {
  class ObservabilityMetricsController {
    @get(path)
    async handle(@inject(RestBindings.Http.RESPONSE) response: Response) {
      // async penting: LB4 mengecek hasil return SEGERA setelah invoke()
      // resolve. Kalau ini sinkron, sequence sudah mencoba kirim respons
      // sendiri sebelum render metrik (yang async) sempat menulis body.
      try {
        const body = await obs.metrics.render(obs.normalizer);
        response.setHeader('content-type', obs.metrics.contentType);
        response.end(body);
      } catch (err) {
        response.statusCode = 500;
        response.end(`# gagal render metrik: ${(err as Error).message}\n`);
      }
    }
  }
  return ObservabilityMetricsController;
}

export interface Loopback4Options extends Omit<ObservabilityConfig, 'routerTable'> {
  /**
   * Chain tempat expressMiddleware() dipasang. Default LB4 vanilla
   * ('middlewareChain.default') cuma jalan kalau sequence app memang
   * memakainya — custom sequence (spt fast-backend, chain:
   * 'middlewareChain.rest') harus override ini ke chain yang sama,
   * kalau tidak middleware terdaftar tanpa error tapi TIDAK PERNAH
   * dipanggil.
   */
  middlewareChain?: string;
}

export async function instrumentLoopback4(
  app: Loopback4App,
  options: Loopback4Options
): Promise<Observability> {
  const obs = initObservability({ ...options, routerTable: await openApiRouterTable(app) });
  const isPush = (options.transport ?? 'scrape') === 'push';
  const measure = obs.middleware();

  app.expressMiddleware(
    () => (req: any, res: any, next: (err?: any) => void) => measure(req, res, next),
    undefined,
    {
      key: 'middleware.observability',
      // providerClassName eksplisit: @loopback/express coba infer nama dari
      // factory.name kalau ini tidak diisi, dan gagal keras untuk arrow fn anonim.
      providerClassName: 'ObservabilityMiddleware',
      chain: options.middlewareChain ?? 'middlewareChain.default',
    }
  );

  if (!isPush) {
    app.controller(buildMetricsController(obs, options.metricsPath ?? '/metrics'));
  }

  return obs;
}
