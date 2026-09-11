// Cache em memória, local ao processo da API (LRU com TTL).
//
// Menor latência possível (sem rede, sem serialização), mas não é
// compartilhado entre instâncias da API e some quando o processo reinicia.
import { LRUCache } from "lru-cache";
import type { Cache } from "./types";

export class MemoryCache implements Cache {
  readonly name = "memory";
  private readonly lru: LRUCache<string, object>;
  private readonly versions = new Map<string, number>();

  constructor(maxEntries: number) {
    this.lru = new LRUCache<string, object>({ max: maxEntries });
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.lru.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.lru.set(key, value as object, { ttl: ttlSeconds * 1000 });
  }

  async delete(keys: readonly string[]): Promise<void> {
    for (const k of keys) this.lru.delete(k);
  }

  async getVersion(namespace: string): Promise<number> {
    return this.versions.get(namespace) ?? 0;
  }

  async bumpVersion(namespace: string): Promise<void> {
    // Entradas da versão antiga deixam de ser lidas e saem por LRU/TTL.
    this.versions.set(namespace, (this.versions.get(namespace) ?? 0) + 1);
  }

  async clear(): Promise<void> {
    this.lru.clear();
    this.versions.clear();
  }

  async close(): Promise<void> {}

  /** Quantidade de entradas (para testes e diagnóstico). */
  get size(): number {
    return this.lru.size;
  }
}
