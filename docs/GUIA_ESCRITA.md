# Guia de escrita da monografia (parte prática)

Este guia liga cada parte da monografia ao material pronto no repositório. A parte prática está **fechada**: código, experimentos, dados, gráficos, tabelas e testes estatísticos. Nada precisa ser rodado de novo para escrever.

| Onde está | O que tem |
|---|---|
| [`METODOLOGIA.md`](METODOLOGIA.md) | tudo o que foi feito e por quê, com os parâmetros |
| [`RESULTADOS.md`](RESULTADOS.md) | todos os números, tabelas e gráficos (gerados dos dados) |
| [`../results/final/figs/`](../results/final/figs/) | gráficos em PNG (300 dpi), prontos para inserir |
| [`../results/final/tabelas/`](../results/final/tabelas/) | tabelas em CSV (abrem no Excel/Sheets) |
| `../results/final/*/run.json` | máquina, versões, parâmetros e commit de cada experimento |

## 1. Objetivos específicos → evidência

| Objetivo específico (pré-projeto) | Onde está a evidência |
|---|---|
| Implementar a API REST (Node.js, Fastify, TypeScript, Prisma, PostgreSQL) | `src/`, `prisma/`; Metodologia §1.1 |
| Implementar as 4 configurações de cache | `src/cache/`, `src/http-cache.ts`, `nginx/nginx.conf`; Metodologia §1.2 |
| Definir e implementar os cenários de carga | `k6/carga.js`; Metodologia §2 |
| Coletar p50/p95/p99, throughput, CPU/memória, taxa de acerto e acessos ao banco | E1 e E2 em `RESULTADOS.md`; definições na Metodologia §5 |
| Analisar comparativamente os trade-offs | `RESULTADOS.md` (todas as seções) + seção 5 deste guia |

## 2. Estrutura sugerida dos capítulos

### Capítulo "Desenvolvimento" (ou "Implementação")

1. **Visão geral da arquitetura.** Uma API, quatro configurações escolhidas por `CACHE_STRATEGY`; o nginx fica na frente em todas. Use a figura `docs/figs/arquitetura.png`.
2. **Modelo de dados e rotas.** Tabela de rotas da Metodologia §1.1; `Categoria` e `Produto` em `prisma/schema.prisma`; seed determinístico (50 categorias, 10.000 produtos, semente 20263).
3. **Abstração de cache.** A interface `Cache` (`src/cache/types.ts`): `get`, `set`, `delete`, `getVersion`, `bumpVersion`. O serviço de produtos (`src/produtos/service.ts`) usa o padrão *cache-aside* sem saber qual implementação está por trás. Use a figura `docs/figs/cache_aside.png`.
4. **Estratégias.**
   - `memory`: `lru-cache`, 10.000 entradas, TTL 60 s, no processo da API.
   - `redis`: `ioredis`, JSON serializado, `SET … EX 60`; Redis sem persistência, `allkeys-lru`.
   - `http`: `Cache-Control: public, max-age=60` + `ETag` forte (SHA-1 do corpo) + `304` com `If-None-Match`; o nginx guarda as respostas (`proxy_cache`).
5. **Invalidação.** TTL + invalidação por escrita. Na escrita: apaga a chave do produto e incrementa a versão das listagens (todas as páginas ficam inválidas de uma vez, O(1)). No `http` não há invalidação: é o compromisso medido no E3.
6. **Instrumentação.** Contadores internos (`src/metrics.ts`, rota `/internal/metrics`), contagem de operações do Prisma (extensão `$extends`), `pg_stat_statements` no PostgreSQL, `X-Cache-Status` do nginx.
7. **Testes automatizados.** 56 testes (vitest) da API, das estratégias, do cache HTTP, do seed e das regras do runner, e 10 testes das funções estatísticas (Python). Cite como garantia de que as estratégias funcionam antes da medição.

### Capítulo "Metodologia" (complementa a do pré-projeto)

