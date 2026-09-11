// Carga do experimento (k6).
//
// Variáveis de ambiente:
//   BASE_URL      alvo (padrão: http://nginx:8080 — todas as estratégias passam pelo nginx)
//   WORKLOAD      leitura | mista | escrita   (90/10, 50/50, 10/90 leituras/escritas)
//   RATE          requisições por segundo (taxa de chegada constante)
//   DURATION      duração, ex.: 60s
//   PHASE         aquecimento | medicao | calibracao (entra no SKU dos produtos criados)
//   SEED          semente do gerador pseudoaleatório
//   ZIPF_S        expoente da distribuição Zipf de popularidade (padrão 1.0)
//   SUMMARY_PATH  arquivo JSON do resumo (opcional)
//
// Modelo de acesso:
//   leituras: 80% GET /produtos/:id e 20% GET /produtos?categoria=&pagina= (página 1, 2 ou 3)
//   escritas: 80% PATCH (preço/estoque), 15% POST, 5% DELETE de produtos criados pela carga
//   produtos e categorias seguem Zipf: poucos itens "quentes" concentram os acessos.
//   O cliente reenvia If-None-Match quando já tem um ETag da URL (só surte efeito
//   na estratégia http, a única em que a API envia ETag).
import http from "k6/http";
import { check } from "k6";
import { Counter, Rate } from "k6/metrics";
import { SharedArray } from "k6/data";

const BASE = __ENV.BASE_URL || "http://nginx:8080";
const WORKLOAD = __ENV.WORKLOAD || "leitura";
const RATE = Number(__ENV.RATE || 200);
const DURATION = __ENV.DURATION || "60s";
const PHASE = __ENV.PHASE || "medicao";
const SEED = Number(__ENV.SEED || 42);
const ZIPF_S = Number(__ENV.ZIPF_S || 1.0);

const N_PRODUTOS = 10000;
const N_CATEGORIAS = 50;
const READ_SHARE = { leitura: 0.9, mista: 0.5, escrita: 0.1 }[WORKLOAD];
if (READ_SHARE === undefined) throw new Error(`WORKLOAD inválido: ${WORKLOAD}`);

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max", "count"],
  scenarios: {
    carga: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      // VUs pré-alocados = 1 s de chegadas: uma pausa curta do sistema vira fila
      // (latência) em vez de obrigar o k6 a criar VUs no meio do teste, o que
      // consome CPU do gerador e produz descartes artificiais.
      preAllocatedVUs: Math.min(1000, Math.max(50, RATE)),
      maxVUs: 1000,
    },
  },
  // Limiares sem critério de aprovação: servem para o k6 calcular as
  // submétricas por tipo de requisição no resumo.
  thresholds: {
    "http_req_duration{tipo:leitura}": ["max>=0"],
    "http_req_duration{tipo:escrita}": ["max>=0"],
    "http_req_duration{endpoint:item}": ["max>=0"],
    "http_req_duration{endpoint:lista}": ["max>=0"],
    "http_req_duration{endpoint:patch}": ["max>=0"],
    "http_req_duration{endpoint:post}": ["max>=0"],
    "http_req_duration{endpoint:delete}": ["max>=0"],
  },
};

const nginxHit = new Counter("nginx_cache_hit");
const nginxMiss = new Counter("nginx_cache_miss");
const notModified = new Counter("respostas_304");
const erros = new Rate("taxa_erros");

// --- Gerador pseudoaleatório determinístico (mulberry32) ----------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Zipf: CDF acumulada e permutação fixa rank → id ----------------------------
function zipfCdf(n, s) {
  const cdf = new Float64Array(n);
  let sum = 0;
  for (let i = 1; i <= n; i++) {
    sum += 1 / Math.pow(i, s);
    cdf[i - 1] = sum;
  }
  for (let i = 0; i < n; i++) cdf[i] /= sum;
  return cdf;
}

function sampleRank(cdf, u) {
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  return lo; // 0-based
}

function permutation(n, seed) {
  const rng = mulberry32(seed);
  const p = new Int32Array(n);
  for (let i = 0; i < n; i++) p[i] = i + 1;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  return p;
}

// As tabelas são calculadas uma única vez e compartilhadas entre os VUs
// (SharedArray). Calculá-las em cada VU custava ~14 ms de CPU e ~1 MiB por VU,
// o que atrasava a inicialização e obrigava a pré-alocar poucos VUs.
const CDF_PRODUTOS = new SharedArray("cdf_produtos", () => Array.from(zipfCdf(N_PRODUTOS, ZIPF_S)));
const CDF_CATEGORIAS = new SharedArray("cdf_categorias", () => Array.from(zipfCdf(N_CATEGORIAS, ZIPF_S)));
// Os itens mais populares ficam espalhados pelo catálogo (não são os IDs 1, 2, 3…).
const PRODUTO_POR_RANK = new SharedArray("perm_produtos", () => Array.from(permutation(N_PRODUTOS, SEED)));
const CATEGORIA_POR_RANK = new SharedArray("perm_categorias", () => Array.from(permutation(N_CATEGORIAS, SEED + 1)));

