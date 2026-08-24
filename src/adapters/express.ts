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

function layerTemplate(layer: any): string | undefined {
  if (layer?.route?.path) return String(layer.route.path);

  const source: string | undefined = layer?.regexp?.source;
  if (!source || source === "^\\/?(?=\\/|$)") return undefined;
  const literal = source
    .replace(/^\^/, "")
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, "")
    .replace(/\$$/, "")
    .replace(/\\\//g, "/");
  return /^[/\w-]+$/.test(literal) ? literal : undefined;
}

function walk(stack: any[], prefix: string, out: CompiledRoute[]): void {
  for (const layer of stack ?? []) {
    const segment = layerTemplate(layer);

    if (layer?.route) {
      const template = `${prefix}${segment ?? ""}` || "/";
      const methods = Object.keys(layer.route.methods ?? { get: true });
      for (const m of methods) {
        out.push({
          method: m.toUpperCase(),
          re: new RegExp(
            `^${template.replace(/:([A-Za-z0-9_]+)/g, "[^/]+")}/?$`
          ),
          template,
        });
      }
      continue;
    }

    const nested = layer?.handle?.stack;
    if (Array.isArray(nested)) {
      walk(nested, `${prefix}${segment ?? ""}`, out);
    }
  }
}

export function expressRouterTable(app: any): RouterTable {
  let compiled: CompiledRoute[] | undefined;
  let attempts = 0;

  return {
    match(method: string, path: string): string | undefined {
      if (!compiled || (compiled.length === 0 && attempts < 5)) {
        attempts += 1;
        const out: CompiledRoute[] = [];
        walk(app?.router?.stack ?? app?._router?.stack ?? [], "", out);
        compiled = out;
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

export function instrumentExpress(
  app: any,
  options: Omit<ObservabilityConfig, "routerTable">
): Observability {
  const obs = initObservability({
    ...options,
    routerTable: expressRouterTable(app),
  });

  app.use(obs.middleware());
  if ((options.transport ?? "scrape") !== "push") {
    app.get(options.metricsPath ?? "/metrics", obs.metricsHandler());
  }

  return obs;
}
