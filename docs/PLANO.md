# Plano da parte prática

Objetivo: entregar a parte prática **completa e fechada**, com experimentos executados, resultados analisados e documentação pronta para a redação da monografia, sem necessidade de voltar ao código.

## 1. Implementação

| # | Item | Status (✅ pronto · ⏳ em andamento) |
|---|---|---|
| 1 | Esqueleto, Docker Compose, Prisma, seed determinístico | ✅ |
| 2 | API REST (Fastify): listagem, consulta, criação, atualização (PUT/PATCH), remoção | ✅ |
| 3 | Estratégias: `none`, `memory` (LRU), `redis` (cache-aside), `http` (Cache-Control + ETag + nginx) | ✅ |
| 4 | Invalidação: TTL + invalidação por escrita (produto + versão das listagens) | ✅ |
| 5 | Carga k6: leitura (90/10), mista (50/50), escrita (10/90), popularidade Zipf | ✅ |
| 6 | Runner: calibração, latência e capacidade; coleta de todas as métricas | ✅ |
| 7 | Experimento de **consistência**: leituras desatualizadas após escrita | ⏳ |
| 8 | Amostragem de CPU do próprio k6 (prova de que o gerador não é o gargalo) | ⏳ |
| 9 | Análise: tabelas, gráficos e testes estatísticos | ⏳ |
| 10 | Documentação: README, metodologia e resultados | ⏳ |
| 12 | Sentinela de saúde do ambiente (a cada 10 medições) e execução sem supervisão retomável | ✅ |
| 11 | Robustez do protocolo: confirmação de degraus reprovados, janela de amostragem alinhada ao cenário, tabelas Zipf compartilhadas entre VUs, verificação de energia/tampa e repetição de medições com suspensão do sistema | ⏳ |

## 2. Experimentos

| # | Experimento | Pergunta que responde | Desenho | Duração |
|---|---|---|---|---|
| E0 | Calibração | Qual taxa usar? | `none`, 3 cargas, degraus de 200 a 1.200 req/s | ~30 min |
| E1 | Latência | Qual o impacto de cada estratégia na latência, nos recursos, nos acertos e nos acessos ao banco? | 4 estratégias × 3 cargas × 5 repetições, taxa fixa (≈60% da capacidade da linha de base), 30 s de aquecimento + 60 s de medição | ~1h45 |
| E2 | Capacidade | Qual o maior throughput sustentável de cada estratégia? | 4 × 3 × 3 repetições, degraus de 400 a 2.000 req/s até a primeira taxa não sustentável | ~2h30 |
| E3 | Consistência | Quanto cada estratégia entrega dado desatualizado após uma escrita? | 4 estratégias × 100 produtos (leitura → escrita → leitura imediata) + tempo até o dado novo aparecer | ~5 min |

**Critério de taxa sustentável:** p95 < 100 ms, menos de 1% de requisições descartadas e menos de 1% de erros. Um degrau reprovado é medido de novo e só encerra a escada se reprovar outra vez.

## 3. Métricas (do pré-projeto) e onde estão

| Métrica | Fonte | Experimento |
|---|---|---|
| Latência p50/p95/p99 (geral, leituras, escritas) | k6 | E1 |
| Throughput máximo sustentável | k6 (degraus) | E2 |
| CPU e memória (API, Postgres, Redis, nginx, k6) | `docker stats` | E1, E2 |
| Taxa de acerto do cache | API (memory/redis) e nginx (http) | E1, E2 |
| Acessos ao banco | extensão do Prisma e `pg_stat_statements` | E1, E2 |
| Leituras desatualizadas e janela de inconsistência | experimento dedicado | E3 |

## 4. Análise estatística

- **Descrição:** média ± desvio padrão (e mediana) de cada métrica por estratégia × carga, sobre as 5 repetições.
- **Comparação entre as 4 estratégias:** teste de Kruskal-Wallis por carga, adequado para amostras pequenas sem supor normalidade.
- **Comparações par a par:** teste de Mann-Whitney exato com ajuste de Holm, contra a linha de base e entre todas as estratégias.
- **Tamanho do efeito:** razão entre as medianas (ex.: "p95 2,3× menor que sem cache") e delta de Cliff.
- **Diagnóstico de deriva:** latência da linha de base ao longo da ordem de execução, para verificar se o aquecimento térmico da máquina afetou os resultados.

## 5. Ameaças à validade (documentadas em `docs/METODOLOGIA.md`)

- Gerador de carga e sistema na mesma máquina (mitigado: CPUs limitadas por contêiner; uso de CPU do k6 registrado).
- Notebook sem ventoinha (MacBook Air M1): possível redução de desempenho por temperatura (mitigado: ordem sorteada, diagnóstico de deriva).
- Uma única instância da API: o problema de coerência do cache em memória com várias instâncias não é medido (discussão teórica).
- Dados sintéticos e distribuição Zipf (s = 1) como modelo de popularidade.
- TTL fixo em 60 s (sem análise de sensibilidade).

## 6. Entregáveis para a redação

- `docs/METODOLOGIA.md`: protocolo experimental completo, com todos os parâmetros e as justificativas.
- `docs/RESULTADOS.md`: tabelas, gráficos e principais achados, gerados automaticamente a partir dos dados.
- `results/final/`: dados brutos e consolidados de todos os experimentos (versionados).
- `results/final/figs/`: gráficos em PNG prontos para a monografia.