// --- Estado por VU --------------------------------------------------------------
let rng = null;
const etags = new Map(); // URL → último ETag recebido
const criados = []; // IDs criados por este VU (candidatos a DELETE)

const produtoZipf = () => PRODUTO_POR_RANK[sampleRank(CDF_PRODUTOS, rng())];
const categoriaZipf = () => CATEGORIA_POR_RANK[sampleRank(CDF_CATEGORIAS, rng())];
const JSON_HEADERS = { "Content-Type": "application/json" };

function registrar(res, esperados) {
  const ok = esperados.includes(res.status);
  erros.add(!ok);
  check(res, { "status esperado": () => ok });
  if (res.status === 304) notModified.add(1);
}

/** Resultado do cache do nginx (só leituras passam pelo cache). */
function registrarCacheNginx(res) {
  const status = res.headers["X-Cache-Status"];
  if (status === "HIT") nginxHit.add(1);
  else if (status) nginxMiss.add(1);
}

function leitura() {
  let url;
  let endpoint;
  if (rng() < 0.8) {
    url = `${BASE}/produtos/${produtoZipf()}`;
    endpoint = "item";
  } else {
    const u = rng();
    const pagina = u < 0.7 ? 1 : u < 0.9 ? 2 : 3;
    url = `${BASE}/produtos?categoria=${categoriaZipf()}&pagina=${pagina}&limite=20`;
    endpoint = "lista";
  }
  const headers = {};
  const etag = etags.get(url);
  if (etag) headers["If-None-Match"] = etag;
  const res = http.get(url, { headers, tags: { tipo: "leitura", endpoint, name: endpoint } });
  if (res.headers["Etag"]) etags.set(url, res.headers["Etag"]);
  registrar(res, [200, 304]);
  registrarCacheNginx(res);
}

function escrita() {
  const u = rng();
  if (u < 0.05 && criados.length > 0) {
    const id = criados.pop();
    const res = http.del(`${BASE}/produtos/${id}`, null, { tags: { tipo: "escrita", endpoint: "delete", name: "delete" } });
    registrar(res, [204]);
    return;
  }
  if (u < 0.2) {
    const sku = `K6-${PHASE.slice(0, 3)}-${__VU}-${__ITER}`;
    const body = JSON.stringify({
      sku,
      nome: `Produto de carga ${sku}`,
      descricao: "Criado pelo teste de carga.",
      preco: Math.round(rng() * 100000) / 100,
      estoque: Math.floor(rng() * 500),
      categoriaId: categoriaZipf(),
    });
    const res = http.post(`${BASE}/produtos`, body, {
      headers: JSON_HEADERS,
      responseType: "text",
      tags: { tipo: "escrita", endpoint: "post", name: "post" },
    });
    registrar(res, [201]);
    if (res.status === 201) criados.push(JSON.parse(res.body).id);
    return;
  }
  const body = JSON.stringify({ preco: Math.round(rng() * 100000) / 100, estoque: Math.floor(rng() * 500) });
  const res = http.patch(`${BASE}/produtos/${produtoZipf()}`, body, {
    headers: JSON_HEADERS,
    tags: { tipo: "escrita", endpoint: "patch", name: "patch" },
  });
  registrar(res, [200]);
}

// Roda depois de inicializar os VUs e imediatamente antes do cenário: o instante
// vai para o resumo (setup_data) e delimita a janela de amostragem de CPU/memória.
export function setup() {
  return { inicio: Date.now() };
}

export default function () {
  if (rng === null) rng = mulberry32(SEED + __VU * 7919);
  if (rng() < READ_SHARE) leitura();
  else escrita();
}

export function handleSummary(data) {
  const m = data.metrics;
  const d = m.http_req_duration.values;
  const line =
    `[${WORKLOAD} @ ${RATE} req/s] reqs=${m.http_reqs.values.count} ` +
    `p50=${d.med.toFixed(1)}ms p95=${d["p(95)"].toFixed(1)}ms p99=${d["p(99)"].toFixed(1)}ms ` +
    `erros=${((m.taxa_erros?.values.rate ?? 0) * 100).toFixed(2)}% ` +
    `descartadas=${m.dropped_iterations?.values.count ?? 0}\n`;
  const out = { stdout: line };
  if (__ENV.SUMMARY_PATH) out[__ENV.SUMMARY_PATH] = JSON.stringify(data);
  return out;
}
