# Análise comparativa do impacto de estratégias de cache no desempenho de uma API REST

Parte prática do Trabalho de Conclusão de Curso de Ciência da Computação (Faculdade Municipal Professor Franco Montoro, 2026).

> 🚧 Em construção. O passo a passo completo de reprodução entra na fase final.

## Problema de pesquisa

Quais são os impactos das diferentes estratégias de cache no desempenho de uma API REST sob diferentes cargas de trabalho (predominância de escritas, carga mista e predominância de leituras)?

## Desenho do experimento

- **Aplicação:** API REST de catálogo de produtos de uma loja virtual (Node.js, Fastify, TypeScript, Prisma, PostgreSQL).
- **Estratégias de cache** (variável `CACHE_STRATEGY`):
  - `none`: sem cache (linha de base);
  - `memory`: cache em memória (LRU) dentro do processo da API;
  - `redis`: cache distribuído no Redis (*cache-aside*);
  - `http`: cache HTTP (`Cache-Control` + `ETag`), com o nginx como cache intermediário.
- **Invalidação:** TTL combinado com invalidação nas operações de escrita.
- **Cargas (k6):** leituras predominantes (90/10), mista (50/50) e escritas predominantes (10/90), com acesso concentrado em poucos produtos (distribuição Zipf).
- **Métricas:** latência p50/p95/p99, throughput, CPU e memória, taxa de acerto do cache e acessos ao banco.

## Pré-requisitos

- Node.js 20+ (referência: 24 LTS) e pnpm (`corepack enable`)
- Docker + Docker Compose
- k6

## Início rápido

```bash
corepack enable && pnpm install
cp .env.example .env
pnpm db:up          # Postgres (porta 5434) e Redis (porta 6380)
pnpm db:setup       # migrações + dados sintéticos (50 categorias, 10.000 produtos)
```

Rodar a API:

```bash
pnpm dev            # local, recarrega ao salvar (porta 3000)
pnpm api:up         # em contêiner, com 1 CPU e 512 MB (como nos experimentos)
pnpm test           # testes de integração (banco separado: catalogo_test)
```

Subir a pilha completa numa estratégia (a carga entra pelo nginx, porta 8080):

```bash
CACHE_STRATEGY=redis pnpm stack:up     # none | memory | redis | http
curl -i localhost:8080/produtos/42     # veja Cache-Control, ETag e X-Cache-Status
```

Todas as estratégias passam pelo nginx, para que o caminho de rede seja idêntico. Só na estratégia `http` a API marca as respostas como cacheáveis (`Cache-Control: public, max-age=TTL` + `ETag`); nas demais responde `no-store` e o nginx apenas repassa.

Rotas: `GET /produtos?categoria=&pagina=&limite=`, `GET /produtos/:id`, `POST /produtos`, `PUT /produtos/:id`, `DELETE /produtos/:id`.

O seed é determinístico e imprime um *fingerprint* (`239da9743c2035fc`), que deve ser igual em qualquer máquina.

## Licença

Código sob [MIT](LICENSE).