- **Classificação:** a do pré-projeto (aplicada; explicativa e exploratória; quantitativa; experimental).
- **Variáveis independentes:** estratégia (4 níveis) e carga (3 níveis). **Dependentes:** Metodologia §5.
- **Ambiente:** tabela de recursos por contêiner (Metodologia §1.3) + máquina de `run.json` (modelo, CPU, memória, sistema, versão do Docker).
- **Carga:** tabela de proporções; Zipf (s = 1); modelo de taxa de chegada constante (explique *coordinated omission* em uma frase).
- **Protocolo de medição:** os 6 passos da Metodologia §3 (vale um fluxograma).
- **Experimentos E0–E3:** Metodologia §4. Diga quantas medições cada um teve (está no `RESULTADOS.md`).
- **Análise estatística:** Metodologia §6.
- **Ameaças à validade:** Metodologia §7. Coloque no fim do capítulo de resultados ou num item próprio.

### Capítulo "Resultados"

Ordem sugerida (a mesma do `RESULTADOS.md`):

1. **Calibração (E0):** qual taxa foi usada no E1 e por quê.
2. **Latência (E1):** figura 01 (percentis) e figura 02 (leituras × escritas); tabela de latência; testes estatísticos do p95.
3. **Taxa de acerto, banco e recursos (E1):** figuras 04, 05 e 06; tabela correspondente.
4. **Capacidade (E2):** figura 03 e tabela de capacidade (ganho em relação à linha de base).
5. **Consistência (E3):** figura 07 e tabela.
6. **Diagnóstico de deriva:** figura 08 (curto; mostra que a ordem de execução não afetou os resultados).

Para cada figura: o que ela mostra (1 frase) → o número principal → a comparação. Os números estão nas tabelas do `RESULTADOS.md`; não é preciso ler valores no gráfico.

### Capítulo "Discussão"

Responda ao problema de pesquisa carga por carga (seção 5 deste guia), depois:

- compare com os trabalhos da revisão (Ansari et al., 2026; Ferreira, Farina e Florian, 2025; Privalov e Stupina, 2024; Mertz e Nunes, 2020): o que concorda e o que difere, e por quê (ambiente, tecnologia, carga);
- traga o que **não** foi medido e como mudaria o resultado (várias instâncias, rede real, TTL diferente).

### Capítulo "Conclusão" e trabalhos futuros

- Retome o problema e responda em um parágrafo.
- Trabalhos futuros (todos surgem das limitações):
  1. várias instâncias da API (coerência do cache em memória; invalidação distribuída com *pub/sub* do Redis);
  2. invalidação ativa do cache HTTP (*purge* no nginx) ou `stale-while-revalidate`;
  3. análise de sensibilidade do TTL e do expoente Zipf;
  4. rede real entre cliente, API e Redis;
  5. cache no navegador (cliente reaproveitando respostas sem consultar o servidor);
  6. cache em várias camadas (memória + Redis).

## 3. Diferenças em relação ao pré-projeto (explique no texto)

| Pré-projeto | O que foi feito | Justificativa |
|---|---|---|
| Contêineres: API, PostgreSQL e Redis | + **nginx** na frente da API em todas as estratégias | o cache HTTP precisa de um intermediário para ter efeito no servidor; com o nginx em todas, a topologia é idêntica e a comparação continua justa |
| "TTL e invalidação por escrita" | aplicado em `memory` e `redis`; no `http`, só TTL | o protocolo HTTP não avisa intermediários sobre escritas; essa diferença virou um experimento (E3) |
| Métricas previstas | + **capacidade** (E2) e **consistência** (E3) | o throughput a taxa fixa só mostra o que foi pedido; a capacidade mostra o limite. A consistência mede o custo do cache HTTP |
| "Quando pertinente, teste estatístico" | Kruskal-Wallis + Mann-Whitney exato + Holm + delta de Cliff | 5 repetições por grupo não permitem supor normalidade; testes não paramétricos exatos são os adequados |
| Cronograma: experimentos em out–nov | executados em setembro | a parte prática foi concluída antes; out–dez ficam para a redação |

## 4. Glossário rápido (para o texto)

