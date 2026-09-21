# Metodologia experimental

Este documento descreve **exatamente** o que foi implementado e medido, com os parâmetros e as justificativas de cada decisão. Os valores numéricos citados estão fixados no código. Onde houver um arquivo de referência, ele está indicado.

## 1. Sistema sob teste

### 1.1 Aplicação

API REST de catálogo de produtos de uma loja virtual, em **Node.js 24 + Fastify 5 + TypeScript + Prisma 7 + PostgreSQL 17.6**.

| Rota | Operação | Acessos ao banco (sem cache) |
|---|---|---|
| `GET /produtos?categoria=&pagina=&limite=` | listagem paginada de produtos ativos (20 por página) | 2 operações Prisma: itens e total |
| `GET /produtos/:id` | consulta de um produto com a categoria | 1 operação Prisma (2 comandos SQL) |
| `POST /produtos` | criação | escrita + invalidação |
| `PUT /produtos/:id` | atualização completa | escrita + invalidação |
| `PATCH /produtos/:id` | atualização parcial (preço, estoque) | escrita + invalidação |
| `DELETE /produtos/:id` | remoção | escrita + invalidação |

- **Validação:** entrada e saída validadas por JSON Schema. A saída é serializada pelo `fast-json-stringify` do próprio Fastify.
- **Dados:** 50 categorias e 10.000 produtos sintéticos gerados com `@faker-js/faker` (locale pt_BR), semente fixa `20263` e datas fixas.
- **Estado inicial idêntico:** o conteúdo gerado tem *fingerprint* `239da9743c2035fc`, e o banco é restaurado a esse estado antes de cada medição.
- **Código:** `src/`, `prisma/`.

### 1.2 Estratégias de cache (variável independente 1)

A estratégia é escolhida pela variável de ambiente `CACHE_STRATEGY`, **no mesmo código**: só muda o componente de cache. O TTL é de 60 s em todas.

| Estratégia | Onde fica o cache | Leitura | Escrita |
|---|---|---|---|
| `none` (linha de base) | não há | sempre no banco | — |
| `memory` | processo da API: LRU (`lru-cache`) com até 10.000 entradas e TTL | *cache-aside*: acerto → resposta do cache; erro → banco + grava no cache | remove a entrada do produto e incrementa a **versão das listagens** |
| `redis` | Redis 7.4.11, sem persistência, `maxmemory 128mb` com `allkeys-lru` | *cache-aside* com (de)serialização JSON; falha do Redis vira erro de cache (a API não cai) | igual à `memory` (`DEL` + `INCR` da versão) |
| `http` | nginx 1.28.3 (cache compartilhado em tmpfs) e cliente | API envia `Cache-Control: public, max-age=60` e `ETag` forte (SHA-1 do corpo); `If-None-Match` igual → **304** | nenhuma invalidação: o dado antigo vale até o `max-age` expirar |

- **Invalidação das listagens:** as chaves de listagem incluem um número de versão. Incrementá-lo invalida todas as páginas de uma vez, em O(1), sem varrer chaves. É a política "TTL + invalidação por escrita, deliberadamente simples" prevista no pré-projeto. As chaves antigas deixam de ser lidas e saem por TTL ou LRU.
- **Respostas 404:** não são armazenadas (sem cache negativo).
- **nginx em todas as estratégias:** o nginx está no caminho de **todas** as estratégias, para que a topologia de rede seja idêntica. Nas estratégias `none`, `memory` e `redis`, a API responde `Cache-Control: no-store` e o nginx só repassa. Assim, a diferença entre as estratégias não inclui o custo de um salto de rede extra.
- **Configuração do nginx:** `proxy_cache_revalidate on` (ao expirar, revalida com requisição condicional) e `proxy_cache_lock on` (misses simultâneos do mesmo item geram uma só ida à API).
- **Arquivos:** `src/cache/`, `src/http-cache.ts`, `nginx/nginx.conf`.

### 1.3 Ambiente e isolamento

Todos os serviços rodam em contêineres Docker (`docker-compose.yml`), com **limites fixos de recursos**, para que a capacidade de cada componente seja a mesma em todas as execuções:

| Contêiner | CPUs | Memória |
|---|---|---|
| API | 1 | 512 MiB |
| PostgreSQL | 2 | 1 GiB |
| Redis | 1 | 256 MiB |
| nginx | 1 | 256 MiB |
| k6 (gerador de carga) | 2 | 1 GiB |

- **Por que o k6 roda em contêiner:** ele fica na mesma rede interna do Docker que os serviços. No macOS, o encaminhamento de portas do Docker Desktop vira gargalo em taxas altas e distorceria as medidas.
- **Máquina, versões e imagem:** registradas em `run.json` em toda rodada. Resultados de máquinas diferentes não devem ser misturados.

## 2. Carga de trabalho (variável independente 2)

Gerada com **k6 2.2.0** (`k6/carga.js`) no modelo de **taxa de chegada constante** (`constant-arrival-rate`): o k6 inicia N requisições por segundo, independentemente do tempo de resposta. Esse modelo "aberto" representa usuários independentes e evita a omissão coordenada (*coordinated omission*): quando o sistema fica lento, as requisições que não puderam ser iniciadas são contadas como **descartadas**.

| Carga | Leituras | Escritas |
|---|---|---|
| Leitura predominante | 90% | 10% |
| Mista | 50% | 50% |
| Escrita predominante | 10% | 90% |

- **Leituras:** 80% `GET /produtos/:id` e 20% `GET /produtos?categoria=…&pagina=…`. A página é a 1 em 70% dos casos, a 2 em 20% e a 3 em 10%.
- **Escritas:** 80% `PATCH` de preço ou estoque, 15% `POST` e 5% `DELETE`, este apenas de produtos criados pela própria carga, para não afetar as leituras.
- **Popularidade:** produtos e categorias seguem uma **distribuição Zipf com expoente s = 1**. Poucos itens concentram a maior parte dos acessos, como em catálogos reais. Os itens mais populares são espalhados pelo catálogo por uma permutação fixa (semente 42).
- **Mesmo modelo nas escritas:** as escritas seguem a mesma popularidade, então os itens mais lidos também são os mais alterados. Isso é o que torna a invalidação relevante.
- **Usuários virtuais (VUs) do k6:** são pré-alocados VUs equivalentes a 1 s de chegadas (a taxa em req/s, entre 50 e 1.000). Uma pausa curta do sistema vira fila (latência), em vez de obrigar o k6 a criar VUs no meio do teste, o que consome CPU do gerador e produz descartes artificiais. As tabelas da distribuição Zipf são calculadas uma vez e compartilhadas entre os VUs (`SharedArray`), então 1.000 VUs inicializam em menos de 1 s e ocupam ~0,3 MiB cada.
- **Cliente com ETag:** o cliente guarda o último `ETag` de cada URL e o reenvia em `If-None-Match`. Só tem efeito na estratégia `http`, a única em que a API envia ETag. O cliente **não** reaproveita respostas localmente sem consultar o servidor, o que é uma escolha conservadora: mede o efeito do servidor e do intermediário, não o do cache do navegador.

## 3. Protocolo de uma medição

Idêntico para todas as estratégias (`src/experimento/runner.ts`):

0. **Condições da máquina** (`src/experimento/energia.ts`): a medição só começa com o carregador conectado e a tampa do notebook aberta; se não, o runner pausa e espera. Ao final, verifica se o sistema suspendeu durante a medição (mudança de `kern.waketime` no macOS ou diferença entre o relógio de parede e o monotônico). Se suspendeu, a medição é descartada e repetida. A energia e a tampa ficam registradas em cada medição (`condicoes`).
1. Restaura o banco ao estado inicial (seed determinístico).
2. Recria os contêineres da API (com a estratégia) e do nginx e esvazia o Redis. O processo da API é novo e **todos os caches começam vazios**.
3. **Aquecimento:** k6 com a mesma carga e taxa da medição. O resultado é descartado. Serve para aquecer o JIT do Node.js, o pool de conexões e os caches.
4. Zera as métricas internas da API e as estatísticas do PostgreSQL. O cache continua aquecido.
5. **Medição:** k6 com a carga e a taxa definidas. Em paralelo, o `docker stats` amostra CPU e memória de cada contêiner (≈2 amostras/s), incluindo o próprio k6. Só entram no resumo as amostras da janela do cenário: o k6 registra o instante em que o cenário começa (após inicializar os VUs), e a primeira amostra seguinte é descartada.
6. **Coleta:** resumo do k6, métricas internas da API e `pg_stat_statements`. Tudo é gravado em `medicoes.jsonl`.

