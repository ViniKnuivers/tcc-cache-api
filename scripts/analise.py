"""Análise dos experimentos: gráficos (PNG), tabelas (CSV/Markdown), testes
estatísticos e o documento docs/RESULTADOS.md.

Uso:
    pnpm analise                                  # rodadas mais recentes de cada tipo
    pnpm analise -- --latencia DIR --capacidade DIR --consistencia DIR --calibracao DIR

Por padrão procura primeiro em results/final/ e depois em results/.
Saída: results/final/figs/*.png, results/final/tabelas/*.csv e docs/RESULTADOS.md.
"""

import argparse
import csv
import glob
import json
import math
import os
import sys
from datetime import datetime, timezone

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.ticker import FuncFormatter  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from estatistica import delta_cliff, holm, kruskal_wallis, magnitude_cliff, mann_whitney, resumo  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULTS = os.path.join(ROOT, "results")
FINAL = os.path.join(RESULTS, "final")

ESTRATEGIAS = ["none", "memory", "redis", "http"]
ROTULO_E = {"none": "Sem cache", "memory": "Memória (LRU)", "redis": "Redis", "http": "HTTP (nginx)"}
CARGAS = ["leitura", "mista", "escrita"]
ROTULO_C = {"leitura": "Leitura (90/10)", "mista": "Mista (50/50)", "escrita": "Escrita (10/90)"}
# Rótulos em duas linhas para os eixos dos gráficos (evita sobreposição).
EIXO_C = {c: r.replace(" (", "\n(") for c, r in ROTULO_C.items()}
EIXO_E = {"none": "Sem cache", "memory": "Memória\n(LRU)", "redis": "Redis", "http": "HTTP\n(nginx)"}
# Linha de base em cinza neutro; estratégias com cache nas cores categóricas validadas.
CORES = {"none": "#898781", "memory": "#2a78d6", "redis": "#eb6834", "http": "#1baf7a"}

SURFACE, INK, INK_2, MUTED, GRID, BASELINE = "#ffffff", "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#c3c2b7"
plt.rcParams.update(
    {
        "font.family": "sans-serif",
        "font.size": 9,
        "axes.titlesize": 10,
        "axes.titleweight": "bold",
        "axes.labelcolor": INK_2,
        "axes.edgecolor": BASELINE,
        "axes.facecolor": SURFACE,
        "figure.facecolor": SURFACE,
        "text.color": INK,
        "xtick.color": INK_2,
        "ytick.color": MUTED,
        "legend.frameon": False,
        "savefig.dpi": 300,
        "savefig.bbox": "tight",
    }
)


# --- Formatação em português ------------------------------------------------------

def br(x, casas=1):
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return "—"
    return f"{x:,.{casas}f}".replace(",", "X").replace(".", ",").replace("X", ".")


def br_p(p):
    if p is None or math.isnan(p):
        return "—"
    return "< 0,001" if p < 0.001 else br(p, 3)


def media_dp(r, casas=1):
    return f"{br(r['media'], casas)} ± {br(r['dp'], casas)}"


# --- Leitura dos dados -------------------------------------------------------------

def ultima(tipo):
    for base in (FINAL, RESULTS):
        dirs = sorted(d for d in glob.glob(os.path.join(base, f"{tipo}-*")) if os.path.isdir(d))
        if dirs:
            return dirs[-1]
    return None


def ler_medicoes(diretorio):
    with open(os.path.join(diretorio, "medicoes.csv"), newline="", encoding="utf-8") as f:
        linhas = list(csv.DictReader(f))
    for linha in linhas:
        for k, v in list(linha.items()):
            if k in ("experimento", "estrategia", "carga", "timestamp"):
                continue
            linha[k] = float(v) if v not in ("", None) else float("nan")
    return linhas


def ler_json(caminho):
    with open(caminho, encoding="utf-8") as f:
        return json.load(f)


def valores(linhas, estrategia, carga, metrica):
    return [r[metrica] for r in linhas if r["estrategia"] == estrategia and r["carga"] == carga and not math.isnan(r[metrica])]


def sql_por_req(r):
    return r["sql_total"] / r["requisicoes"] if r["requisicoes"] else float("nan")


# --- Gráficos ------------------------------------------------------------------------

