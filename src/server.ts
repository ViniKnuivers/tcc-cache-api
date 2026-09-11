// Ponto de entrada da API.
//
// Uso:  pnpm dev            (desenvolvimento, recarrega ao salvar)
//       pnpm start          (execução normal)
// A estratégia de cache vem de CACHE_STRATEGY (none | memory | redis | http).
import { buildApp } from "./app";
import { createCache } from "./cache";
import { config } from "./config";
import { createDb } from "./db";
import { Metrics } from "./metrics";

async function main(): Promise<void> {
  const metrics = new Metrics();
  const db = createDb(config.databaseUrl, 10, () => metrics.dbQueries++);
  const cache = await createCache(config.cacheStrategy);
  const app = await buildApp({
    db,
    cache,
    metrics,
    strategy: config.cacheStrategy,
    ttlSeconds: config.cacheTtlSeconds,
    logLevel: process.env["LOG_LEVEL"],
  });

  const shutdown = async (signal: string) => {
    app.log.warn(`${signal} recebido, encerrando…`);
    await app.close();
    await cache.close();
    await db.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: "0.0.0.0", port: config.port });
  console.log(`API no ar em :${config.port} (estratégia de cache: ${config.cacheStrategy}, TTL ${config.cacheTtlSeconds}s)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
