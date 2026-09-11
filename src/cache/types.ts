// Interface comum das estratégias de cache da aplicação (em memória e Redis).
// A estratégia "none" e a "http" usam o NoCache: não há cache na aplicação.

export interface Cache {
  readonly name: string;
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(keys: readonly string[]): Promise<void>;
  /**
   * Versão atual de um "namespace" de chaves. As chaves de listagem incluem a
   * versão; incrementá-la invalida todas as páginas de uma vez, sem varrer
   * chaves (invalidação simples e O(1), como previsto no pré-projeto).
   */
  getVersion(namespace: string): Promise<number>;
  bumpVersion(namespace: string): Promise<void>;
  /** Esvazia o cache (usado entre execuções do experimento). */
  clear(): Promise<void>;
  close(): Promise<void>;
}

/** Sem cache: toda leitura vai ao banco. */
export class NoCache implements Cache {
  readonly name = "none";
  async get<T>(): Promise<T | undefined> {
    return undefined;
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
  async getVersion(): Promise<number> {
    return 0;
  }
  async bumpVersion(): Promise<void> {}
  async clear(): Promise<void> {}
  async close(): Promise<void> {}
}
