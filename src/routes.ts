import * as fs from "fs";
import * as yaml from "js-yaml";
import { MAX_ROUTES_PER_SERVICE, OVERFLOW_ROUTE } from "./contract";

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

export interface RouterTable {
  match(method: string, path: string): string | undefined;
}

export interface NormalizerOptions {
  maxRoutes?: number;
  routeConfig?: string | RoutesConfig;
  routerTable?: RouterTable;
  onUnmatched?: (method: string, path: string) => void;
}

const SEGMENT_RULES: Array<[RegExp, string]> = [
  [/^[0-9a-f]{24}$/i, ":id"],
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, ":uuid"],
  [/^\d{4}-\d{2}-\d{2}$/, ":date"],
  [/^\d+$/, ":n"],
  [/^[A-Za-z0-9_-]{40,}$/, ":token"],
];

export function heuristic(path: string): string {
  const [pathname] = path.split("?");
  return (
    pathname
      .split("/")
      .map((segment) => {
        if (segment === "") return segment;
        for (const [re, replacement] of SEGMENT_RULES) {
          if (re.test(segment)) return replacement;
        }
        return segment;
      })
      .join("/") || "/"
  );
}

export function loadRoutesConfig(
  source: string | RoutesConfig | undefined
): RoutesConfig {
  if (!source) return {};
  if (typeof source !== "string") return source;

  try {
    const raw = fs.readFileSync(source, "utf8");
    return (yaml.load(raw) as RoutesConfig) ?? {};
  } catch (err) {
    console.warn(
      `[@ibbr-engineering/observability] could not read routes.yaml (${source}): ` +
        `${(err as Error).message}. Continuing without overrides.`
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

  private readonly known = new Set<string>();
  private overflowCount = 0;

  constructor(options: NormalizerOptions = {}) {
    const config = loadRoutesConfig(options.routeConfig);

    this.maxRoutes =
      options.maxRoutes ?? config.max_routes ?? MAX_ROUTES_PER_SERVICE;
    this.routerTable = options.routerTable;
    this.onUnmatched = options.onUnmatched;

    this.overrides = (config.overrides ?? []).map((o) => ({
      re: new RegExp(o.pattern),
      template: o.template,
    }));
    this.ignore = (config.ignore ?? []).map((p) => new RegExp(p));

    this.known.add(OVERFLOW_ROUTE);
  }

  shouldIgnore(path: string): boolean {
    const [pathname] = path.split("?");
    return this.ignore.some((re) => re.test(pathname));
  }

  normalize(method: string, path: string): string {
    const [pathname] = path.split("?");

    for (const o of this.overrides) {
      if (o.re.test(pathname)) return this.admit(o.template);
    }

    const fromRouter = this.routerTable?.match(method, pathname);
    const template = fromRouter ?? heuristic(pathname);

    if (!this.known.has(template) && this.known.size >= this.maxRoutes) {
      this.overflowCount += 1;
      this.onUnmatched?.(method, pathname);
      return OVERFLOW_ROUTE;
    }

    return this.admit(template);
  }

  private admit(template: string): string {
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

  snapshot(): string[] {
    return [...this.known].sort();
  }
}
