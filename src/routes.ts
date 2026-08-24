import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { MAX_ROUTES_PER_SERVICE, OVERFLOW_ROUTE } from './contract';

/**
 * Route templating tanpa OpenAPI (§5.4 blueprint), empat lapis:
 *
 *   1. introspeksi router  — paling akurat, disuplai adaptor framework
 *   2. normalizer heuristik — untuk yang lolos dari lapis 1
 *   3. cardinality guard    — plafon keras, tidak bisa ditembus lapis mana pun
 *   4. override manual      — routes.yaml, diisi dari laporan __other__ mingguan
 *
 * Urutan penerapannya: override (4) menang atas router (1) yang menang atas
 * heuristik (2); apa pun hasilnya tetap tunduk pada plafon (3).
 */

export interface RouteOverride {
  pattern: string;
  template: string;
}

export interface RoutesConfig {
  service?: string;
  max_routes?: number;
  overrides?: RouteOverride[];
  ignore?: string[];
}

interface CompiledOverride {
  re: RegExp;
  template: string;
}

/** Tabel rute dari framework — diisi adaptor (lapis 1). */
export interface RouterTable {
  /** Kembalikan template rute, atau undefined kalau tidak dikenali. */
  match(method: string, path: string): string | undefined;
}

export interface NormalizerOptions {
  maxRoutes?: number;
  routeConfig?: string | RoutesConfig;
  routerTable?: RouterTable;
  /** Dipanggil untuk tiap path yang jatuh ke __other__ (sampling di pemanggil). */
  onUnmatched?: (method: string, path: string) => void;
}

// --- Lapis 2: heuristik per segmen ----------------------------------------
// Urutan penting: pola yang lebih spesifik harus dicek lebih dulu, kalau
// tidak "20240103" akan jadi :n padahal ia tanggal.
const SEGMENT_RULES: Array<[RegExp, string]> = [
  [/^[0-9a-f]{24}$/i, ':id'], // MongoDB ObjectId — mayoritas kasus di stack ini
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, ':uuid'],
  [/^\d{4}-\d{2}-\d{2}$/, ':date'],
  [/^\d+$/, ':n'],
  [/^[A-Za-z0-9_-]{40,}$/, ':token'], // JWT / API key / signed url
];

export function heuristic(path: string): string {
  const [pathname] = path.split('?');
  return (
    pathname
      .split('/')
      .map((segment) => {
        if (segment === '') return segment;
        for (const [re, replacement] of SEGMENT_RULES) {
          if (re.test(segment)) return replacement;
        }
        return segment;
      })
      .join('/') || '/'
  );
}

export function loadRoutesConfig(source: string | RoutesConfig | undefined): RoutesConfig {
  if (!source) return {};
  if (typeof source !== 'string') return source;

  try {
    const raw = fs.readFileSync(source, 'utf8');
    return (yaml.load(raw) as RoutesConfig) ?? {};
  } catch (err) {
    // routes.yaml boleh tidak ada — blueprint menyebut ia "diisi bertahap".
    // Instrumentasi tidak boleh menjatuhkan boot aplikasi karenanya.
    // eslint-disable-next-line no-console
    console.warn(
      `[@ibbr-engineering/observability] routes.yaml tidak terbaca (${source}): ` +
        `${(err as Error).message}. Lanjut tanpa override.`
    );
    return {};
  }
}

export class RouteNormalizer {
  private readonly maxRoutes: number;
  private readonly overrides: CompiledOverride[];
  private readonly ignore: RegExp[];
  private readonly routerTable?: RouterTable;
  private readonly onUnmatched?: (method: string, path: string) => void;

  /** Template yang sudah dikenal. Ukurannya = obs_route_cardinality. */
  private readonly known = new Set<string>();
  private overflowCount = 0;

  constructor(options: NormalizerOptions = {}) {
    const config = loadRoutesConfig(options.routeConfig);

    this.maxRoutes = options.maxRoutes ?? config.max_routes ?? MAX_ROUTES_PER_SERVICE;
    this.routerTable = options.routerTable;
    this.onUnmatched = options.onUnmatched;

    this.overrides = (config.overrides ?? []).map((o) => ({
      re: new RegExp(o.pattern),
      template: o.template,
    }));
    this.ignore = (config.ignore ?? []).map((p) => new RegExp(p));

    // Overflow harus punya slot sendiri, kalau tidak ia ikut memakan plafon
    // dan service dengan trafik liar kehilangan satu route nyata.
    this.known.add(OVERFLOW_ROUTE);
  }

  /** Path yang di-ignore tidak dihitung sebagai request sama sekali. */
  shouldIgnore(path: string): boolean {
    const [pathname] = path.split('?');
    return this.ignore.some((re) => re.test(pathname));
  }

  normalize(method: string, path: string): string {
    const [pathname] = path.split('?');

    // Lapis 4 menang: override ditulis manusia yang sudah melihat data nyata.
    for (const o of this.overrides) {
      if (o.re.test(pathname)) return this.admit(o.template);
    }

    // Lapis 1, lalu lapis 2 sebagai cadangan.
    const fromRouter = this.routerTable?.match(method, pathname);
    const template = fromRouter ?? heuristic(pathname);

    if (!this.known.has(template) && this.known.size >= this.maxRoutes) {
      // Lapis 3. Plafon keras: berapa pun hasil lapis di atas, jumlah time
      // series tidak bisa meledak.
      this.overflowCount += 1;
      this.onUnmatched?.(method, pathname);
      return OVERFLOW_ROUTE;
    }

    return this.admit(template);
  }

  private admit(template: string): string {
    // Override juga tunduk pada plafon. Tanpa cek ini, routes.yaml dengan
    // banyak override bisa menembus max_routes dan meledakkan time series —
    // persis yang seharusnya dicegah lapis 3.
    if (!this.known.has(template) && this.known.size >= this.maxRoutes) {
      this.overflowCount += 1;
      return OVERFLOW_ROUTE;
    }
    this.known.add(template);
    return template;
  }

  get cardinality(): number {
    return this.known.size;
  }

  get overflows(): number {
    return this.overflowCount;
  }

  /** Daftar template yang sedang dilacak — dipakai test & debugging. */
  snapshot(): string[] {
    return [...this.known].sort();
  }
}
