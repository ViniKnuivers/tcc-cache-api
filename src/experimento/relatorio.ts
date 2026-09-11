// Consolidação das medições: CSV (uma linha por medição) e resumo com média
// e desvio padrão por estratégia × carga (× taxa).
import { writeFileSync } from "node:fs";
import path from "node:path";
import { capacidades, type Medicao } from "./runner";

/** Taxa de acerto do cache da estratégia: nginx na "http", aplicação em memory/redis. */
export function taxaAcerto(m: Medicao): number | null {
  if (m.estrategia === "http") {
    const total = m.k6.nginxHits + m.k6.nginxMisses;
    return total === 0 ? null : m.k6.nginxHits / total;
  }
  return m.app.cacheHitRate;
}

const COLUNAS: Array<[string, (m: Medicao) => unknown]> = [
  ["experimento", (m) => m.experimento],
  ["estrategia", (m) => m.estrategia],
  ["carga", (m) => m.carga],
  ["taxa", (m) => m.taxa],
  ["repeticao", (m) => m.repeticao],
  ["ordem", (m) => m.ordem],
  ["timestamp", (m) => m.timestamp],
  ["throughput", (m) => m.k6.throughput],
  ["requisicoes", (m) => m.k6.requisicoes],
  ["lat_media", (m) => m.k6.latencia.media],
  ["lat_p50", (m) => m.k6.latencia.p50],
  ["lat_p90", (m) => m.k6.latencia.p90],
  ["lat_p95", (m) => m.k6.latencia.p95],
  ["lat_p99", (m) => m.k6.latencia.p99],
  ["lat_max", (m) => m.k6.latencia.max],
  ["leitura_p50", (m) => m.k6.latenciaLeitura?.p50],
  ["leitura_p95", (m) => m.k6.latenciaLeitura?.p95],
  ["leitura_p99", (m) => m.k6.latenciaLeitura?.p99],
  ["escrita_p50", (m) => m.k6.latenciaEscrita?.p50],
  ["escrita_p95", (m) => m.k6.latenciaEscrita?.p95],
  ["escrita_p99", (m) => m.k6.latenciaEscrita?.p99],
  ["taxa_erros", (m) => m.k6.taxaErros],
  ["descartadas", (m) => m.k6.descartadas],
  ["taxa_acerto_cache", (m) => taxaAcerto(m)],
  ["nginx_hits", (m) => m.k6.nginxHits],
  ["respostas_304", (m) => m.k6.respostas304],
  ["api_requisicoes", (m) => m.app.requests],
  ["api_ops_banco", (m) => m.app.dbQueries],
  ["sql_total", (m) => m.banco.sqlTotal],
  ["sql_select", (m) => m.banco.sqlSelect],
  ["api_cpu_media", (m) => m.recursos["tcc-cache-api"]?.cpuMedia],
  ["api_cpu_max", (m) => m.recursos["tcc-cache-api"]?.cpuMax],
  ["api_mem_media_mib", (m) => m.recursos["tcc-cache-api"]?.memMediaMiB],
  ["api_mem_max_mib", (m) => m.recursos["tcc-cache-api"]?.memMaxMiB],
  ["pg_cpu_media", (m) => m.recursos["tcc-cache-pg"]?.cpuMedia],
  ["redis_cpu_media", (m) => m.recursos["tcc-cache-redis"]?.cpuMedia],
  ["redis_mem_media_mib", (m) => m.recursos["tcc-cache-redis"]?.memMediaMiB],
  ["nginx_cpu_media", (m) => m.recursos["tcc-cache-nginx"]?.cpuMedia],
  ["k6_cpu_media", (m) => m.recursos["tcc-cache-k6"]?.cpuMedia],
  ["k6_cpu_max", (m) => m.recursos["tcc-cache-k6"]?.cpuMax],
  ["sustentavel", (m) => (m.sustentavel ? 1 : 0)],
];

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v * 10000) / 10000) : "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function medicoesCsv(medicoes: readonly Medicao[]): string {
  const rows = [...medicoes].sort((a, b) => a.ordem - b.ordem);
  return [COLUNAS.map(([c]) => c).join(","), ...rows.map((m) => COLUNAS.map(([, f]) => cell(f(m))).join(","))].join("\n") + "\n";
}

interface Estat {
  media: number;
  dp: number;
  n: number;
}

function estat(values: number[]): Estat {
  const v = values.filter((x) => Number.isFinite(x));
  const n = v.length;
  const media = n ? v.reduce((a, b) => a + b, 0) / n : NaN;
  const dp = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - media) ** 2, 0) / (n - 1)) : 0;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { media: r(media), dp: r(dp), n };
}

const METRICAS: Array<[string, (m: Medicao) => number | null | undefined]> = [
  ["throughput", (m) => m.k6.throughput],
  ["lat_p50", (m) => m.k6.latencia.p50],
  ["lat_p95", (m) => m.k6.latencia.p95],
  ["lat_p99", (m) => m.k6.latencia.p99],
  ["leitura_p95", (m) => m.k6.latenciaLeitura?.p95],
  ["escrita_p95", (m) => m.k6.latenciaEscrita?.p95],
  ["taxa_acerto_cache", (m) => taxaAcerto(m)],
  ["sql_total", (m) => m.banco.sqlTotal],
  ["api_cpu_media", (m) => m.recursos["tcc-cache-api"]?.cpuMedia],
  ["api_mem_media_mib", (m) => m.recursos["tcc-cache-api"]?.memMediaMiB],
  ["taxa_erros", (m) => m.k6.taxaErros],
];

export function resumo(medicoes: readonly Medicao[]): Record<string, unknown> {
  const grupos = new Map<string, Medicao[]>();
  for (const m of medicoes) {
    const k = `${m.estrategia}|${m.carga}|${m.taxa}`;
    grupos.set(k, [...(grupos.get(k) ?? []), m]);
  }
  const porGrupo = [...grupos.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, ms]) => ({
      estrategia: ms[0]!.estrategia,
      carga: ms[0]!.carga,
      taxa: ms[0]!.taxa,
      ...Object.fromEntries(
        METRICAS.map(([nome, f]) => [nome, estat(ms.map((m) => f(m)).filter((x): x is number => typeof x === "number"))]),
      ),
    }));

  const caps = capacidades(medicoes);
  const capGrupos = new Map<string, number[]>();
  for (const c of caps) capGrupos.set(`${c.estrategia}|${c.carga}`, [...(capGrupos.get(`${c.estrategia}|${c.carga}`) ?? []), c.capacidade]);
  const capacidade = [...capGrupos.entries()].map(([k, v]) => {
    const [estrategia, carga] = k.split("|");
    return { estrategia, carga, capacidade: estat(v), valores: v };
  });

  return { geradoEm: new Date().toISOString(), medicoes: medicoes.length, porGrupo, capacidade };
}

export function escreverRelatorio(dir: string, medicoes: readonly Medicao[]): Record<string, unknown> {
  writeFileSync(path.join(dir, "medicoes.csv"), medicoesCsv(medicoes));
  const r = resumo(medicoes);
  writeFileSync(path.join(dir, "resumo.json"), `${JSON.stringify(r, null, 2)}\n`);
  return r;
}
