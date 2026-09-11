// Execução do k6 (em contêiner, na rede do compose) e leitura do resumo JSON.
import { readFileSync } from "node:fs";
import path from "node:path";
import { RESULTS_DIR } from "./paths";
import { run } from "./shell";

export const WORKLOADS = ["leitura", "mista", "escrita"] as const;
export type Workload = (typeof WORKLOADS)[number];

export interface K6Params {
  workload: Workload;
  rate: number;
  duration: string;
  phase: "aquecimento" | "medicao" | "calibracao";
  seed: number;
  /** Caminho do resumo JSON relativo a results/ (mapeado em /results no contêiner). */
  summaryRelPath?: string;
  /** Nome fixo do contêiner (permite amostrar o uso de CPU do próprio k6). */
  containerName?: string;
}

export interface Latencias {
  media: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  n: number;
}

export interface K6Resultado {
  requisicoes: number;
  /** Throughput efetivamente atendido (req/s). */
  throughput: number;
  latencia: Latencias;
  latenciaLeitura: Latencias | null;
  latenciaEscrita: Latencias | null;
  taxaErros: number;
  /** Iterações que o k6 não conseguiu iniciar por falta de capacidade do sistema. */
  descartadas: number;
  nginxHits: number;
  nginxMisses: number;
  respostas304: number;
}

export async function runK6(p: K6Params): Promise<void> {
  const env = [
    "-e", `WORKLOAD=${p.workload}`,
    "-e", `RATE=${p.rate}`,
    "-e", `DURATION=${p.duration}`,
    "-e", `PHASE=${p.phase}`,
    "-e", `SEED=${p.seed}`,
  ];
  if (p.summaryRelPath) env.push("-e", `SUMMARY_PATH=/results/${p.summaryRelPath}`);
  const name = p.containerName ? ["--name", p.containerName] : [];
  // Remove um contêiner homônimo que tenha sobrado de uma execução interrompida.
  if (p.containerName) await run("docker", ["rm", "-f", p.containerName], { allowFail: true });
  await run("docker", ["compose", "--profile", "carga", "run", "--rm", ...name, ...env, "k6", "run", "--quiet", "/scripts/carga.js"]);
}

type MetricValues = Record<string, number>;
interface K6Summary {
  metrics: Record<string, { values: MetricValues } | undefined>;
}

function latencias(v: MetricValues | undefined): Latencias | null {
  if (!v || !v["count"]) return null;
  return {
    media: v["avg"] ?? NaN,
    p50: v["med"] ?? NaN,
    p90: v["p(90)"] ?? NaN,
    p95: v["p(95)"] ?? NaN,
    p99: v["p(99)"] ?? NaN,
    max: v["max"] ?? NaN,
    n: v["count"] ?? 0,
  };
}

export function lerResumoK6(summaryRelPath: string): K6Resultado {
  const data = JSON.parse(readFileSync(path.join(RESULTS_DIR, summaryRelPath), "utf8")) as K6Summary;
  const m = (name: string) => data.metrics[name]?.values;
  const total = latencias(m("http_req_duration"));
  if (!total) throw new Error(`Resumo do k6 sem http_req_duration: ${summaryRelPath}`);
  return {
    requisicoes: m("http_reqs")?.["count"] ?? 0,
    throughput: m("http_reqs")?.["rate"] ?? 0,
    latencia: total,
    latenciaLeitura: latencias(m("http_req_duration{tipo:leitura}")),
    latenciaEscrita: latencias(m("http_req_duration{tipo:escrita}")),
    taxaErros: m("taxa_erros")?.["rate"] ?? 0,
    descartadas: m("dropped_iterations")?.["count"] ?? 0,
    nginxHits: m("nginx_cache_hit")?.["count"] ?? 0,
    nginxMisses: m("nginx_cache_miss")?.["count"] ?? 0,
    respostas304: m("respostas_304")?.["count"] ?? 0,
  };
}