def estilo(ax, ylabel, log=False):
    if log:
        ax.set_yscale("log")
    ax.set_ylabel(ylabel)
    ax.grid(axis="y", color=GRID, linewidth=0.6, which="major")
    ax.set_axisbelow(True)
    for lado in ("top", "right", "left"):
        ax.spines[lado].set_visible(False)
    ax.tick_params(length=0)


def barras(ax, grupos, rotulos_grupo, series, getter, rotulo_serie, cores, casas=1, sufixo="", rotulos=True):
    """Barras agrupadas: altura = mediana das repetições; traços = mínimo e máximo.

    Latência de cauda é assimétrica: média ± desvio padrão pode "passar de zero"
    e exagerar a dispersão. Mediana com mínimo–máximo mostra os dados reais.
    """
    largura = min(0.8 / max(len(series), 1), 0.2)
    for i, s in enumerate(series):
        xs, ys, baixo, alto = [], [], [], []
        for g_idx, g in enumerate(grupos):
            r = getter(s, g)
            if r is None or r["n"] == 0:
                continue
            xs.append(g_idx - largura * len(series) / 2 + largura * (i + 0.5))
            ys.append(r["mediana"])
            baixo.append(r["mediana"] - r["min"])
            alto.append(r["max"] - r["mediana"])
        ax.bar(xs, ys, width=largura - 0.02, color=cores[s], label=rotulo_serie[s], zorder=2)
        ax.errorbar(xs, ys, yerr=[baixo, alto], fmt="none", ecolor=INK_2, elinewidth=0.7, capsize=2, zorder=3)
        if rotulos:
            for x, y, e in zip(xs, ys, alto):
                ax.text(x, y + e, br(y, casas) + sufixo, ha="center", va="bottom", fontsize=6.5, color=INK)
    ax.set_xticks(range(len(grupos)))
    ax.set_xticklabels([rotulos_grupo[g] for g in grupos])


def legenda(fig, axes):
    h, l = axes[0].get_legend_handles_labels()
    fig.legend(h, l, loc="upper center", ncol=len(l), bbox_to_anchor=(0.5, 0.0), fontsize=8)


def nota(fig, texto, y=-0.1):
    fig.text(0.01, y, texto, fontsize=7, color=MUTED, ha="left", va="top")


def salvar(fig, figs, nome):
    caminho = os.path.join(figs, nome)
    fig.savefig(caminho)
    plt.close(fig)
    return caminho


def reps_txt(n):
    return f"{n} repetição" if n == 1 else f"{n} repetições"


def descricao(cfg):
    return (f"Barras: mediana de {reps_txt(cfg['repeticoes'])}; traços: mínimo e máximo. {br(cfg['taxas'][0], 0)} req/s, "
            f"{cfg['duracaoS']} s de medição após {cfg['aquecimentoS']} s de aquecimento.")


def fig_latencia(lat, figs, cfg):
    fig, axes = plt.subplots(1, 3, figsize=(10, 3.6), sharey=False)
    for ax, (met, titulo) in zip(axes, [("lat_p50", "p50"), ("lat_p95", "p95"), ("lat_p99", "p99")]):
        get = lambda s, c: resumo(valores(lat, s, c, met))  # noqa: E731
        todos = [get(s, c)["media"] for s in ESTRATEGIAS for c in CARGAS if get(s, c)["n"]]
        log = bool(todos) and max(todos) / max(min(todos), 1e-3) > 40
        barras(ax, CARGAS, EIXO_C, ESTRATEGIAS, get, ROTULO_E, CORES, casas=1, rotulos=False)
        estilo(ax, "Latência (ms)" + (" — escala log" if log else ""), log)
        ax.set_title(f"Latência {titulo}", loc="left")
    legenda(fig, axes)
    nota(fig, descricao(cfg) + " Valores numéricos nas tabelas.", y=-0.1)
    return salvar(fig, figs, "01_latencia_percentis.png")


