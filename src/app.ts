// Montagem da aplicação Fastify (sem abrir porta: usada pelo servidor e pelos testes).
import Fastify, { type FastifyInstance } from "fastify";
import type { Cache } from "./cache/types";
import type { CacheStrategy } from "./config";
import type { Db } from "./db";
import type { Metrics } from "./metrics";
import { produtoRoutes } from "./produtos/routes";
import { ProdutoService } from "./produtos/service";

export interface AppDeps {
  db: Db;
  cache: Cache;
  metrics: Metrics;
  strategy: CacheStrategy;
  ttlSeconds: number;
  logLevel?: string;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: deps.logLevel ?? "warn" } });
  const service = new ProdutoService(deps.db, deps.cache, deps.metrics, deps.ttlSeconds);

  // Só as rotas do experimento contam como requisições (não as internas).
  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/internal") && req.url !== "/health") deps.metrics.requests++;
  });

  app.get("/health", async () => ({ status: "ok", estrategia: deps.strategy }));

  // --- Endpoints internos usados pelo runner do experimento ---------------------
  app.get("/internal/metrics", async () => ({ estrategia: deps.strategy, ...deps.metrics.snapshot() }));
  app.post("/internal/reset", async () => {
    await deps.cache.clear();
    deps.metrics.reset();
    return { ok: true };
  });

  await app.register(produtoRoutes, { service });
  return app;
}
