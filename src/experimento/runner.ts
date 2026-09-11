// Runner dos experimentos: calibração, latência e capacidade.
//
// Protocolo de UMA medição (idêntico para todas as estratégias):
//   1. restaura o banco ao estado inicial (seed determinístico);
//   2. recria API (com a estratégia) e nginx; esvazia o Redis → caches vazios;
//   3. aquecimento: k6 na mesma carga e taxa (resultados descartados);
//   4. zera métricas da API e do Postgres (o cache continua aquecido);
//   5. medição: k6 + amostragem de CPU/memória dos contêineres;
//   6. coleta: resumo do k6, métricas internas da API, pg_stat_statements.
//
// Resiliência: cada medição é gravada em medicoes.jsonl ao terminar; rodar de
// novo com --run-id retoma de onde parou. Ctrl+C encerra após a medição atual.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateSeedData, resetDatabase } from "../../prisma/seed";
import { config, type CacheStrategy } from "../config";
import { createDb, type Db } from "../db";
import type { MetricsSnapshot } from "../metrics";
import {
  CONTAINERS,
  K6_CONTAINER,
  StatsSampler,
  aguardarContainer,
  buildApi,
  lerMetricasApi,
  lerPgStats,
  resetarMetricasApi,
  resetarPgStats,
  subirInfra,
  subirPilha,
  type PgStats,
  type ResourceUsage,
} from "./ambiente";
import { lerResumoK6, runK6, type K6Resultado, type Workload } from "./k6";
import { gitInfo, makeRunId, maquina, versoes, type GitInfo } from "./meta";
import { RESULTS_DIR } from "./paths";

export type Tipo = "calibracao" | "latencia" | "capacidade";

/** Critérios para considerar uma taxa "sustentável" (capacidade e calibração). */
export const CRITERIOS = { p95MaxMs: 100, descartadasMax: 0.01, errosMax: 0.01 } as const;

export interface Config {
  tipo: Tipo;
  estrategias: CacheStrategy[];
  cargas: Workload[];
  /** Taxas (req/s). Latência: uma só. Capacidade/calibração: degraus crescentes. */
  taxas: number[];
  repeticoes: number;
  aquecimentoS: number;
  duracaoS: number;
  ttlS: number;
  seed: number;
}

export interface Medicao {
  runId: string;
  experimento: Tipo;
  chave: string;
  timestamp: string;
  git: string;
  ordem: number;
  estrategia: CacheStrategy;
  carga: Workload;
  taxa: number;
  repeticao: number;
  aquecimentoS: number;
  duracaoS: number;
  ttlS: number;
  k6: K6Resultado;
  app: MetricsSnapshot;
  banco: PgStats;
  recursos: Record<string, ResourceUsage>;
  sustentavel: boolean;
}

interface Etapa {
  chave: string;
  estrategia: CacheStrategy;
  carga: Workload;
  taxa: number;
  repeticao: number;
}

// --- Sorteio determinístico da ordem --------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

/** Combinações estratégia × carga de cada repetição, em ordem sorteada. */
export function combinacoes(cfg: Config, repeticao: number): Array<{ estrategia: CacheStrategy; carga: Workload }> {
  const all = cfg.estrategias.flatMap((estrategia) => cfg.cargas.map((carga) => ({ estrategia, carga })));
  return shuffled(all, cfg.seed * 1000 + repeticao);
}

export const chaveDe = (tipo: Tipo, e: Etapa | Omit<Etapa, "chave">) =>
  `${tipo}|${e.estrategia}|${e.carga}|t${e.taxa}|r${e.repeticao}`;

export function sustentavel(k6: K6Resultado, taxa: number, duracaoS: number): boolean {
  const oferecidas = taxa * duracaoS;
  return (
    k6.latencia.p95 < CRITERIOS.p95MaxMs &&
    k6.descartadas / oferecidas < CRITERIOS.descartadasMax &&
    k6.taxaErros < CRITERIOS.errosMax
  );
}

// --- Rodada ------------------------------------------------------------------------

interface RunMeta {
  runId: string;
  criadoEm: string;
  git: GitInfo;
  config: Config;
  imagemApi: string;
  maquina: Record<string, unknown>;
  versoes: Record<string, string>;
  criterios: typeof CRITERIOS;
  retomadas: Array<{ em: string; git: string }>;
}

export class Rodada {
  readonly dir: string;
  private readonly medicoesFile: string;
  private readonly falhasFile: string;
  private readonly feitas = new Map<string, Medicao>();
  private ordem = 0;
  private parando = false;
  private db: Db | null = null;
  private readonly seedData = generateSeedData();

