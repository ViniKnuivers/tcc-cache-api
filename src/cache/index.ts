// Fábrica da estratégia de cache da aplicação.
// "memory" e "redis" entram na Fase 3; "http" não usa cache na aplicação
// (o cache fica no protocolo HTTP e no nginx).
import type { CacheStrategy } from "../config";
import { NoCache, type Cache } from "./types";

export async function createCache(strategy: CacheStrategy): Promise<Cache> {
  switch (strategy) {
    case "none":
    case "http":
      return new NoCache();
    case "memory":
    case "redis":
      throw new Error(`Estratégia "${strategy}" ainda não implementada (Fase 3)`);
  }
}

export type { Cache } from "./types";
