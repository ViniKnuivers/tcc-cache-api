// CLI dos experimentos.
//
//   pnpm experimento calibrar   [--cargas leitura,escrita] [--taxas 200,400,...]
//   pnpm experimento latencia   --taxa 400 [--reps 5] [--estrategias ...] [--cargas ...]
//   pnpm experimento capacidade [--taxas 400,600,...] [--reps 3]
//   pnpm experimento consistencia [--n 100] [--ttl 60]
//   pnpm experimento relatorio  --run-id <id>
//   pnpm experimento tudo         (E0 → E1 com a taxa calibrada → E2 → E3 → results/final/; retomável)
//
// Opções comuns: --aquecimento <s> --duracao <s> --ttl <s> --seed <n>
//                --run-id <id> (retoma uma rodada) --dry-run (mostra o plano)
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { CACHE_STRATEGIES, type CacheStrategy } from "../src/config";
import { experimentoConsistencia } from "../src/experimento/consistencia";
import { WORKLOADS, type Workload } from "../src/experimento/k6";
import { RESULTS_DIR } from "../src/experimento/paths";
import { escreverRelatorio } from "../src/experimento/relatorio";
import {
  CRITERIOS,
  Rodada,
  capacidades,
  combinacoes,
  experimentoDegraus,
  experimentoLatencia,
  type Config,
  type Medicao,
  type Tipo,
} from "../src/experimento/runner";

const DEFAULTS: Record<Tipo, Omit<Config, "tipo">> = {
  calibracao: {
    estrategias: ["none"],
    cargas: ["leitura", "mista", "escrita"],
    taxas: [200, 300, 400, 500, 600, 700, 800, 1000, 1200],
    repeticoes: 1,
    aquecimentoS: 15,
    duracaoS: 20,
    ttlS: 60,
    seed: 42,
  },
  latencia: {
    estrategias: [...CACHE_STRATEGIES],
    cargas: [...WORKLOADS],
    taxas: [400],
    repeticoes: 5,
    aquecimentoS: 30,
    duracaoS: 60,
    ttlS: 60,
    seed: 42,
  },
  capacidade: {
    estrategias: [...CACHE_STRATEGIES],
    cargas: [...WORKLOADS],
    taxas: [400, 600, 800, 1000, 1200, 1600, 2000],
    repeticoes: 3,
    aquecimentoS: 15,
    duracaoS: 30,
    ttlS: 60,
    seed: 42,
  },
};

function lista<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T[], what: string): T[] {
  if (!raw) return fallback;
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const it of items) if (!(allowed as readonly string[]).includes(it)) throw new Error(`${what} desconhecida: ${it}`);
  return items as T[];
}

function numeros(raw: string | undefined, fallback: number[]): number[] {
  if (!raw) return fallback;
  const v = raw.split(",").map(Number);
  if (v.some((n) => !Number.isFinite(n) || n <= 0)) throw new Error(`Lista numérica inválida: ${raw}`);
  return v;
}

