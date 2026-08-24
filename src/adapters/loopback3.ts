import {
  initObservability,
  type Observability,
  type ObservabilityConfig,
} from "../index";
import type { RouterTable } from "../routes";

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
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:([A-Za-z0-9_]+)/g, "[^/]+");
  return new RegExp(`^${escaped}/?$`);
}

function collectRoutes(app: any): Lb3Route[] {
  const remotes =
    typeof app?.remotes === "function" ? app.remotes() : undefined;
  if (!remotes) return [];

  const adapter = remotes.adapter;
  if (adapter && typeof adapter.allRoutes === "function") {
    try {
      return adapter.allRoutes() as Lb3Route[];
    } catch {}
  }

  if (typeof remotes.listMethods === "function") {
    try {
      return (remotes.listMethods() as any[])
        .filter((m) => m?.http)
        .flatMap((m) => (Array.isArray(m.http) ? m.http : [m.http]))
        .map((h: any) => ({ verb: h.verb, path: h.path }));
    } catch {}
  }

  return [];
}

export function loopback3RouterTable(app: any): RouterTable {
  let compiled: CompiledRoute[] | undefined;
  let attempts = 0;

  const build = (): CompiledRoute[] => {
    const restApiRoot: string = app?.get?.("restApiRoot") ?? "/api";
    const routes = collectRoutes(app);

    return routes
      .filter((r) => typeof r.path === "string")
      .map((r) => {
        const path = r.path as string;
        const template = path.startsWith(restApiRoot)
          ? path
          : `${restApiRoot}${path}`;
        return {
          method: String(r.verb ?? r.method ?? "GET").toUpperCase(),
          re: toRegExp(template),
          template,
        };
      })
      .sort((a, b) => {
        const paramsA = (a.template.match(PARAM) ?? []).length;
        const paramsB = (b.template.match(PARAM) ?? []).length;
        if (paramsA !== paramsB) return paramsA - paramsB;
        return b.template.length - a.template.length;
      });
  };

  return {
    match(method: string, path: string): string | undefined {
      if (!compiled || (compiled.length === 0 && attempts < 5)) {
        attempts += 1;
        compiled = build();
      }
      const wanted = method.toUpperCase();
      for (const r of compiled) {
        if ((r.method === wanted || r.method === "ALL") && r.re.test(path)) {
          return r.template;
        }
      }
      return undefined;
    },
  };
}

export interface Loopback3Options
  extends Omit<ObservabilityConfig, "routerTable"> {
  phase?: string;
}

export function instrumentLoopback3(
  app: any,
  options: Loopback3Options
): Observability {
  const obs = initObservability({
    ...options,
    routerTable: loopback3RouterTable(app),
  });

  const phase = options.phase ?? "initial";
  const metricsPath = options.metricsPath ?? "/metrics";
  const needsEndpoint = (options.transport ?? "scrape") !== "push";

  const measure = obs.middleware();
  const serveMetrics = obs.metricsHandler();

  app.middleware(
    phase,
    function observabilityPhase(req: any, res: any, next: (err?: any) => void) {
      if (needsEndpoint) {
        const pathname = String(req.originalUrl ?? req.url ?? "").split("?")[0];
        if (pathname === metricsPath) {
          return serveMetrics(req, res);
        }
      }
      return measure(req, res, next);
    }
  );

  return obs;
}