def fig_leitura_escrita(lat, figs, cfg):
    fig, axes = plt.subplots(1, 2, figsize=(9, 3.4))
    for ax, (met, titulo) in zip(axes, [("leitura_p95", "p95 das leituras"), ("escrita_p95", "p95 das escritas")]):
        get = lambda s, c: resumo(valores(lat, s, c, met))  # noqa: E731
        barras(ax, CARGAS, EIXO_C, ESTRATEGIAS, get, ROTULO_E, CORES, casas=1, rotulos=False)
        estilo(ax, "Latência (ms)")
        ax.set_title(titulo, loc="left")
    legenda(fig, axes)
    nota(fig, "Leituras: GET de produto e de listagem. Escritas: PATCH, POST e DELETE. " + descricao(cfg), y=-0.11)
    return salvar(fig, figs, "02_latencia_leitura_escrita.png")


def fig_capacidade(caps, figs, maior_degrau, reps):
    fig, ax = plt.subplots(figsize=(8, 3.6))
    get = lambda s, c: resumo(caps.get((s, c), []))  # noqa: E731
    barras(ax, CARGAS, EIXO_C, ESTRATEGIAS, get, ROTULO_E, CORES, casas=0)
    estilo(ax, "Maior taxa sustentável (req/s)")
    ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _p: br(v, 0)))
    ax.set_title("Capacidade: maior throughput sustentável", loc="left")
    ax.legend(loc="upper right", fontsize=8)
    nota(fig, f"Sustentável: p95 < 100 ms, < 1% descartadas e < 1% de erros. Degraus até {br(maior_degrau, 0)} req/s. Barras: mediana de {reps_txt(reps)}; traços: mínimo e máximo.", y=-0.06)
    return salvar(fig, figs, "03_capacidade.png")


def fig_acerto(lat, figs):
    fig, ax = plt.subplots(figsize=(8, 3.4))
    series = [s for s in ESTRATEGIAS if s != "none"]
    get = lambda s, c: resumo([100 * v for v in valores(lat, s, c, "taxa_acerto_cache")])  # noqa: E731
    barras(ax, CARGAS, EIXO_C, series, get, ROTULO_E, CORES, casas=1, sufixo="%")
    estilo(ax, "Taxa de acerto (%)")
    ax.set_ylim(0, 105)
    ax.set_title("Taxa de acerto do cache nas leituras", loc="left")
    ax.legend(loc="upper right", fontsize=8)
    nota(fig, "Memória e Redis: acertos na aplicação. HTTP: acertos do nginx (X-Cache-Status = HIT). Mediana (mín.–máx.) das repetições.", y=-0.06)
    return salvar(fig, figs, "04_taxa_acerto.png")


def fig_banco(lat, figs):
    fig, ax = plt.subplots(figsize=(8, 3.4))
    get = lambda s, c: resumo([sql_por_req(r) for r in lat if r["estrategia"] == s and r["carga"] == c])  # noqa: E731
    barras(ax, CARGAS, EIXO_C, ESTRATEGIAS, get, ROTULO_E, CORES, casas=2)
    estilo(ax, "Comandos SQL por requisição")
    ax.set_title("Acessos ao banco de dados", loc="left")
    ax.legend(loc="upper left", fontsize=8)
    nota(fig, "Comandos SQL executados no PostgreSQL (pg_stat_statements) ÷ requisições atendidas. Mediana (mín.–máx.) das repetições.", y=-0.06)
    return salvar(fig, figs, "05_acessos_banco.png")


def fig_recursos(lat, figs):
    fig, axes = plt.subplots(1, 2, figsize=(9, 3.4))
    for ax, (met, titulo, unidade, casas) in zip(
        axes,
        [("api_cpu_media", "CPU média da API", "CPU (% de 1 núcleo)", 0), ("api_mem_media_mib", "Memória média da API", "Memória (MiB)", 0)],
    ):
        get = lambda s, c, m=met: resumo(valores(lat, s, c, m))  # noqa: E731
        barras(ax, CARGAS, EIXO_C, ESTRATEGIAS, get, ROTULO_E, CORES, casas=casas, rotulos=False)
        estilo(ax, unidade)
        ax.set_title(titulo, loc="left")
    legenda(fig, axes)
    nota(fig, "Amostras do docker stats (~1/s) durante a medição. A API tem limite de 1 CPU e 512 MiB. Mediana (mín.–máx.) das repetições.", y=-0.11)
    return salvar(fig, figs, "06_recursos_api.png")


