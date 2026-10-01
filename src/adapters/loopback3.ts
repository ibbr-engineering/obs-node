import {
  initObservability,
  type Observability,
  type ObservabilityConfig,
} from "../index";
import { compileRouterTable, type RouterTable } from "../routes";

interface Lb3Route {
  verb?: string;
  method?: string;
  path?: string;
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
  let compiled: RouterTable | undefined;
  let size = 0;
  let attempts = 0;

  const build = (): RouterTable => {
    const restApiRoot: string = app?.get?.("restApiRoot") ?? "/api";
    const routes = collectRoutes(app)
      .filter((r) => typeof r.path === "string")
      .map((r) => {
        const path = r.path as string;
        return {
          method: String(r.verb ?? r.method ?? "GET"),
          template: path.startsWith(restApiRoot)
            ? path
            : `${restApiRoot}${path}`,
        };
      });
    size = routes.length;
    return compileRouterTable(routes);
  };

  return {
    match(method: string, path: string): string | undefined {
      if (!compiled || (size === 0 && attempts < 5)) {
        attempts += 1;
        compiled = build();
      }
      return compiled.match(method, path);
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