## 4. Experimentos

### E0 — Calibração da taxa

Linha de base (`none`) nas três cargas, em degraus crescentes de taxa (15 s de aquecimento + 20 s de medição), até a primeira taxa **não sustentável**.

> **Taxa sustentável:** p95 < 100 ms, menos de 1% das requisições descartadas e menos de 1% de erros.

> **Confirmação de degrau reprovado (E0 e E2):** um degrau reprovado é medido uma segunda vez e só encerra a escada se reprovar de novo. Motivo: no ensaio, uma única pausa de ~1 s da máquina reprovou um degrau muito abaixo da capacidade real (latência máxima de 1 s com a API em 43% de CPU). Na repetição, o mesmo degrau passou com folga (p99 de 7 ms). As duas medições ficam registradas (coluna `tentativa`).

A taxa do experimento de latência é ≈60% da menor capacidade sustentável da linha de base, arredondada para baixo em múltiplos de 50. Assim, a linha de base opera longe da saturação, e as diferenças medidas refletem o custo de cada estratégia, não o colapso por fila.

### E1 — Latência

- **Desenho:** 4 estratégias × 3 cargas × **5 repetições** = 60 medições, na taxa calibrada, com **30 s de aquecimento + 60 s de medição**.
- **Ordem:** em cada repetição, as 12 combinações rodam em **ordem sorteada** (semente fixa). Isso evita que efeitos dependentes do tempo, como o aquecimento térmico da máquina, favoreçam sistematicamente uma estratégia.
- **Variáveis dependentes:** latência (média, p50, p90, p95, p99, máximo; geral, de leituras e de escritas), throughput atendido, taxa de erros, taxa de acerto do cache, acessos ao banco (operações Prisma e comandos SQL) e CPU/memória de cada contêiner.

### E2 — Capacidade (throughput máximo sustentável)

- **Desenho:** para cada estratégia × carga, a taxa sobe em degraus (400, 600, 800, 1.000, 1.200, 1.600 e 2.000 req/s), com 15 s de aquecimento e 30 s de medição cada, até a primeira taxa não sustentável.
- **Resultado:** capacidade = maior degrau sustentável (com a mesma regra de confirmação do E0), com **3 repetições** em ordem sorteada.
- **Resolução:** limitada à distância entre degraus. Se a estratégia sustenta o maior degrau, a capacidade real é "≥ 2.000 req/s".

### E3 — Consistência após escrita

Sem carga concorrente, para cada estratégia (`src/experimento/consistencia.ts`):

1. Lê 100 produtos (amostra fixa) duas vezes, o que coloca cada item no cache.
2. Altera o estoque de cada um (PATCH) e registra o instante da escrita.
3. Lê imediatamente cada produto e conta quantas leituras voltaram **desatualizadas**.
4. Relê os desatualizados a cada 0,5 s até o dado novo aparecer. O tempo desde a escrita é a **janela de inconsistência**.

Este experimento mede o compromisso da estratégia HTTP: o intermediário não é avisado das escritas. O caso medido é o pior (escrita logo após o item entrar no cache); com idades de entrada uniformes, a janela esperada seria ≈TTL/2.

## 5. Métricas: definição e fonte

| Métrica | Definição | Fonte |
|---|---|---|
| Latência p50/p95/p99 | percentis do tempo total da requisição (envio → último byte), vistos pelo cliente | k6 (`http_req_duration`) |
| Throughput | requisições concluídas por segundo na medição | k6 (`http_reqs`) |
| Capacidade | maior taxa sustentável (E2) | runner |
| Taxa de erros | respostas com status inesperado (ex.: 5xx) ÷ total | k6 |
| Descartadas | requisições que o k6 não conseguiu iniciar por falta de capacidade do sistema | k6 (`dropped_iterations`) |
| Taxa de acerto | `memory`/`redis`: acertos ÷ consultas ao cache da aplicação; `http`: respostas `HIT` do nginx ÷ leituras | API e k6 |
| Acessos ao banco | operações do Prisma (API) e comandos SQL executados (PostgreSQL, `pg_stat_statements`) | API e PostgreSQL |
| CPU / memória | média e pico das amostras do `docker stats`; CPU em % de 1 núcleo | Docker |
| Leituras desatualizadas / janela | E3 | runner |