def fig_consistencia(cons, figs):
    fig, axes = plt.subplots(1, 2, figsize=(9, 3.2))
    por = {r["estrategia"]: r for r in cons}
    ests = [e for e in ESTRATEGIAS if e in por]
    xs = range(len(ests))
    axes[0].bar(xs, [por[e]["pctDesatualizadas"] for e in ests], color=[CORES[e] for e in ests], width=0.55, zorder=2)
    for x, e in zip(xs, ests):
        axes[0].text(x, por[e]["pctDesatualizadas"], br(por[e]["pctDesatualizadas"], 0) + "%", ha="center", va="bottom", fontsize=8)
    estilo(axes[0], "Leituras desatualizadas (%)")
    axes[0].set_ylim(0, 110)
    axes[0].set_title("Leitura logo após a escrita", loc="left")
    axes[1].bar(xs, [por[e]["janelaMaxS"] for e in ests], color=[CORES[e] for e in ests], width=0.55, zorder=2)
    for x, e in zip(xs, ests):
        axes[1].text(x, por[e]["janelaMaxS"], br(por[e]["janelaMaxS"], 1) + " s", ha="center", va="bottom", fontsize=8)
    estilo(axes[1], "Segundos")
    axes[1].set_title("Janela máxima de inconsistência", loc="left")
    for ax in axes:
        ax.set_xticks(list(xs))
        ax.set_xticklabels([EIXO_E[e] for e in ests])
    n, ttl = cons[0]["n"], cons[0]["ttlS"]
    nota(fig, f"{n} produtos por estratégia; TTL = {ttl} s; escrita logo após o item entrar no cache (pior caso).", y=-0.08)
    return salvar(fig, figs, "07_consistencia.png")


def fig_deriva(lat, figs):
    fig, ax = plt.subplots(figsize=(8, 3.2))
    for c, marker in zip(CARGAS, ["o", "s", "^"]):
        pts = sorted((r["ordem"], r["lat_p95"]) for r in lat if r["estrategia"] == "none" and r["carga"] == c)
        if pts:
            ax.plot([p[0] for p in pts], [p[1] for p in pts], marker=marker, linestyle="-", linewidth=0.8, markersize=4, label=ROTULO_C[c], color=INK_2 if c == "leitura" else MUTED if c == "mista" else BASELINE)
    estilo(ax, "p95 sem cache (ms)")
    ax.set_xlabel("Ordem de execução da medição")
    ax.set_title("Diagnóstico de deriva: linha de base ao longo do experimento", loc="left")
    ax.legend(fontsize=8)
    nota(fig, "Se a máquina perdesse desempenho com o tempo (ex.: aquecimento), o p95 subiria com a ordem de execução.", y=-0.12)
    return salvar(fig, figs, "08_deriva.png")


# --- Estatística --------------------------------------------------------------------