function numero(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Número inválido: ${raw}`);
  return n;
}

/** Taxa do experimento de latência: ≈60% da menor capacidade da linha de base (múltiplo de 50). */
function taxaSugerida(
  medicoes: readonly Medicao[],
  taxas: readonly number[],
): { taxa: number | null; capacidadeMinima: number; maiorDegrau: number; censurada: boolean } {
  const base = capacidades(medicoes.filter((m) => m.estrategia === "none")).map((c) => c.capacidade);
  const maiorDegrau = Math.max(...taxas);
  const capacidadeMinima = Math.min(...base);
  const taxa = Number.isFinite(capacidadeMinima) && capacidadeMinima > 0 ? Math.max(50, Math.floor((0.6 * capacidadeMinima) / 50) * 50) : null;
  return { taxa, capacidadeMinima, maiorDegrau, censurada: base.some((c) => c >= maiorDegrau) };
}

function imprimirResumo(cfg: Config, medicoes: Medicao[]): void {
  const tipo = cfg.tipo;
  if (medicoes.length === 0) return;
  if (tipo === "latencia") return; // o resumo completo fica em resumo.json/medicoes.csv
  const caps = capacidades(medicoes);
  console.log("\nMaior taxa sustentável (req/s):");
  for (const c of caps.sort((a, b) => a.carga.localeCompare(b.carga) || a.estrategia.localeCompare(b.estrategia))) {
    console.log(`  ${c.estrategia.padEnd(6)} ${c.carga.padEnd(7)} rep ${c.repeticao}: ${c.capacidade || "< menor degrau"}`);
  }
  if (tipo === "calibracao") {
    const t = taxaSugerida(medicoes, cfg.taxas);
    if (t.censurada) {
      console.warn(`⚠ A linha de base sustentou o maior degrau (${t.maiorDegrau} req/s): a capacidade é maior. Rode com degraus mais altos (--taxas).`);
    }
    if (t.taxa) {
      console.log(
        `\nSugestão para o experimento de latência: --taxa ${t.taxa} ` +
          `(≈60% da menor capacidade da linha de base, ${t.capacidadeMinima} req/s; critérios: p95 < ${CRITERIOS.p95MaxMs} ms, ` +
          `descartadas < ${CRITERIOS.descartadasMax * 100}%)`,
      );
    }
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== "--"),
    allowPositionals: true,
    options: {
      estrategias: { type: "string" },
      cargas: { type: "string" },
      taxa: { type: "string" },
      taxas: { type: "string" },
      reps: { type: "string" },
      aquecimento: { type: "string" },
      duracao: { type: "string" },
      ttl: { type: "string" },
      seed: { type: "string" },
      "run-id": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      n: { type: "string" },
    },
  });
  const sub = positionals[0];
  const tipos: Record<string, Tipo> = { calibrar: "calibracao", latencia: "latencia", capacidade: "capacidade" };

  if (sub === "relatorio") {
    const runId = values["run-id"];
    if (!runId) throw new Error("Informe --run-id");
    const r = await Rodada.abrir(DEFAULTS.latencia as Config, runId);
    escreverRelatorio(r.dir, r.medicoes());
    imprimirResumo(r.cfg, r.medicoes());
    console.log(`Relatório atualizado em ${path.relative(process.cwd(), r.dir)}/`);
    return;
  }

  if (sub === "tudo") {
    await tudo(values.seed ? Number(values.seed) : 42);
    return;
  }

  if (sub === "consistencia") {
    await experimentoConsistencia({
      estrategias: lista<CacheStrategy>(values.estrategias, CACHE_STRATEGIES, [...CACHE_STRATEGIES], "Estratégia"),
      n: numero(values.n, 100),
      ttlS: numero(values.ttl, 60),
      seed: numero(values.seed, 42),
    });
    return;
  }

  const tipo = sub ? tipos[sub] : undefined;
  if (!tipo) throw new Error("Uso: pnpm experimento <calibrar | latencia | capacidade | consistencia | tudo | relatorio> [opções]");
  const d = DEFAULTS[tipo];
  const cfg: Config = {
    tipo,
    estrategias: lista<CacheStrategy>(values.estrategias, CACHE_STRATEGIES, d.estrategias, "Estratégia"),
    cargas: lista<Workload>(values.cargas, WORKLOADS, d.cargas, "Carga"),
    taxas: tipo === "latencia" ? [numero(values.taxa, d.taxas[0]!)] : numeros(values.taxas, d.taxas),
    repeticoes: numero(values.reps, d.repeticoes),
    aquecimentoS: numero(values.aquecimento, d.aquecimentoS),
    duracaoS: numero(values.duracao, d.duracaoS),
    ttlS: numero(values.ttl, d.ttlS),
    seed: numero(values.seed, d.seed),
  };

  if (values["dry-run"]) {
    console.log(JSON.stringify(cfg, null, 2));
    for (let rep = 1; rep <= cfg.repeticoes; rep++) {
      console.log(`rep ${rep}: ${combinacoes(cfg, rep).map((c) => `${c.estrategia}/${c.carga}`).join(" → ")}`);
    }
    return;
  }

  const r = await Rodada.abrir(cfg, values["run-id"]);
  console.log(`Resultados em ${path.relative(process.cwd(), r.dir)}/\n`);
  const desinstalar = r.instalarInterrupcao();
  try {
    if (r.cfg.tipo === "latencia") await experimentoLatencia(r);
    else await experimentoDegraus(r);
  } finally {
    desinstalar();
    escreverRelatorio(r.dir, r.medicoes());
    imprimirResumo(r.cfg, r.medicoes());
    await r.fechar();
  }
  const faltam = r.interrompida ? ` Para retomar: pnpm experimento ${sub} --run-id ${r.meta.runId}` : "";
  console.log(`\n✓ ${r.medicoes().length} medições em ${path.relative(RESULTS_DIR, r.dir)}.${faltam}`);
}

/**
 * Executa uma rodada (nova ou retomada) até o fim. Faz uma segunda passagem,
 * que pula o que já foi medido e repete só as medições que falharam.
 */
async function executar(cfg: Config, retomarId: string | undefined, aoAbrir: (runId: string) => void): Promise<Rodada> {
  const r = await Rodada.abrir(cfg, retomarId);
  aoAbrir(r.meta.runId);
  console.log(`\n=== ${cfg.tipo.toUpperCase()} → ${path.relative(process.cwd(), r.dir)}/ ===`);
  const desinstalar = r.instalarInterrupcao();
  try {
    for (let passagem = 1; passagem <= 2 && !r.interrompida; passagem++) {
      if (cfg.tipo === "latencia") await experimentoLatencia(r);
      else await experimentoDegraus(r);
    }
  } finally {
    desinstalar();
    escreverRelatorio(r.dir, r.medicoes());
    imprimirResumo(r.cfg, r.medicoes());
    await r.fechar();
  }
  if (r.interrompida) throw new Error("Interrompido. Rode `pnpm experimento tudo` de novo para continuar de onde parou.");
  return r;
}

/** Progresso do `tudo`, para retomar de onde parou se o processo cair. */
interface EstadoTudo {
  seed: number;
  calibracao?: string;
  taxaLatencia?: number;
  latencia?: string;
  capacidade?: string;
  consistencia?: string;
}

const ESTADO_TUDO = path.join(RESULTS_DIR, "tudo-em-andamento.json");

/**
 * Sequência completa dos experimentos finais: E0 → E1 (taxa calibrada) → E2 → E3.
 * Retomável: se o processo cair, rodar de novo continua de onde parou (as
 * medições já feitas são aproveitadas). Ao terminar, move as rodadas para
 * results/final/ (a análise usa essa pasta por padrão).
 */
async function tudo(seed: number): Promise<void> {
  const t0 = Date.now();
  const estado: EstadoTudo = existsSync(ESTADO_TUDO) ? (JSON.parse(readFileSync(ESTADO_TUDO, "utf8")) as EstadoTudo) : { seed };
  if (estado.calibracao) console.log(`↻ Continuando a sequência iniciada antes (${path.relative(process.cwd(), ESTADO_TUDO)}).`);
  const salvar = () => writeFileSync(ESTADO_TUDO, `${JSON.stringify(estado, null, 2)}\n`);
  salvar();

  const cal = await executar({ tipo: "calibracao", ...DEFAULTS.calibracao, seed: estado.seed }, estado.calibracao, (id) => {
    estado.calibracao = id;
    salvar();
  });
  if (!estado.taxaLatencia) {
    const sugestao = taxaSugerida(cal.medicoes(), cal.cfg.taxas);
    if (!sugestao.taxa) {
      throw new Error(`A linha de base não sustentou o menor degrau da calibração (${Math.min(...cal.cfg.taxas)} req/s) em alguma carga. Rode com degraus menores (--taxas).`);
    }
    if (sugestao.censurada) console.warn("⚠ Capacidade da linha de base acima do maior degrau da calibração; usando a sugestão mesmo assim.");
    estado.taxaLatencia = sugestao.taxa;
    salvar();
  }
  const lat = await executar({ tipo: "latencia", ...DEFAULTS.latencia, taxas: [estado.taxaLatencia], seed: estado.seed }, estado.latencia, (id) => {
    estado.latencia = id;
    salvar();
  });
  const cap = await executar({ tipo: "capacidade", ...DEFAULTS.capacidade, seed: estado.seed }, estado.capacidade, (id) => {
    estado.capacidade = id;
    salvar();
  });
  if (!estado.consistencia) {
    console.log("\n=== CONSISTENCIA ===");
    estado.consistencia = await experimentoConsistencia({ estrategias: [...CACHE_STRATEGIES], n: 100, ttlS: 60, seed: estado.seed });
    salvar();
  }

  const final = path.join(RESULTS_DIR, "final");
  mkdirSync(final, { recursive: true });
  for (const dir of [cal.dir, lat.dir, cap.dir, estado.consistencia]) renameSync(dir, path.join(final, path.basename(dir)));
  rmSync(ESTADO_TUDO);
  console.log(`\n✓ Experimentos concluídos (${((Date.now() - t0) / 3_600_000).toFixed(1)} h nesta execução). Rodadas em results/final/. Próximo passo: pnpm analise`);
}

main().catch((err: unknown) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
