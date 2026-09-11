// Contadores internos da API, lidos pelo runner do experimento via
// GET /internal/metrics e zerados antes de cada execução.

export interface MetricsSnapshot {
  requests: number;
  dbQueries: number;
  cacheHits: number;
  cacheMisses: number;
  cacheInvalidations: number;
  notModified: number;
  /** cacheHits / (cacheHits + cacheMisses); null se o cache não foi consultado. */
  cacheHitRate: number | null;
}

export class Metrics {
  requests = 0;
  /** Consultas enviadas ao PostgreSQL (contadas por uma extensão do Prisma). */
  dbQueries = 0;
  cacheHits = 0;
  cacheMisses = 0;
  /** Chaves removidas ou versões incrementadas por operações de escrita. */
  cacheInvalidations = 0;
  /** Respostas 304 (validação condicional por ETag). */
  notModified = 0;

  reset(): void {
    this.requests = 0;
    this.dbQueries = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.cacheInvalidations = 0;
    this.notModified = 0;
  }

  snapshot(): MetricsSnapshot {
    const lookups = this.cacheHits + this.cacheMisses;
    return {
      requests: this.requests,
      dbQueries: this.dbQueries,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      cacheInvalidations: this.cacheInvalidations,
      notModified: this.notModified,
      cacheHitRate: lookups === 0 ? null : this.cacheHits / lookups,
    };
  }
}
