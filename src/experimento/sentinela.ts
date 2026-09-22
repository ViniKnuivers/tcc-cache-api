// Sentinela: medição de referência que confirma que o ambiente está saudável.
//
// A cada SENTINELA.intervalo medições, o runner repete a mesma medição curta
// e leve (sem cache, carga de leitura, taxa baixa). Numa máquina saudável o
// p95 fica em poucos milissegundos; se passar do limite, o ambiente degradou
// (ex.: o macOS paginando a memória da VM do Docker) e as medições seguintes
// não seriam comparáveis às anteriores. Nesse caso o runner tenta recuperar
// (pausa e, depois, reinicia o Docker) e, se não conseguir, interrompe com
// erro em vez de gravar dados ruins. Todas as sentinelas ficam registradas.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { resetDatabase, type SeedData } from "../../prisma/seed";
import type { Db } from "../db";
import { subirInfra, subirPilha } from "./ambiente";
import { memoriaHost } from "./energia";
import { lerResumoK6, runK6 } from "./k6";
import { RESULTS_DIR } from "./paths";
import { run } from "./shell";

// Limites folgados: numa máquina saudável, p95 ≈ 3 ms e p99 ≈ 7 ms nessa carga.
export const SENTINELA = { taxa: 200, aquecimentoS: 5, duracaoS: 15, p95MaxMs: 25, p99MaxMs: 50, intervalo: 10 } as const;

export function sentinelaOk(p95: number, p99: number, descartadas: number): boolean {
  return p95 < SENTINELA.p95MaxMs && p99 < SENTINELA.p99MaxMs && descartadas === 0;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ResultadoSentinela {
  em: string;
  p95: number;
  p99: number;
  descartadas: number;
  ok: boolean;
  swapMiB: number | null;
  memLivrePct: number | null;
  acao?: string;
}

async function medirSentinela(db: Db, seedData: SeedData, runId: string, seed: number, n: number): Promise<ResultadoSentinela> {
  await resetDatabase(db, seedData);
  await subirPilha("none", 60);
  await runK6({ workload: "leitura", rate: SENTINELA.taxa, duration: `${SENTINELA.aquecimentoS}s`, phase: "aquecimento", seed });
  const arquivo = `${runId}/sentinela/${String(n).padStart(3, "0")}.json`;
  mkdirSync(path.join(RESULTS_DIR, runId, "sentinela"), { recursive: true });
  await runK6({ workload: "leitura", rate: SENTINELA.taxa, duration: `${SENTINELA.duracaoS}s`, phase: "medicao", seed, summaryRelPath: arquivo });
  const k6 = lerResumoK6(arquivo);
  const mem = await memoriaHost();
  return {
    em: new Date().toISOString(),
    p95: Math.round(k6.latencia.p95 * 100) / 100,
    p99: Math.round(k6.latencia.p99 * 100) / 100,
    descartadas: k6.descartadas,
    ok: sentinelaOk(k6.latencia.p95, k6.latencia.p99, k6.descartadas),
    swapMiB: mem.swapMiB,
    memLivrePct: mem.livrePct,
  };
}

async function reiniciarDocker(): Promise<void> {
  await run("docker", ["desktop", "restart"], { allowFail: true });
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    if ((await run("docker", ["info"], { allowFail: true })).code === 0) break;
  }
  await subirInfra();
}

let contador = 0;

/**
 * Garante que o ambiente está saudável. Lança erro se não conseguir recuperar
 * (a medição seguinte não é feita e nada inválido é gravado).
 */
export async function garantirAmbiente(db: Db, seedData: SeedData, runId: string, seed: number): Promise<void> {
  const arquivo = path.join(RESULTS_DIR, runId, "sentinela.jsonl");
  const recuperacoes: Array<[string, () => Promise<void>]> = [
    ["pausa de 3 min", () => sleep(180_000)],
    ["reinício do Docker", reiniciarDocker],
  ];
  for (let i = 0; ; i++) {
    const r = await medirSentinela(db, seedData, runId, seed, ++contador);
    const acao = r.ok ? undefined : recuperacoes[i]?.[0];
    appendFileSync(arquivo, `${JSON.stringify({ ...r, acao })}\n`);
    const mem = r.swapMiB !== null ? `  swap ${Math.round(r.swapMiB)} MiB` : "";
    if (r.ok) {
      console.log(`  ◇ sentinela ok: p95 ${r.p95} ms, p99 ${r.p99} ms${mem}`);
      return;
    }
    console.warn(`  ⚠ sentinela: p95 ${r.p95} ms, p99 ${r.p99} ms, ${r.descartadas} descartadas (limites ${SENTINELA.p95MaxMs}/${SENTINELA.p99MaxMs} ms)${mem}; ambiente degradado.`);
    const rec = recuperacoes[i];
    if (!rec) {
      throw new Error(
        `Ambiente degradado mesmo após pausa e reinício do Docker (sentinela p95 ${r.p95} ms). ` +
          "Reinicie o Mac, feche outros programas e rode de novo: as medições feitas até aqui são aproveitadas.",
      );
    }
    console.warn(`    tentando recuperar: ${rec[0]}…`);
    await rec[1]();
  }
}
