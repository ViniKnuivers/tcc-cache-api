// Configuração da aplicação a partir de variáveis de ambiente (.env).
import "dotenv/config";

export const CACHE_STRATEGIES = ["none", "memory", "redis", "http"] as const;
export type CacheStrategy = (typeof CACHE_STRATEGIES)[number];

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} deveria ser um inteiro ≥ 0, recebeu "${raw}"`);
  return n;
}

function strategy(): CacheStrategy {
  const v = str("CACHE_STRATEGY", "none");
  if (!(CACHE_STRATEGIES as readonly string[]).includes(v)) {
    throw new Error(`CACHE_STRATEGY inválida: "${v}". Opções: ${CACHE_STRATEGIES.join(", ")}`);
  }
  return v as CacheStrategy;
}

export const config = {
  databaseUrl: str("DATABASE_URL"),
  redisUrl: str("REDIS_URL", "redis://localhost:6380"),
  port: int("PORT", 3000),
  cacheStrategy: strategy(),
  cacheTtlSeconds: int("CACHE_TTL_SECONDS", 60),
  memoryCacheMaxEntries: int("MEMORY_CACHE_MAX_ENTRIES", 10_000),
} as const;