def spearman(x, y):
    def postos(v):
        ordem = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        for pos, i in enumerate(ordem):
            r[i] = pos + 1
        return r
    if len(x) < 3:
        return float("nan")
    rx, ry = postos(x), postos(y)
    mx, my = sum(rx) / len(rx), sum(ry) / len(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    return num / den if den else float("nan")


def testes(lat, metricas):
    """Kruskal-Wallis por carga e Mann-Whitney par a par (Holm por carga × métrica)."""
    linhas = []
    for met in metricas:
        for c in CARGAS:
            grupos = {s: valores(lat, s, c, met) for s in ESTRATEGIAS}
            if any(len(v) == 0 for v in grupos.values()):
                continue
            h, p_kw = kruskal_wallis(list(grupos.values()))
            pares = [(a, b) for i, a in enumerate(ESTRATEGIAS) for b in ESTRATEGIAS[i + 1:]]
            brutos = []
            for a, b in pares:
                _, p = mann_whitney(grupos[a], grupos[b])
                brutos.append(p)
            ajustados = holm(brutos)
            for (a, b), p, p_adj in zip(pares, brutos, ajustados):
                ma, mb = resumo(grupos[a])["mediana"], resumo(grupos[b])["mediana"]
                d = delta_cliff(grupos[b], grupos[a])
                linhas.append({
                    "metrica": met, "carga": c, "kw_h": h, "kw_p": p_kw, "a": a, "b": b,
                    "mediana_a": ma, "mediana_b": mb, "razao_b_a": mb / ma if ma else float("nan"),
                    "cliff_b_vs_a": d, "magnitude": magnitude_cliff(d), "p": p, "p_holm": p_adj,
                })
    return linhas


def escrever_csv(caminho, linhas, colunas):
    with open(caminho, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(colunas)
        for linha in linhas:
            w.writerow([linha.get(c, "") for c in colunas])


def tabela_md(cabecalho, linhas):
    out = ["| " + " | ".join(cabecalho) + " |", "|" + "|".join(["---"] * len(cabecalho)) + "|"]
    out += ["| " + " | ".join(str(c) for c in linha) + " |" for linha in linhas]
    return "\n".join(out)


# --- Principal ----------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Análise dos experimentos de cache.")
    ap.add_argument("--latencia")
    ap.add_argument("--capacidade")
    ap.add_argument("--consistencia")
    ap.add_argument("--calibracao")
    ap.add_argument("--saida", default=FINAL)
    ap.add_argument("--doc", default=os.path.join(ROOT, "docs", "RESULTADOS.md"))
    args = ap.parse_args([a for a in sys.argv[1:] if a != "--"])

    dirs = {
        "latencia": args.latencia or ultima("latencia"),
        "capacidade": args.capacidade or ultima("capacidade"),
        "consistencia": args.consistencia or ultima("consistencia"),
        "calibracao": args.calibracao or ultima("calibracao"),
    }
    if not dirs["latencia"]:
        sys.exit("Nenhuma rodada de latência encontrada (rode pnpm experimento latencia).")

    figs = os.path.join(args.saida, "figs")
    tabelas = os.path.join(args.saida, "tabelas")
    os.makedirs(figs, exist_ok=True)
    os.makedirs(tabelas, exist_ok=True)

    lat = ler_medicoes(dirs["latencia"])
    meta_lat = ler_json(os.path.join(dirs["latencia"], "run.json"))
    taxa = meta_lat["config"]["taxas"][0]
    saidas = [fig_latencia(lat, figs, meta_lat["config"]), fig_leitura_escrita(lat, figs, meta_lat["config"]), fig_acerto(lat, figs), fig_banco(lat, figs), fig_recursos(lat, figs), fig_deriva(lat, figs)]

    md = []
    md.append("# Resultados dos experimentos\n")
    md.append(f"> Gerado automaticamente por `pnpm analise` em {datetime.now(timezone.utc).strftime('%d/%m/%Y %H:%M')} UTC, a partir dos dados em `results/`. Não edite à mão: rode a análise de novo.\n")
    maq = meta_lat.get("maquina", {})
    cfg = meta_lat["config"]
    md.append("## Ambiente e parâmetros\n")
    md.append(tabela_md(["Item", "Valor"], [
        ["Máquina", f"{maq.get('cpu', '?')}, {maq.get('nucleos', '?')} núcleos, {br(maq.get('memoriaGiB', float('nan')), 0)} GiB ({maq.get('plataforma', '?')})"],
        ["Docker", f"{maq.get('docker', {}).get('versao', '?')} — VM com {maq.get('docker', {}).get('cpusVm', '?')} CPUs e {br(maq.get('docker', {}).get('memoriaVmGiB', float('nan')), 1)} GiB"],
        ["Recursos", "API 1 CPU / 512 MiB · PostgreSQL 2 CPUs / 1 GiB · Redis 1 CPU / 256 MiB · nginx 1 CPU / 256 MiB · k6 2 CPUs / 512 MiB"],
        ["Taxa (experimento de latência)", f"{br(taxa, 0)} req/s (taxa de chegada constante)"],
        ["Aquecimento / medição", f"{cfg['aquecimentoS']} s / {cfg['duracaoS']} s"],
        ["Repetições", f"{cfg['repeticoes']} por combinação (ordem sorteada em cada repetição)"],
        ["TTL do cache", f"{cfg['ttlS']} s"],
        ["Commit", meta_lat.get("git", {}).get("commit", "?")[:10]],
    ]) + "\n")

    # --- E1: latência -----------------------------------------------------------
    linhas_t1 = []
    for c in CARGAS:
        for s in ESTRATEGIAS:
            linhas_t1.append({"carga": c, "estrategia": s, **{m: resumo(valores(lat, s, c, m)) for m in ["lat_p50", "lat_p95", "lat_p99", "leitura_p95", "escrita_p95", "throughput", "taxa_erros"]}})
    escrever_csv(os.path.join(tabelas, "latencia.csv"),
                 [{"carga": r["carga"], "estrategia": r["estrategia"], **{f"{m}_{k}": r[m][k] for m in ["lat_p50", "lat_p95", "lat_p99", "leitura_p95", "escrita_p95", "throughput"] for k in ("media", "dp", "mediana")}} for r in linhas_t1],
                 ["carga", "estrategia"] + [f"{m}_{k}" for m in ["lat_p50", "lat_p95", "lat_p99", "leitura_p95", "escrita_p95", "throughput"] for k in ("media", "dp", "mediana")])
    md.append("## E1 — Latência\n")
    md.append(f"![Latência por percentil](../results/final/figs/01_latencia_percentis.png)\n")
    md.append(tabela_md(["Carga", "Estratégia", "p50 (ms)", "p95 (ms)", "p95 mediana", "p99 (ms)", "p95 leituras", "p95 escritas", "Erros"],
                        [[ROTULO_C[r["carga"]], ROTULO_E[r["estrategia"]], media_dp(r["lat_p50"], 2), media_dp(r["lat_p95"], 2), br(r["lat_p95"]["mediana"], 2), media_dp(r["lat_p99"], 1), media_dp(r["leitura_p95"], 2), media_dp(r["escrita_p95"], 2), br(100 * r["taxa_erros"]["media"], 2) + "%"] for r in linhas_t1]) + "\n")
    md.append("Valores: média ± desvio padrão das repetições (e mediana do p95). Os gráficos mostram a mediana com mínimo e máximo, porque a latência de cauda é assimétrica.\n")
    md.append("![Latência de leituras e escritas](../results/final/figs/02_latencia_leitura_escrita.png)\n")

    # Testes estatísticos
    tst = testes(lat, ["lat_p95", "lat_p99", "lat_p50"])
    escrever_csv(os.path.join(tabelas, "testes_estatisticos.csv"), tst, ["metrica", "carga", "kw_h", "kw_p", "a", "b", "mediana_a", "mediana_b", "razao_b_a", "cliff_b_vs_a", "magnitude", "p", "p_holm"])
    md.append("### Testes estatísticos (p95)\n")
    md.append("Kruskal-Wallis (permutação, 20.000 reamostragens) entre as 4 estratégias e Mann-Whitney exato par a par, com ajuste de Holm por carga. Razão = mediana de B ÷ mediana de A (< 1: B mais rápida). Delta de Cliff: tamanho do efeito de B em relação a A.\n")
    linhas_t = []
    for t in [t for t in tst if t["metrica"] == "lat_p95"]:
        linhas_t.append([ROTULO_C[t["carga"]], br_p(t["kw_p"]), f"{ROTULO_E[t['a']]} × {ROTULO_E[t['b']]}", br(t["razao_b_a"], 2), f"{br(t['cliff_b_vs_a'], 2)} ({t['magnitude']})", br_p(t["p_holm"])])
    md.append(tabela_md(["Carga", "p (Kruskal-Wallis)", "A × B", "Razão B/A", "Delta de Cliff", "p (Holm)"], linhas_t) + "\n")
    n_rep = meta_lat["config"]["repeticoes"]
    md.append(f"Com {reps_txt(n_rep)} por grupo, o menor p-valor possível no Mann-Whitney exato é {br(2 / math.comb(2 * n_rep, n_rep), 3)} (antes do ajuste); diferenças com separação completa entre os grupos são o máximo detectável.\n")

    # Acertos, banco e recursos
    md.append("### Taxa de acerto, acessos ao banco e recursos\n")
    md.append("![Taxa de acerto](../results/final/figs/04_taxa_acerto.png)\n")
    md.append("![Acessos ao banco](../results/final/figs/05_acessos_banco.png)\n")
    md.append("![Recursos da API](../results/final/figs/06_recursos_api.png)\n")
    linhas_r = []
    csv_r = []
    for c in CARGAS:
        base_sql = resumo([sql_por_req(r) for r in lat if r["estrategia"] == "none" and r["carga"] == c])["media"]
        for s in ESTRATEGIAS:
            acerto = resumo([100 * v for v in valores(lat, s, c, "taxa_acerto_cache")])
            sqlr = resumo([sql_por_req(r) for r in lat if r["estrategia"] == s and r["carga"] == c])
            cpu, mem = resumo(valores(lat, s, c, "api_cpu_media")), resumo(valores(lat, s, c, "api_mem_media_mib"))
            pg, rd, ng, k6 = (resumo(valores(lat, s, c, m)) for m in ["pg_cpu_media", "redis_cpu_media", "nginx_cpu_media", "k6_cpu_max"])
            reducao = (1 - sqlr["media"] / base_sql) * 100 if base_sql else float("nan")
            linhas_r.append([ROTULO_C[c], ROTULO_E[s], "—" if s == "none" else media_dp(acerto, 1) + "%", media_dp(sqlr, 2), "—" if s == "none" else br(reducao, 0) + "%", media_dp(cpu, 0) + "%", media_dp(mem, 0), br(pg["media"], 0) + "%", br(rd["media"], 0) + "%", br(ng["media"], 0) + "%", br(k6["media"], 0) + "%"])
            csv_r.append({"carga": c, "estrategia": s, "acerto_pct": acerto["media"], "sql_por_req": sqlr["media"], "reducao_sql_pct": reducao, "api_cpu": cpu["media"], "api_mem_mib": mem["media"], "pg_cpu": pg["media"], "redis_cpu": rd["media"], "nginx_cpu": ng["media"], "k6_cpu_max": k6["media"]})
    escrever_csv(os.path.join(tabelas, "acerto_banco_recursos.csv"), csv_r, list(csv_r[0].keys()))
    md.append(tabela_md(["Carga", "Estratégia", "Acerto", "SQL/req", "Redução SQL", "CPU API", "Mem. API (MiB)", "CPU PG", "CPU Redis", "CPU nginx", "CPU k6 (pico)"], linhas_r) + "\n")
    md.append("CPU em % de um núcleo (100% = 1 CPU). O pico de CPU do k6 abaixo de 200% (limite do contêiner) indica que o gerador de carga não foi o gargalo.\n")

    # --- E2: capacidade ---------------------------------------------------------
    if dirs["capacidade"]:
        cap = ler_medicoes(dirs["capacidade"])
        meta_cap = ler_json(os.path.join(dirs["capacidade"], "run.json"))
        maior = max(meta_cap["config"]["taxas"])
        grupos = {}
        for r in cap:
            grupos.setdefault((r["estrategia"], r["carga"], r["repeticao"]), []).append(r)
        caps = {}
        for (s, c, _rep), rs in grupos.items():
            ok = [r["taxa"] for r in rs if r["sustentavel"] == 1]
            caps.setdefault((s, c), []).append(max(ok) if ok else 0)
        saidas.append(fig_capacidade(caps, figs, maior, meta_cap["config"]["repeticoes"]))
        md.append("## E2 — Capacidade (throughput máximo sustentável)\n")
        md.append("![Capacidade](../results/final/figs/03_capacidade.png)\n")
        linhas_c, csv_c = [], []
        for c in CARGAS:
            base = resumo(caps.get(("none", c), []))["media"]
            for s in ESTRATEGIAS:
                v = caps.get((s, c), [])
                r = resumo(v)
                teto = " (atingiu o maior degrau)" if v and max(v) >= maior else ""
                linhas_c.append([ROTULO_C[c], ROTULO_E[s], media_dp(r, 0) + teto, ", ".join(br(x, 0) for x in v), "—" if s == "none" or not base else br(r["media"] / base, 2) + "×"])
                csv_c.append({"carga": c, "estrategia": s, "capacidade_media": r["media"], "capacidade_dp": r["dp"], "valores": ";".join(str(int(x)) for x in v), "ganho_vs_none": (r["media"] / base) if base else ""})
        escrever_csv(os.path.join(tabelas, "capacidade.csv"), csv_c, list(csv_c[0].keys()))
        md.append(tabela_md(["Carga", "Estratégia", "Capacidade (req/s)", "Repetições", "Ganho vs. sem cache"], linhas_c) + "\n")
        md.append(f"Degraus testados: {', '.join(br(t, 0) for t in sorted(meta_cap['config']['taxas']))} req/s. A capacidade é o maior degrau sustentável, então a resolução é a distância entre degraus. Com {reps_txt(meta_cap['config']['repeticoes'])}, os valores são descritivos (sem teste de significância).\n")

    # --- E3: consistência -------------------------------------------------------
    if dirs["consistencia"]:
        cons = ler_json(os.path.join(dirs["consistencia"], "resultado.json"))
        saidas.append(fig_consistencia(cons, figs))
        escrever_csv(os.path.join(tabelas, "consistencia.csv"), cons, ["estrategia", "n", "ttlS", "desatualizadasImediatas", "pctDesatualizadas", "janelaMediaS", "janelaMaxS", "naoConvergiram"])
        md.append("## E3 — Consistência após escrita\n")
        md.append("![Consistência](../results/final/figs/07_consistencia.png)\n")
        md.append(tabela_md(["Estratégia", "Leituras desatualizadas logo após a escrita", "Janela média (s)", "Janela máxima (s)"],
                            [[ROTULO_E[r["estrategia"]], f"{r['desatualizadasImediatas']}/{r['n']} ({br(r['pctDesatualizadas'], 0)}%)", br(r["janelaMediaS"], 1), br(r["janelaMaxS"], 1)] for r in cons]) + "\n")
        md.append("Memória e Redis invalidam a entrada na escrita (consistência imediata numa instância única da API). O cache HTTP do nginx não é invalidado pela escrita: o dado antigo é servido até o `max-age` (TTL) expirar. A medição representa o pior caso (escrita logo após o item entrar no cache); com idades de entrada distribuídas uniformemente, a janela esperada seria cerca de TTL/2.\n")

    # --- Calibração e diagnóstico -----------------------------------------------
    if dirs["calibracao"]:
        cal = ler_medicoes(dirs["calibracao"])
        md.append("## E0 — Calibração da taxa\n")
        md.append(tabela_md(["Carga", "Taxa (req/s)", "p95 (ms)", "Descartadas", "Sustentável"],
                            [[ROTULO_C[r["carga"]], br(r["taxa"], 0), br(r["lat_p95"], 1), br(r["descartadas"], 0), "sim" if r["sustentavel"] == 1 else "não"] for r in sorted(cal, key=lambda r: (CARGAS.index(r["carga"]), r["taxa"]))]) + "\n")
        md.append(f"Taxa escolhida para o experimento de latência: {br(taxa, 0)} req/s (≈60% da menor capacidade sustentável da linha de base).\n")

    md.append("## Diagnóstico de deriva\n")
    md.append("![Deriva](../results/final/figs/08_deriva.png)\n")
    rhos = []
    for c in CARGAS:
        pts = [(r["ordem"], r["lat_p95"]) for r in lat if r["estrategia"] == "none" and r["carga"] == c]
        rhos.append([ROTULO_C[c], br(spearman([p[0] for p in pts], [p[1] for p in pts]), 2), str(len(pts))])
    md.append(tabela_md(["Carga", "ρ de Spearman (ordem × p95 sem cache)", "n"], rhos) + "\n")
    md.append("Valores de ρ próximos de 0 indicam que o desempenho da máquina não variou sistematicamente ao longo do experimento. A ordem sorteada das combinações protege a comparação entre estratégias mesmo que haja alguma deriva.\n")

    md.append("## Arquivos\n")
    md.append("\n".join(f"- `{os.path.relpath(p, ROOT)}`" for p in saidas + sorted(glob.glob(os.path.join(tabelas, '*.csv')))) + "\n")
    md.append("\nDados de origem: " + ", ".join(f"`{os.path.relpath(d, ROOT)}`" for d in dirs.values() if d) + "\n")

    os.makedirs(os.path.dirname(args.doc), exist_ok=True)
    with open(args.doc, "w", encoding="utf-8") as f:
        f.write("\n".join(md))
    print("Análise concluída:")
    for p in saidas:
        print(f"  ✓ {os.path.relpath(p, ROOT)}")
    print(f"  ✓ {os.path.relpath(args.doc, ROOT)}")


if __name__ == "__main__":
    main()
