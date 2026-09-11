# Análise comparativa do impacto de estratégias de cache no desempenho de uma API REST

Parte prática do Trabalho de Conclusão de Curso de Ciência da Computação — Faculdade Municipal Professor Franco Montoro, 2026.

**Problema de pesquisa:** quais são os impactos das diferentes estratégias de cache no desempenho de uma API REST sob diferentes cargas de trabalho (predominância de escritas, carga mista e predominância de leituras)?

| Documento | Conteúdo |
|---|---|
| [`docs/METODOLOGIA.md`](docs/METODOLOGIA.md) | protocolo experimental completo, parâmetros, justificativas e ameaças à validade |
| [`docs/RESULTADOS.md`](docs/RESULTADOS.md) | tabelas, gráficos e testes estatísticos (gerado a partir dos dados) |
| [`docs/PLANO.md`](docs/PLANO.md) | plano e status da parte prática |
| [`results/final/`](results/final/) | dados brutos e consolidados dos experimentos, gráficos em PNG e tabelas em CSV |

## O que foi construído

- **API REST de catálogo de produtos** (Node.js 24, Fastify 5, TypeScript, Prisma 7, PostgreSQL 17.6). Rotas: `GET /produtos` (listagem paginada), `GET /produtos/:id`, `POST`, `PUT`, `PATCH` e `DELETE /produtos/:id`.
- **Quatro configurações de cache no mesmo código**, escolhidas pela variável `CACHE_STRATEGY`:
  - `none`: sem cache (linha de base);
  - `memory`: cache em memória no processo (LRU + TTL);
  - `redis`: cache distribuído no Redis (*cache-aside*);
  - `http`: cache HTTP (`Cache-Control` + `ETag`, com resposta 304), com o nginx como cache intermediário.
- **Invalidação:** TTL (60 s) combinado com invalidação por escrita (produto + versão das listagens).
- **Carga com k6:** leitura (90/10), mista (50/50) e escrita (10/90), com popularidade Zipf.
- **Runner de experimentos** com o mesmo protocolo em todas as medições:
  - restauração do banco;
  - caches vazios;
  - aquecimento;
  - medição com coleta de latência, throughput, CPU/memória, taxa de acerto e acessos ao banco.
- **Análise estatística e gráficos** prontos para a monografia.

## Pré-requisitos

- Node.js 20+ (referência: 24 LTS, ver `.nvmrc`) e pnpm (`corepack enable`)
- Docker e Docker Compose (VM com pelo menos 8 CPUs e 4 GB de memória)
- Python 3.9+ (apenas para a análise)

O k6 roda em contêiner; não é preciso instalá-lo.

## Reprodução completa

```bash
# 1. Dependências e banco
corepack enable && pnpm install
cp .env.example .env
pnpm db:up            # PostgreSQL (porta 5434) e Redis (porta 6380)
pnpm db:setup         # migrações + seed (50 categorias, 10.000 produtos)

# 2. Testes
pnpm test             # testes de integração da API e das estratégias (vitest)
pnpm py:setup         # ambiente Python da análise (uma vez)
pnpm test:py          # testes das funções estatísticas

# 3. Experimentos (cada um pode ser interrompido com Ctrl+C e retomado com --run-id)
pnpm experimento calibrar                 # E0: mostra a taxa sugerida (~30 min)
pnpm experimento latencia --taxa <taxa>   # E1: 60 medições (~1h45)
pnpm experimento capacidade               # E2: throughput máximo sustentável (~2h30)
pnpm experimento consistencia             # E3: leituras desatualizadas após escrita (~5 min)

# 4. Análise: gráficos, tabelas, testes estatísticos e docs/RESULTADOS.md
pnpm analise
```

- **Conferência do seed:** o `db:setup` imprime o *fingerprint* `239da9743c2035fc`. Se o valor for outro, o estado inicial do banco é diferente.
- **Recursos durante os experimentos:** feche outros programas pesados. Os resultados valem para a máquina em que foram obtidos (registrada em `run.json`).

### Comandos úteis

```bash
pnpm dev                                  # API local com recarga (porta 3000)
CACHE_STRATEGY=redis pnpm stack:up        # pilha completa numa estratégia (entrada pelo nginx, porta 8080)
curl -i localhost:8080/produtos/42        # veja Cache-Control, ETag e X-Cache-Status
pnpm experimento latencia --dry-run       # mostra o plano (ordem sorteada) sem executar
pnpm experimento relatorio --run-id <id>  # regenera medicoes.csv e resumo.json de uma rodada
```

## Estrutura

```
src/
  app.ts, server.ts         aplicação Fastify e ponto de entrada
  produtos/                 rotas e serviço (cache-aside + invalidação por escrita)
  cache/                    estratégias memory (LRU) e redis; interface comum
  http-cache.ts             Cache-Control, ETag e 304 (estratégia http)
  metrics.ts                contadores internos (requisições, banco, acertos)
  experimento/              runner: ambiente Docker, k6, coleta, consistência, relatório
prisma/                     schema, migrações e seed determinístico
k6/carga.js                 carga de trabalho (taxa constante, Zipf, 3 cargas)
nginx/nginx.conf            nginx à frente da API (cache compartilhado na estratégia http)
scripts/                    CLI dos experimentos, análise (Python) e estatística
tests/                      testes vitest (API, estratégias, cache HTTP, seed)
docs/                       plano, metodologia e resultados
results/final/              dados e figuras dos experimentos finais
```

## Licença

Código sob a licença [MIT](LICENSE).
