import { inject } from "@loopback/context";
import { get, Response, RestBindings } from "@loopback/rest";
import {
  initObservability,
  type Observability,
  type ObservabilityConfig,
} from "../index";
import {
  compileRouterTable,
  type RouteSpec,
  type RouterTable,
} from "../routes";

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

const OPENAPI_VERBS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

async function openApiRouterTable(app: Loopback4App): Promise<RouterTable> {
  const spec = await app.restServer.getApiSpec();
  const routes: RouteSpec[] = [];

  for (const [openApiPath, methods] of Object.entries(spec.paths ?? {})) {
    const template = openApiPath.replace(/\{([^}]+)\}/g, ":$1");
    for (const verb of Object.keys(methods ?? {})) {
      if (!OPENAPI_VERBS.has(verb.toLowerCase())) continue;
      routes.push({ method: verb, template });
    }
  }

  return compileRouterTable(routes);
}

function buildMetricsController(obs: Observability, path: string) {
  class ObservabilityMetricsController {
    @get(path)
    async handle(@inject(RestBindings.Http.RESPONSE) response: Response) {
      try {
        const body = await obs.metrics.render(obs.normalizer);
        response.setHeader("content-type", obs.metrics.contentType);
        response.end(body);
      } catch (err) {
        response.statusCode = 500;
        response.end(`# metric rendering failed: ${(err as Error).message}\n`);
      }
    }
  }
  return ObservabilityMetricsController;
}

export interface Loopback4Options
  extends Omit<ObservabilityConfig, "routerTable"> {
  middlewareChain?: string;
}

export async function instrumentLoopback4(
  app: Loopback4App,
  options: Loopback4Options
): Promise<Observability> {
  const obs = initObservability({
    ...options,
    routerTable: await openApiRouterTable(app),
  });
  const isPush = (options.transport ?? "scrape") === "push";
  const measure = obs.middleware();

  app.expressMiddleware(
    () => (req: any, res: any, next: (err?: any) => void) =>
      measure(req, res, next),
    undefined,
    {
      key: "middleware.observability",
      providerClassName: "ObservabilityMiddleware",
      chain: options.middlewareChain ?? "middlewareChain.default",
    }
  );

  if (!isPush) {
    app.controller(
      buildMetricsController(obs, options.metricsPath ?? "/metrics")
    );
  }

  return obs;
}
