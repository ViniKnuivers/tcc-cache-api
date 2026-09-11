// Controle do ambiente Docker entre execuções e coleta de métricas do lado
// do servidor (API, Postgres, uso de CPU/memória dos contêineres).
import { spawn, type ChildProcess } from "node:child_process";
import type { CacheStrategy } from "../config";
import type { MetricsSnapshot } from "../metrics";
import { API_URL, ROOT } from "./paths";
import { run } from "./shell";

export const CONTAINERS = {
  api: "tcc-cache-api",
  postgres: "tcc-cache-pg",
  redis: "tcc-cache-redis",
  nginx: "tcc-cache-nginx",
} as const;

/** Constrói a imagem da API uma vez por rodada e devolve o ID (vai para o run.json). */
export async function buildApi(): Promise<string> {
  await run("docker", ["compose", "build", "api"]);
  const { stdout } = await run("docker", ["image", "inspect", "tcc-cache-api:local", "--format", "{{.Id}}"]);
  return stdout.trim();
}

/** Garante Postgres e Redis no ar. */
export async function subirInfra(): Promise<void> {
  await run("docker", ["compose", "up", "-d", "--wait", "postgres", "redis"]);
}

/**
 * Recria a API (com a estratégia pedida) e o nginx a cada execução: processo
 * novo, cache da aplicação vazio e cache do nginx (tmpfs) vazio. O Redis é
 * esvaziado à parte. Assim toda execução começa do mesmo estado.
 */
export async function subirPilha(strategy: CacheStrategy, ttlSeconds: number): Promise<void> {
  await run("docker", ["exec", CONTAINERS.redis, "redis-cli", "FLUSHALL"]);
  await run("docker", ["compose", "up", "-d", "--wait", "--force-recreate", "--no-build", "api", "nginx"], {
    env: { CACHE_STRATEGY: strategy, CACHE_TTL_SECONDS: String(ttlSeconds) },
  });
  const health = (await (await fetch(`${API_URL}/health`)).json()) as { estrategia: string };
  if (health.estrategia !== strategy) {
    throw new Error(`A API subiu com a estratégia "${health.estrategia}", esperado "${strategy}"`);
  }
}

export async function resetarMetricasApi(): Promise<void> {
  const res = await fetch(`${API_URL}/internal/metrics/reset`, { method: "POST" });
  if (!res.ok) throw new Error(`Falha ao zerar métricas da API (HTTP ${res.status})`);
}

export async function lerMetricasApi(): Promise<MetricsSnapshot> {
  const res = await fetch(`${API_URL}/internal/metrics`);
  if (!res.ok) throw new Error(`Falha ao ler métricas da API (HTTP ${res.status})`);
  return (await res.json()) as MetricsSnapshot;
}

// --- Postgres: consultas executadas (pg_stat_statements) -------------------------

const psql = (sql: string) => run("docker", ["exec", CONTAINERS.postgres, "psql", "-U", "catalogo", "-d", "catalogo", "-tA", "-c", sql]);

export async function resetarPgStats(): Promise<void> {
  await psql("SELECT pg_stat_statements_reset()");
}

export interface PgStats {
  /** Comandos SQL executados (inclui BEGIN/COMMIT das escritas). */
  sqlTotal: number;
  /** Só SELECTs (leituras que chegaram ao banco). */
  sqlSelect: number;
}

export async function lerPgStats(): Promise<PgStats> {
  const { stdout } = await psql(
    `SELECT COALESCE(SUM(calls), 0), COALESCE(SUM(calls) FILTER (WHERE query ILIKE 'select%'), 0)
       FROM pg_stat_statements
      WHERE dbid = (SELECT oid FROM pg_database WHERE datname = 'catalogo')
        AND query NOT ILIKE '%pg_stat_statements%'`,
  );
  const [total, select] = stdout.trim().split("|").map(Number);
  return { sqlTotal: total ?? 0, sqlSelect: select ?? 0 };
}

// --- Uso de CPU e memória dos contêineres (docker stats em fluxo) ----------------

export interface ResourceUsage {
  /** % de CPU (100% = 1 núcleo), média e pico nas amostras. */
  cpuMedia: number;
  cpuMax: number;
  memMediaMiB: number;
  memMaxMiB: number;
  amostras: number;
}

function parseMemMiB(usage: string): number {
  const m = /^([\d.]+)\s*([KMGT]?i?B)/.exec(usage.trim());
  if (!m) return NaN;
  const v = Number(m[1]);
  const unit = m[2]!;
  const factor: Record<string, number> = { B: 1 / 1048576, KiB: 1 / 1024, KB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024, TiB: 1048576 };
  return v * (factor[unit] ?? NaN);
}

/** Amostra `docker stats` (~1 amostra/s por contêiner) enquanto a medição roda. */
export class StatsSampler {
  private proc: ChildProcess | null = null;
  private readonly samples = new Map<string, Array<{ cpu: number; mem: number }>>();
  private buffer = "";

  start(containers: readonly string[]): void {
    this.proc = spawn("docker", ["stats", "--format", "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}", ...containers], { cwd: ROOT });
    this.proc.stdout?.on("data", (chunk: Buffer) => {
      // A saída em fluxo intercala sequências ANSI de limpeza de tela.
      this.buffer += chunk.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, "\n");
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        const [name, cpu, mem] = line.trim().split("|");
        if (!name || !cpu || !mem) continue;
        const cpuValue = Number(cpu.replace("%", ""));
        const memValue = parseMemMiB(mem.split("/")[0] ?? "");
        if (!Number.isFinite(cpuValue) || !Number.isFinite(memValue)) continue;
        const list = this.samples.get(name) ?? [];
        list.push({ cpu: cpuValue, mem: memValue });
        this.samples.set(name, list);
      }
    });
  }

  stop(): Record<string, ResourceUsage> {
    this.proc?.kill("SIGTERM");
    this.proc = null;
    const out: Record<string, ResourceUsage> = {};
    for (const [name, list] of this.samples) {
      // A primeira amostra do docker stats costuma vir zerada; descartamos.
      const valid = list.length > 1 ? list.slice(1) : list;
      const mean = (f: (s: { cpu: number; mem: number }) => number) => valid.reduce((a, s) => a + f(s), 0) / valid.length;
      out[name] = {
        cpuMedia: round(mean((s) => s.cpu)),
        cpuMax: round(Math.max(...valid.map((s) => s.cpu))),
        memMediaMiB: round(mean((s) => s.mem)),
        memMaxMiB: round(Math.max(...valid.map((s) => s.mem))),
        amostras: valid.length,
      };
    }
    return out;
  }
}

const round = (v: number) => Math.round(v * 100) / 100;