  private constructor(
    readonly meta: RunMeta,
    readonly git: GitInfo,
  ) {
    this.dir = path.join(RESULTS_DIR, meta.runId);
    mkdirSync(path.join(this.dir, "k6"), { recursive: true });
    this.medicoesFile = path.join(this.dir, "medicoes.jsonl");
    this.falhasFile = path.join(this.dir, "falhas.jsonl");
    if (existsSync(this.medicoesFile)) {
      for (const line of readFileSync(this.medicoesFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const m = JSON.parse(line) as Medicao;
        this.feitas.set(m.chave, m);
        this.ordem = Math.max(this.ordem, m.ordem);
      }
    }
  }

  /** Cria uma rodada nova ou retoma uma existente (a configuração salva prevalece). */
  static async abrir(cfg: Config, retomarId?: string): Promise<Rodada> {
    const git = await gitInfo();
    if (retomarId) {
      const file = path.join(RESULTS_DIR, retomarId, "run.json");
      if (!existsSync(file)) throw new Error(`Rodada ${retomarId} não encontrada em results/`);
      const meta = JSON.parse(readFileSync(file, "utf8")) as RunMeta;
      meta.retomadas.push({ em: new Date().toISOString(), git: git.label });
      const r = new Rodada(meta, git);
      r.salvarMeta();
      console.log(`↻ Retomando ${meta.runId} (${r.feitas.size} medições já feitas; configuração salva prevalece)`);
      return r;
    }
    await subirInfra();
    console.log("Construindo a imagem da API…");
    const imagemApi = await buildApi();
    const meta: RunMeta = {
      runId: makeRunId(cfg.tipo, git),
      criadoEm: new Date().toISOString(),
      git,
      config: cfg,
      imagemApi,
      maquina: await maquina(),
      versoes: versoes(),
      criterios: CRITERIOS,
      retomadas: [],
    };
    if (git.dirty) console.warn("⚠ Há alterações não commitadas: o identificador da rodada leva o sufixo -dirty.");
    const r = new Rodada(meta, git);
    r.salvarMeta();
    return r;
  }

  get cfg(): Config {
    return this.meta.config;
  }

  private salvarMeta(): void {
    writeFileSync(path.join(this.dir, "run.json"), `${JSON.stringify(this.meta, null, 2)}\n`);
  }

  medicoes(): Medicao[] {
    return [...this.feitas.values()];
  }

  get interrompida(): boolean {
    return this.parando;
  }

  /** Ctrl+C: termina a medição em andamento e para. Segundo Ctrl+C sai na hora. */
  instalarInterrupcao(): () => void {
    const handler = () => {
      if (this.parando) process.exit(130);
      this.parando = true;
      console.log("\n⏸ Interrompendo após a medição atual (Ctrl+C de novo para sair já)…");
    };
    process.on("SIGINT", handler);
    return () => process.off("SIGINT", handler);
  }

  /** Executa (ou recupera, se já feita) uma medição. Devolve null se falhar. */
  async medir(etapa: Etapa): Promise<Medicao | null> {
    const pronta = this.feitas.get(etapa.chave);
    if (pronta) return pronta;
    const cfg = this.cfg;
    const ordem = ++this.ordem;
    const rotulo = `${etapa.estrategia.padEnd(6)} ${etapa.carga.padEnd(7)} ${String(etapa.taxa).padStart(5)} req/s  rep ${etapa.repeticao}`;
    const t0 = Date.now();
    try {
      this.db ??= createDb(config.databaseUrl, 2);
      await resetDatabase(this.db, this.seedData);
      await subirPilha(etapa.estrategia, cfg.ttlS);

      await runK6({ workload: etapa.carga, rate: etapa.taxa, duration: `${cfg.aquecimentoS}s`, phase: "aquecimento", seed: cfg.seed });
      await resetarMetricasApi();
      await resetarPgStats();

      const arquivo = `${this.meta.runId}/k6/${etapa.chave.replace(/\|/g, "_")}.json`;
      // O k6 roda em contêiner de nome fixo; a amostragem começa assim que ele
      // sobe e inclui o próprio k6 (verifica que o gerador não é o gargalo).
      const sampler = new StatsSampler();
      const k6Run = runK6({
        workload: etapa.carga,
        rate: etapa.taxa,
        duration: `${cfg.duracaoS}s`,
        phase: "medicao",
        seed: cfg.seed,
        summaryRelPath: arquivo,
        containerName: K6_CONTAINER,
      });
      let recursos: Record<string, ResourceUsage>;
      try {
        const k6Up = await aguardarContainer(K6_CONTAINER);
        sampler.start([...Object.values(CONTAINERS), ...(k6Up ? [K6_CONTAINER] : [])]);
        await k6Run;
      } finally {
        recursos = sampler.stop();
      }
      const [app, banco] = await Promise.all([lerMetricasApi(), lerPgStats()]);
      const k6 = lerResumoK6(arquivo);

      const m: Medicao = {
        runId: this.meta.runId,
        experimento: cfg.tipo,
        chave: etapa.chave,
        timestamp: new Date().toISOString(),
        git: this.git.label,
        ordem,
        estrategia: etapa.estrategia,
        carga: etapa.carga,
        taxa: etapa.taxa,
        repeticao: etapa.repeticao,
        aquecimentoS: cfg.aquecimentoS,
        duracaoS: cfg.duracaoS,
        ttlS: cfg.ttlS,
        k6,
        app,
        banco,
        recursos,
        sustentavel: sustentavel(k6, etapa.taxa, cfg.duracaoS),
      };
      appendFileSync(this.medicoesFile, `${JSON.stringify(m)}\n`);
      this.feitas.set(m.chave, m);
      const s = (Date.now() - t0) / 1000;
      console.log(
        `  ✓ ${rotulo}  p50 ${k6.latencia.p50.toFixed(1)}  p95 ${k6.latencia.p95.toFixed(1)}  p99 ${k6.latencia.p99.toFixed(1)} ms  ` +
          `${k6.throughput.toFixed(0)} req/s  erros ${(k6.taxaErros * 100).toFixed(2)}%  desc ${k6.descartadas}` +
          `${m.sustentavel ? "" : "  ✗ não sustentável"}  (${s.toFixed(0)}s)`,
      );
      return m;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendFileSync(this.falhasFile, `${JSON.stringify({ chave: etapa.chave, em: new Date().toISOString(), erro: msg })}\n`);
      console.error(`  ✗ ${rotulo}  falhou: ${msg.split("\n")[0]}`);
      return null;
    }
  }

  async fechar(): Promise<void> {
    await this.db?.$disconnect();
  }
}

// --- Experimentos --------------------------------------------------------------------

/** Latência: taxa fixa, todas as combinações, N repetições em ordem sorteada. */
export async function experimentoLatencia(r: Rodada): Promise<void> {
  const cfg = r.cfg;
  const taxa = cfg.taxas[0]!;
  const total = cfg.repeticoes * cfg.estrategias.length * cfg.cargas.length;
  console.log(`Latência: ${total} medições a ${taxa} req/s (${cfg.aquecimentoS}s aquecimento + ${cfg.duracaoS}s medição cada)`);
  for (let rep = 1; rep <= cfg.repeticoes && !r.interrompida; rep++) {
    console.log(`▶ Repetição ${rep}/${cfg.repeticoes}`);
    for (const c of combinacoes(cfg, rep)) {
      if (r.interrompida) break;
      const etapa = { ...c, taxa, repeticao: rep };
      await r.medir({ ...etapa, chave: chaveDe("latencia", etapa) });
    }
  }
}

/**
 * Capacidade (e calibração): para cada combinação, sobe a taxa em degraus até
 * a primeira taxa não sustentável. Capacidade = maior taxa sustentável.
 */
export async function experimentoDegraus(r: Rodada): Promise<void> {
  const cfg = r.cfg;
  const taxas = [...cfg.taxas].sort((a, b) => a - b);
  console.log(
    `${cfg.tipo === "calibracao" ? "Calibração" : "Capacidade"}: degraus ${taxas.join(", ")} req/s; ` +
      `sustentável = p95 < ${CRITERIOS.p95MaxMs} ms, descartadas < ${CRITERIOS.descartadasMax * 100}%, erros < ${CRITERIOS.errosMax * 100}%`,
  );
  for (let rep = 1; rep <= cfg.repeticoes && !r.interrompida; rep++) {
    if (cfg.repeticoes > 1) console.log(`▶ Repetição ${rep}/${cfg.repeticoes}`);
    for (const c of combinacoes(cfg, rep)) {
      for (const taxa of taxas) {
        if (r.interrompida) return;
        const etapa = { ...c, taxa, repeticao: rep };
        const m = await r.medir({ ...etapa, chave: chaveDe(cfg.tipo, etapa) });
        if (!m || !m.sustentavel) break;
      }
    }
  }
}

/** Maior taxa sustentável por combinação e repetição. */
export function capacidades(medicoes: readonly Medicao[]): Array<{ estrategia: CacheStrategy; carga: Workload; repeticao: number; capacidade: number }> {
  const grupos = new Map<string, Medicao[]>();
  for (const m of medicoes) {
    const k = `${m.estrategia}|${m.carga}|${m.repeticao}`;
    grupos.set(k, [...(grupos.get(k) ?? []), m]);
  }
  return [...grupos.values()].map((ms) => {
    const ok = ms.filter((m) => m.sustentavel).map((m) => m.taxa);
    return { estrategia: ms[0]!.estrategia, carga: ms[0]!.carga, repeticao: ms[0]!.repeticao, capacidade: ok.length ? Math.max(...ok) : 0 };
  });
}
