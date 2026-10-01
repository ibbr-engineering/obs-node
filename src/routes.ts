import * as fs from "fs";
import * as yaml from "js-yaml";
import { MAX_ROUTES_PER_SERVICE, OVERFLOW_ROUTE } from "./contract";
import { isForbiddenValue } from "./guard";

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
  maxUnmatchedRoutes?: number;
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

export function stripQuery(path: string): string {
  const at = path.indexOf("?");
  return at === -1 ? path : path.slice(0, at);
}

export function heuristic(path: string): string {
  const pathname = stripQuery(path);
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
  private readonly maxUnmatchedRoutes: number;
  private readonly overrides: CompiledOverride[];
  private readonly ignore: RegExp[];
  private readonly routerTable?: RouterTable;
  private readonly onUnmatched?: (method: string, path: string) => void;

  private readonly known = new Set<string>();
  // Heuristic templates admitted while a router table exists. They get a
  // smaller budget so 404 scanners cannot evict real routes into __other__.
  private readonly unmatched = new Set<string>();
  private overflowCount = 0;

  constructor(options: NormalizerOptions = {}) {
    const config = loadRoutesConfig(options.routeConfig);

    this.maxRoutes =
      options.maxRoutes ?? config.max_routes ?? MAX_ROUTES_PER_SERVICE;
    this.maxUnmatchedRoutes =
      options.maxUnmatchedRoutes ??
      Math.max(1, Math.floor(this.maxRoutes / 10));
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
    if (this.ignore.length === 0) return false;
    const pathname = stripQuery(path);
    return this.ignore.some((re) => re.test(pathname));
  }

  /**
   * `fromFramework` marks a template supplied by the framework router, which
   * is trusted like a router-table match.
   */
  normalize(method: string, path: string, fromFramework = false): string {
    const pathname = stripQuery(path);

    for (const o of this.overrides) {
      if (o.re.test(pathname)) return this.admit(o.template, method, pathname);
    }

    const fromRouter = this.routerTable?.match(method, pathname);
    if (fromRouter !== undefined || fromFramework || !this.routerTable) {
      return this.admit(fromRouter ?? heuristic(pathname), method, pathname);
    }

    const template = heuristic(pathname);
    if (
      !this.known.has(template) &&
      this.unmatched.size >= this.maxUnmatchedRoutes
    ) {
      return this.overflow(method, pathname);
    }
    const admitted = this.admit(template, method, pathname);
    if (admitted !== OVERFLOW_ROUTE) this.unmatched.add(admitted);
    return admitted;
  }

  private admit(template: string, method: string, pathname: string): string {
    if (this.known.has(template)) return template;
    if (this.known.size >= this.maxRoutes || isForbiddenValue(template)) {
      return this.overflow(method, pathname);
    }
    this.known.add(template);
    return template;
  }

  private overflow(method: string, pathname: string): string {
    this.overflowCount += 1;
    this.onUnmatched?.(method, pathname);
    return OVERFLOW_ROUTE;
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

export interface RouteSpec {
  method: string;
  template: string;
}

const PARAM_TOKEN = /:[A-Za-z0-9_]+/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function segmentPattern(segment: string): RegExp {
  return new RegExp(
    `^${segment.split(PARAM_TOKEN).map(escapeRegExp).join("[^/]+")}$`
  );
}

interface TrieNode {
  statics: Map<string, TrieNode>;
  // Partial patterns (`:name.json`) are tried before bare params (`:id`).
  patterns: Array<{
    segment: string;
    re: RegExp;
    bare: boolean;
    node: TrieNode;
  }>;
  templates: Map<string, string>;
}

function trieNode(): TrieNode {
  return { statics: new Map(), patterns: [], templates: new Map() };
}

/**
 * Router table for templates such as `/a/:id`. Lookup walks one trie level
 * per path segment, preferring static segments over params, so `/a/count`
 * wins over `/a/:id` regardless of declaration order.
 */
export function compileRouterTable(routes: RouteSpec[]): RouterTable {
  const root = trieNode();

  for (const r of routes) {
    let node = root;
    for (const segment of r.template.split("/").filter(Boolean)) {
      if (!segment.includes(":")) {
        let next = node.statics.get(segment);
        if (!next) node.statics.set(segment, (next = trieNode()));
        node = next;
        continue;
      }
      let entry = node.patterns.find((p) => p.segment === segment);
      if (!entry) {
        entry = {
          segment,
          re: segmentPattern(segment),
          bare: /^:[A-Za-z0-9_]+$/.test(segment),
          node: trieNode(),
        };
        node.patterns.push(entry);
        node.patterns.sort((x, y) => Number(x.bare) - Number(y.bare));
      }
      node = entry.node;
    }
    const method = r.method.toUpperCase();
    if (!node.templates.has(method)) node.templates.set(method, r.template);
  }

  const walk = (
    node: TrieNode,
    segments: string[],
    i: number,
    method: string
  ): string | undefined => {
    if (i === segments.length) {
      return node.templates.get(method) ?? node.templates.get("ALL");
    }
    const segment = segments[i];
    const exact = node.statics.get(segment);
    if (exact) {
      const found = walk(exact, segments, i + 1, method);
      if (found !== undefined) return found;
    }
    for (const p of node.patterns) {
      if (!p.re.test(segment)) continue;
      const found = walk(p.node, segments, i + 1, method);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  return {
    match(method: string, path: string): string | undefined {
      return walk(
        root,
        path.split("/").filter(Boolean),
        0,
        method.toUpperCase()
      );
    },
  };
}
