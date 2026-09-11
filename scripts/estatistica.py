"""Funções estatísticas da análise (somente biblioteca padrão, Python 3.9+).

Com 5 repetições por condição, os testes são não paramétricos (não supõem
normalidade):
  - Kruskal-Wallis por permutação: há diferença entre as estratégias?
  - Mann-Whitney U exato (bilateral): comparações par a par;
  - ajuste de Holm para múltiplas comparações;
  - delta de Cliff: tamanho do efeito (-1 a 1).
"""

import math
import random
from functools import lru_cache
from statistics import mean, median, stdev


def resumo(valores):
    """Média, desvio padrão amostral, mediana, mínimo, máximo e n."""
    v = [x for x in valores if x is not None and not math.isnan(x)]
    if not v:
        return {"media": float("nan"), "dp": float("nan"), "mediana": float("nan"), "min": float("nan"), "max": float("nan"), "n": 0}
    return {
        "media": mean(v),
        "dp": stdev(v) if len(v) > 1 else 0.0,
        "mediana": median(v),
        "min": min(v),
        "max": max(v),
        "n": len(v),
    }


def _postos(valores):
    """Postos (1..n) com média para empates."""
    ordem = sorted(range(len(valores)), key=lambda i: valores[i])
    postos = [0.0] * len(valores)
    i = 0
    while i < len(ordem):
        j = i
        while j + 1 < len(ordem) and valores[ordem[j + 1]] == valores[ordem[i]]:
            j += 1
        posto = (i + j) / 2 + 1
        for k in range(i, j + 1):
            postos[ordem[k]] = posto
        i = j + 1
    return postos


@lru_cache(maxsize=None)
def _contagem_u(n1, n2, u):
    """Número de arranjos com estatística U = u (sem empates)."""
    if u < 0 or u > n1 * n2:
        return 0
    if n1 == 0 or n2 == 0:
        return 1 if u == 0 else 0
    return _contagem_u(n1 - 1, n2, u - n2) + _contagem_u(n1, n2 - 1, u)


def mann_whitney(x, y):
    """Teste U de Mann-Whitney bilateral.

    Exato quando não há empates e as amostras são pequenas (n ≤ 20);
    senão, aproximação normal com correção para empates e de continuidade.
    Retorna (U de x, p-valor).
    """
    n1, n2 = len(x), len(y)
    if n1 == 0 or n2 == 0:
        return float("nan"), float("nan")
    u = sum(1.0 if a > b else 0.5 if a == b else 0.0 for a in x for b in y)
    combinados = list(x) + list(y)
    empates = len(set(combinados)) < len(combinados)
    if not empates and n1 <= 20 and n2 <= 20:
        total = math.comb(n1 + n2, n1)
        u_int = int(round(u))
        p_baixo = sum(_contagem_u(n1, n2, k) for k in range(0, u_int + 1)) / total
        p_alto = sum(_contagem_u(n1, n2, k) for k in range(u_int, n1 * n2 + 1)) / total
        return u, min(1.0, 2 * min(p_baixo, p_alto))
    # Aproximação normal com correção para empates.
    postos = _postos(combinados)
    n = n1 + n2
    contagens = {}
    for v in combinados:
        contagens[v] = contagens.get(v, 0) + 1
    t = sum(c ** 3 - c for c in contagens.values())
    mu = n1 * n2 / 2
    sigma = math.sqrt(n1 * n2 / 12 * ((n + 1) - t / (n * (n - 1))))
    if sigma == 0:
        return u, 1.0
    z = (abs(u - mu) - 0.5) / sigma
    p = math.erfc(max(z, 0) / math.sqrt(2))
    return u, min(1.0, p)


def kruskal_wallis(grupos, permutacoes=20000, semente=42):
    """Estatística H de Kruskal-Wallis e p-valor por permutação (exato em distribuição).

    `grupos` é uma lista de listas. A permutação evita depender da
    aproximação qui-quadrado, pouco confiável com 5 observações por grupo.
    """
    grupos = [list(g) for g in grupos if len(g) > 0]
    if len(grupos) < 2:
        return float("nan"), float("nan")
    tamanhos = [len(g) for g in grupos]
    todos = [v for g in grupos for v in g]
    n = len(todos)

    def estatistica(valores):
        postos = _postos(valores)
        h, i = 0.0, 0
        for tam in tamanhos:
            soma = sum(postos[i:i + tam])
            h += soma * soma / tam
            i += tam
        return 12 / (n * (n + 1)) * h - 3 * (n + 1)

    h_obs = estatistica(todos)
    rng = random.Random(semente)
    embaralhado = list(todos)
    extremos = 0
    for _ in range(permutacoes):
        rng.shuffle(embaralhado)
        if estatistica(embaralhado) >= h_obs - 1e-12:
            extremos += 1
    return h_obs, (extremos + 1) / (permutacoes + 1)


def holm(p_valores):
    """Ajuste de Holm-Bonferroni (mantém a ordem original)."""
    m = len(p_valores)
    ordem = sorted(range(m), key=lambda i: p_valores[i])
    ajustados = [0.0] * m
    corrente = 0.0
    for rank, i in enumerate(ordem):
        corrente = max(corrente, min(1.0, (m - rank) * p_valores[i]))
        ajustados[i] = corrente
    return ajustados


def delta_cliff(x, y):
    """Delta de Cliff: P(X > Y) - P(X < Y). |d| < 0,147 desprezível; < 0,33 pequeno; < 0,474 médio; senão grande."""
    if not x or not y:
        return float("nan")
    maior = sum(1 for a in x for b in y if a > b)
    menor = sum(1 for a in x for b in y if a < b)
    return (maior - menor) / (len(x) * len(y))


def magnitude_cliff(d):
    a = abs(d)
    if a < 0.147:
        return "desprezível"
    if a < 0.33:
        return "pequeno"
    if a < 0.474:
        return "médio"
    return "grande"
