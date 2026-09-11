// Cache distribuído no Redis (padrão cache-aside).
//
// Compartilhado entre instâncias e sobrevive a reinícios da API, ao custo de
// uma ida e volta de rede e de (de)serialização JSON a cada acesso. Falhas do
// Redis não derrubam a API: a leitura vira "miss" e segue para o banco.
import { Redis } from "ioredis";
import type { Cache } from "./types";

const versionKey = (namespace: string) => `versao:${namespace}`;

export class RedisCache implements Cache {
  readonly name = "redis";
  private readonly redis: Redis;
  /** Erros de comunicação com o Redis tratados como miss (diagnóstico). */
  errors = 0;

  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 1 });
    this.redis.on("error", () => {
      this.errors++;
    });
  }

  async ping(): Promise<void> {
    await this.redis.ping();
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.redis.get(key);
      return raw === null ? undefined : (JSON.parse(raw) as T);
    } catch {
      this.errors++;
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
    } catch {
      this.errors++;
    }
  }

  async delete(keys: readonly string[]): Promise<void> {
    if (keys.length > 0) await this.redis.del(...keys);
  }

  async getVersion(namespace: string): Promise<number> {
    try {
      return Number((await this.redis.get(versionKey(namespace))) ?? 0);
    } catch {
      this.errors++;
      return 0;
    }
  }

  async bumpVersion(namespace: string): Promise<void> {
    await this.redis.incr(versionKey(namespace));
  }

  async clear(): Promise<void> {
    await this.redis.flushdb();
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
