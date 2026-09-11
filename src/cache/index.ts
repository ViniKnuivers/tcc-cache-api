// Fábrica da estratégia de cache da aplicação.
// "http" não usa cache na aplicação: o cache fica no protocolo HTTP
// (Cache-Control + ETag) e no nginx à frente da API (ver src/http-cache.ts).
import { config, type CacheStrategy } from "../config";
import { MemoryCache } from "./memory";
import { RedisCache } from "./redis";
import { NoCache, type Cache } from "./types";

export async function createCache(strategy: CacheStrategy): Promise<Cache> {
  switch (strategy) {
    case "none":
    case "http":
      return new NoCache();
    case "memory":
      return new MemoryCache(config.memoryCacheMaxEntries);
    case "redis": {
      const cache = new RedisCache(config.redisUrl);
      await cache.ping(); // falha cedo se o Redis não estiver acessível
      return cache;
    }
  }
}

export type { Cache } from "./types";