## 6. Análise estatística

`scripts/analise.py` e `scripts/estatistica.py`, com testes em `scripts/test_estatistica.py`.

- **Descrição:** média ± desvio padrão amostral (e mediana) das repetições, como previsto no pré-projeto.
- **Diferença entre as 4 estratégias:** teste de **Kruskal-Wallis** por carga, com p-valor por **permutação** (20.000 reamostragens, semente fixa). A aproximação qui-quadrado é pouco confiável com 5 observações por grupo.
- **Comparações par a par:** teste **U de Mann-Whitney exato** bilateral, com ajuste de **Holm** dentro de cada carga × métrica. Com 5 × 5 observações, o menor p exato possível é 2/252 ≈ 0,008.
- **Tamanho do efeito:** razão entre medianas e **delta de Cliff**. |d| < 0,147 é desprezível, < 0,33 pequeno, < 0,474 médio e acima disso grande.
- **Capacidade (E2):** com 3 repetições, é descrita sem teste de significância.
- **Diagnóstico de deriva:** correlação de Spearman entre a ordem de execução e o p95 da linha de base.

## 7. Ameaças à validade

- **Suspensão do sistema:** no macOS, o `caffeinate` não impede o repouso com a tampa fechada ou na bateria. Uma primeira execução completa foi invalidada por isso (371 eventos de repouso durante a madrugada; latências de minutos) e descartada por inteiro.
  - Mitigação: verificação de energia e tampa antes de cada medição e detecção de suspensão depois dela, com repetição automática (passo 0 do protocolo).
- **Perturbações transitórias da máquina:** pausas curtas (sistema operacional, virtualização do Docker) afetam medições isoladas.
  - Mitigação: confirmação dos degraus reprovados (E0, E2); no E1, 5 repetições em ordem sorteada, gráficos pela mediana e testes não paramétricos, que são robustos a uma repetição atípica. Nenhuma medição é descartada ou refeita manualmente.
- **Mesma máquina para carga e sistema:** o k6 e os serviços dividem o hardware.
  - Mitigação: limites de CPU por contêiner e uso de CPU do k6 registrado em cada medição. Pico abaixo de 200% (o limite do contêiner) indica que o gerador não saturou.
- **Hardware de referência sem ventoinha (MacBook Air M1, 8 GB):** sob carga prolongada, a CPU pode reduzir a frequência.
  - Mitigação: ordem sorteada, aquecimento em toda medição e diagnóstico de deriva. Os números absolutos valem para esse hardware; as comparações relativas são o foco.
- **Uma única instância da API:** o cache em memória não é compartilhado entre instâncias. Com várias réplicas, as escritas invalidariam só a réplica que as processou, e as demais serviriam dados antigos até o TTL. Esse cenário **não foi medido** e é discutido de forma teórica.
- **Rede local virtualizada:** não há latência de rede real entre cliente e servidor nem entre API e Redis. Em produção, o custo relativo do Redis (uma ida e volta de rede) tende a ser maior.
- **Parâmetros fixos:** TTL de 60 s, Zipf com s = 1, 10.000 produtos e taxas fixas. Outros valores podem mudar a magnitude dos efeitos; não há análise de sensibilidade.
- **Dados sintéticos:** o volume e a distribuição dos dados não reproduzem uma loja real específica.
- **Cliente HTTP conservador:** o cliente não usa o cache local do navegador (sempre consulta o servidor). O benefício do cache HTTP para um usuário final real tende a ser maior que o medido.

## 8. Reprodução

```bash
pnpm install && cp .env.example .env
pnpm db:up && pnpm db:setup
pnpm test && pnpm test:py
pnpm experimento calibrar                 # anota a taxa sugerida
pnpm experimento latencia --taxa <taxa>
pnpm experimento capacidade
pnpm experimento consistencia
pnpm py:setup && pnpm analise             # gráficos, tabelas e docs/RESULTADOS.md
```

Toda rodada pode ser interrompida com Ctrl+C e retomada com `--run-id <id>`.
