// Experimento de consistência (E3): quanto cada estratégia entrega dado
// desatualizado logo após uma escrita, e por quanto tempo.
//
// Para cada estratégia, sem carga concorrente:
//   1. aquecimento: lê cada produto da amostra duas vezes (o item entra no cache);
//   2. escrita: altera o estoque de cada produto (PATCH) e registra o instante;
//   3. leitura imediata: lê de novo — desatualizada se o estoque não mudou;
//   4. convergência: relê os desatualizados a cada 0,5 s até o dado novo
//      aparecer (ou até TTL + 15 s) → janela de inconsistência de cada item.
// Tudo passa pelo nginx, como na carga dos outros experimentos.
//
// Caso medido: escrita logo depois de o item entrar no cache (pior caso para
// o cache HTTP, cuja janela tende ao TTL). Com idades de entrada uniformes, a
// janela esperada seria ~TTL/2 — discutido na metodologia.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateSeedData, resetDatabase } from "../../prisma/seed";
import { config, type CacheStrategy } from "../config";
import { createDb } from "../db";
import { subirInfra, subirPilha, buildApi } from "./ambiente";
import { aguardarCondicoes, vigiarSuspensao } from "./energia";
import { gitInfo, makeRunId, maquina, versoes } from "./meta";
import { RESULTS_DIR } from "./paths";
import { shuffled } from "./runner";

const NGINX_URL = process.env["NGINX_URL"] ?? "http://localhost:8080";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ResultadoConsistencia {
  estrategia: CacheStrategy;
  n: number;
  ttlS: number;
  desatualizadasImediatas: number;
  pctDesatualizadas: number;
  /** Segundos entre a escrita e a primeira leitura com o dado novo (0 se já veio novo). */
  janelas: number[];
  janelaMediaS: number;
  janelaMaxS: number;
  /** Itens que não convergiram dentro de TTL + 15 s (esperado: 0). */
  naoConvergiram: number;
}

async function lerEstoque(id: number): Promise<number> {
  const res = await fetch(`${NGINX_URL}/produtos/${id}`);
  if (!res.ok) throw new Error(`GET /produtos/${id} → HTTP ${res.status}`);
  return ((await res.json()) as { estoque: number }).estoque;
}

async function alterarEstoque(id: number, estoque: number): Promise<void> {
  const res = await fetch(`${NGINX_URL}/produtos/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ estoque }),
  });
  if (!res.ok) throw new Error(`PATCH /produtos/${id} → HTTP ${res.status}`);
}

export async function medirConsistencia(
  estrategia: CacheStrategy,
  opts: { n: number; ttlS: number; seed: number },
): Promise<ResultadoConsistencia> {
  const db = createDb(config.databaseUrl, 2);
  try {
    await resetDatabase(db, generateSeedData());
  } finally {
    await db.$disconnect();
  }
  await subirPilha(estrategia, opts.ttlS);

  const ids = shuffled(
    Array.from({ length: 10_000 }, (_, i) => i + 1),
    opts.seed,
  ).slice(0, opts.n);
  // Valores novos garantidamente diferentes dos do seed (estoque do seed ≤ 500).
  const novo = new Map(ids.map((id, i) => [id, 10_000 + i]));

  for (const id of ids) {
    await lerEstoque(id);
    await lerEstoque(id);
  }

  const escritaEm = new Map<number, number>();
  for (const id of ids) {
    await alterarEstoque(id, novo.get(id)!);
    escritaEm.set(id, performance.now());
  }

  const janela = new Map<number, number>();
  const pendentes = new Set<number>();
  for (const id of ids) {
    if ((await lerEstoque(id)) === novo.get(id)) janela.set(id, 0);
    else pendentes.add(id);
  }
  const desatualizadasImediatas = pendentes.size;

  const limite = performance.now() + (opts.ttlS + 15) * 1000;
  while (pendentes.size > 0 && performance.now() < limite) {
    await sleep(500);
    for (const id of [...pendentes]) {
      if ((await lerEstoque(id)) === novo.get(id)) {
        janela.set(id, (performance.now() - escritaEm.get(id)!) / 1000);
        pendentes.delete(id);
      }
    }
  }

  const janelas = ids.filter((id) => janela.has(id)).map((id) => Math.round(janela.get(id)! * 100) / 100);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    estrategia,
    n: opts.n,
    ttlS: opts.ttlS,
    desatualizadasImediatas,
    pctDesatualizadas: r2((100 * desatualizadasImediatas) / opts.n),
    janelas,
    janelaMediaS: r2(janelas.reduce((a, b) => a + b, 0) / Math.max(1, janelas.length)),
    janelaMaxS: r2(Math.max(0, ...janelas)),
    naoConvergiram: pendentes.size,
  };
}

export async function experimentoConsistencia(opts: {
  estrategias: CacheStrategy[];
  n: number;
  ttlS: number;
  seed: number;
}): Promise<string> {
  const git = await gitInfo();
  await subirInfra();
  console.log("Construindo a imagem da API…");
  const imagemApi = await buildApi();
  const runId = makeRunId("consistencia", git);
  const dir = path.join(RESULTS_DIR, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "run.json"),
    `${JSON.stringify({ runId, criadoEm: new Date().toISOString(), git, config: { tipo: "consistencia", ...opts }, imagemApi, maquina: await maquina(), versoes: versoes() }, null, 2)}\n`,
  );
  console.log(`Consistência: ${opts.n} produtos por estratégia, TTL ${opts.ttlS}s → ${path.relative(process.cwd(), dir)}/`);
  const resultados: ResultadoConsistencia[] = [];
  for (const estrategia of opts.estrategias) {
    // Mesma proteção das outras medições: carregador e tampa aberta; se o
    // sistema suspender no meio, a janela medida seria falsa → repete.
    let r: ResultadoConsistencia | null = null;
    for (let i = 1; i <= 5 && !r; i++) {
      await aguardarCondicoes();
      const suspensao = await vigiarSuspensao();
      const tentativa = await medirConsistencia(estrategia, opts);
      const s = await suspensao();
      if (s > 0) console.warn(`  ⚠ ${estrategia}: o sistema ficou suspenso ~${s.toFixed(0)} s; repetindo.`);
      else r = tentativa;
    }
    if (!r) throw new Error(`Consistência (${estrategia}): o sistema suspendeu em 5 tentativas seguidas.`);
    resultados.push(r);
    console.log(
      `  ✓ ${estrategia.padEnd(6)} desatualizadas logo após a escrita: ${r.desatualizadasImediatas}/${r.n} (${r.pctDesatualizadas}%)` +
        `  janela média ${r.janelaMediaS}s  máx ${r.janelaMaxS}s${r.naoConvergiram ? `  ⚠ ${r.naoConvergiram} não convergiram` : ""}`,
    );
    writeFileSync(path.join(dir, "resultado.json"), `${JSON.stringify(resultados, null, 2)}\n`);
  }
  return dir;
}