| Termo | Explicação curta |
|---|---|
| *Cache-aside* | a aplicação consulta o cache; se não achar, busca no banco e grava no cache |
| Taxa de acerto (*hit rate*) | fração das leituras respondidas pelo cache |
| TTL | tempo de vida de uma entrada no cache |
| Invalidação por escrita | remover do cache o dado alterado no momento da escrita |
| `ETag` / `304 Not Modified` | identificador da versão da resposta; se o cliente já tem a versão atual, o servidor responde 304 sem corpo |
| `Cache-Control: max-age` | por quanto tempo uma resposta pode ser reutilizada sem consultar o servidor |
| p50 / p95 / p99 | 50%, 95% e 99% das requisições terminaram em até esse tempo |
| Throughput | requisições atendidas por segundo |
| Capacidade | maior taxa que o sistema sustenta dentro dos critérios (p95 < 100 ms, < 1% descartadas, < 1% erros) |
| Modelo aberto / *coordinated omission* | o gerador envia no ritmo definido mesmo se o sistema ficar lento; num modelo fechado, a lentidão reduziria o envio e esconderia o problema |
| Distribuição Zipf | poucos itens concentram a maioria dos acessos (o 1º item é acessado 2× mais que o 2º, 3× mais que o 3º…) |
| Delta de Cliff | tamanho do efeito entre dois grupos, de −1 a 1 (±1 = separação completa) |

## 5. Principais achados

<!-- PREENCHER COM OS NÚMEROS DO RESULTADOS.md APÓS OS EXPERIMENTOS -->

## 6. Perguntas prováveis da banca

**Por que o nginx está em todas as estratégias, se só o cache HTTP usa?**
Para que a única diferença entre as configurações seja o cache. Sem o nginx nas outras, o cache HTTP teria um salto de rede a mais (ou a menos), e a comparação mediria a topologia junto.

**Por que taxa constante, e não número fixo de usuários?**
Com usuários fixos (modelo fechado), quando o sistema fica lento o gerador envia menos, e a lentidão some das medidas (*coordinated omission*). Com taxa constante, as requisições que não puderam sair são contadas como descartadas.

**Por que 5 repetições? Não é pouco?**
É o previsto no pré-projeto e o viável no tempo (cada medição tem 90 s, e o E1 inteiro leva ~1h45). Com 5 × 5, o menor p-valor possível é 0,008, suficiente para detectar diferenças consistentes. Por isso os testes são exatos e não paramétricos, e o tamanho do efeito é informado.

**Por que p95 como métrica principal, e não a média?**
A média esconde a cauda. O usuário percebe as requisições lentas, e o p95/p99 mostram quanto elas demoram. O p50 também é reportado.

**Memória e Redis deram resultados parecidos. O Redis não deveria ser mais lento?**
Aqui o Redis está na mesma máquina, numa rede virtual: a ida e volta custa microssegundos. Em produção, com rede real, a diferença cresce. A vantagem do Redis (compartilhar o cache entre instâncias) não aparece com uma instância só; está nas ameaças à validade e nos trabalhos futuros.

**O cache HTTP ganhou em desempenho. Então é o melhor?**
Ganhou porque o nginx responde sem chegar à API, mas serve dado desatualizado após uma escrita até o TTL expirar (E3). Serve para dados que toleram atraso (catálogo, preços que mudam pouco), não para estoque em tempo real.

**Como garantir que o gerador de carga não foi o gargalo?**
O k6 roda com 2 CPUs dedicadas e seu uso de CPU é medido em toda medição (coluna "CPU k6 (pico)"). Se ficou abaixo de 200%, o k6 tinha folga.

**A máquina esquentando não altera os resultados?**
Pode alterar os valores absolutos. Por isso a ordem das medições é sorteada (nenhuma estratégia fica sempre no fim) e há um diagnóstico de deriva (figura 08). As conclusões são sobre as comparações entre estratégias, não sobre os valores absolutos.

**Alguma medição foi descartada ou refeita?**
Não manualmente. A única regra automática, definida antes dos experimentos, é a confirmação de degrau reprovado no E0/E2. As duas medições ficam registradas.

**Como reproduzir?**
`README.md`, seção "Reprodução completa": um comando por experimento; o banco é restaurado ao mesmo estado (*fingerprint* do seed) antes de cada medição.

## 7. Checklist

- [ ] Inserir as figuras 01–08 com legenda e fonte ("Fonte: elaborado pelo autor").
- [ ] Inserir a figura de arquitetura e a do fluxo *cache-aside*.
- [ ] Citar a máquina e as versões (de `run.json`) no capítulo de metodologia.
- [ ] Explicar as diferenças em relação ao pré-projeto (seção 3).
- [ ] Discutir as ameaças à validade.
- [ ] Referenciar o repositório (link do GitHub) como material complementar.
