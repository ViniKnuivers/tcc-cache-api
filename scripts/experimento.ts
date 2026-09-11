// CLI dos experimentos.
//
//   pnpm experimento calibrar   [--cargas leitura,escrita] [--taxas 200,400,...]
//   pnpm experimento latencia   --taxa 400 [--reps 5] [--estrategias ...] [--cargas ...]
//   pnpm experimento capacidade [--taxas 400,600,...] [--reps 3]
//   pnpm experimento relatorio  --run-id <id>
//
// Opções comuns: --aquecimento <s> --duracao <s> --ttl <s> --seed <n>
//                --run-id <id> (retoma uma rodada) --dry-run (mostra o plano)
import path from "node:path";
import { parseArgs } from "node:util";
import { CACHE_STRATEGIES, type CacheStrategy } from "../src/config";
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

function imprimirResumo(tipo: Tipo, medicoes: Medicao[]): void {
  if (medicoes.length === 0) return;
  if (tipo === "latencia") return; // o resumo completo fica em resumo.json/medicoes.csv
  const caps = capacidades(medicoes);
  console.log("\nMaior taxa sustentável (req/s):");
  for (const c of caps.sort((a, b) => a.carga.localeCompare(b.carga) || a.estrategia.localeCompare(b.estrategia))) {
    console.log(`  ${c.estrategia.padEnd(6)} ${c.carga.padEnd(7)} rep ${c.repeticao}: ${c.capacidade || "< menor degrau"}`);
  }
  if (tipo === "calibracao") {
    const base = caps.filter((c) => c.estrategia === "none").map((c) => c.capacidade);
    const min = Math.min(...base);
    if (Number.isFinite(min) && min > 0) {
      const sugerida = Math.max(50, Math.floor((0.6 * min) / 50) * 50);
      console.log(
        `\nSugestão para o experimento de latência: --taxa ${sugerida} ` +
          `(≈60% da menor capacidade da linha de base, ${min} req/s; critérios: p95 < ${CRITERIOS.p95MaxMs} ms, ` +
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
    },
  });
  const sub = positionals[0];
  const tipos: Record<string, Tipo> = { calibrar: "calibracao", latencia: "latencia", capacidade: "capacidade" };

  if (sub === "relatorio") {
    const runId = values["run-id"];
    if (!runId) throw new Error("Informe --run-id");
    const r = await Rodada.abrir(DEFAULTS.latencia as Config, runId);
    escreverRelatorio(r.dir, r.medicoes());
    imprimirResumo(r.cfg.tipo, r.medicoes());
    console.log(`Relatório atualizado em ${path.relative(process.cwd(), r.dir)}/`);
    return;
  }

  const tipo = sub ? tipos[sub] : undefined;
  if (!tipo) throw new Error("Uso: pnpm experimento <calibrar | latencia | capacidade | relatorio> [opções]");
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
    imprimirResumo(r.cfg.tipo, r.medicoes());
    await r.fechar();
  }
  const faltam = r.interrompida ? ` Para retomar: pnpm experimento ${sub} --run-id ${r.meta.runId}` : "";
  console.log(`\n✓ ${r.medicoes().length} medições em ${path.relative(RESULTS_DIR, r.dir)}.${faltam}`);
}

main().catch((err: unknown) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
