"""Figuras de apoio da monografia: arquitetura do experimento e fluxo cache-aside.

Uso: .venv/bin/python scripts/diagramas.py   (gera docs/figs/*.png)
"""
import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAIDA = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "docs", "figs")

TEXTO = "#1f1e1c"
MUTED = "#6b6a66"
BORDA = "#3d3c38"
FUNDO = "#f4f3ef"
CORES = {"none": "#898781", "memory": "#2a78d6", "redis": "#eb6834", "http": "#1baf7a"}

plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "font.size": 9,
    "savefig.dpi": 300,
    "savefig.bbox": "tight",
    "savefig.pad_inches": 0.08,
})


def caixa(ax, x, y, w, h, titulo, sub=None, cor=BORDA, fundo="white", tam=10, estilo="-"):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.02,rounding_size=0.12",
                                linewidth=1.3, edgecolor=cor, facecolor=fundo, linestyle=estilo))
    if sub:
        ax.text(x + w / 2, y + h * 0.64, titulo, ha="center", va="center", fontsize=tam, fontweight="bold", color=TEXTO)
        ax.text(x + w / 2, y + h * 0.30, sub, ha="center", va="center", fontsize=7.5, color=MUTED, linespacing=1.35)
    else:
        ax.text(x + w / 2, y + h / 2, titulo, ha="center", va="center", fontsize=tam, fontweight="bold", color=TEXTO)


def seta(ax, a, b, texto=None, cor=BORDA, estilo="-", dx=0.0, dy=0.12, ha="center", duplo=False, rad=0.0):
    ax.add_patch(FancyArrowPatch(a, b, arrowstyle="<|-|>" if duplo else "-|>", mutation_scale=11, linewidth=1.2,
                                 color=cor, linestyle=estilo, shrinkA=2, shrinkB=2,
                                 connectionstyle=f"arc3,rad={rad}"))
    if texto:
        ax.text((a[0] + b[0]) / 2 + dx, (a[1] + b[1]) / 2 + dy, texto, ha=ha, va="bottom", fontsize=7.5, color=MUTED, linespacing=1.3)


def arquitetura():
    fig, ax = plt.subplots(figsize=(9.2, 4.3))
    ax.set_xlim(0, 11.5)
    ax.set_ylim(0, 5.35)
    ax.axis("off")

    # Rede do Docker Compose
    ax.add_patch(FancyBboxPatch((0.15, 0.15), 11.2, 5.05, boxstyle="round,pad=0.02,rounding_size=0.2",
                                linewidth=1, edgecolor=MUTED, facecolor=FUNDO, linestyle=(0, (4, 3))))
    ax.text(0.4, 4.95, "Rede interna do Docker Compose (limites de CPU e memória por contêiner)", fontsize=8, color=MUTED, va="center")

    caixa(ax, 0.5, 2.1, 1.9, 1.3, "k6", "gerador de carga\n2 CPU · 1 GiB")
    caixa(ax, 3.2, 2.1, 1.9, 1.3, "nginx", "proxy reverso\n+ cache HTTP\n1 CPU · 256 MiB")

    # API com o componente de cache
    ax.add_patch(FancyBboxPatch((5.9, 1.0), 2.7, 3.3, boxstyle="round,pad=0.02,rounding_size=0.12",
                                linewidth=1.3, edgecolor=BORDA, facecolor="white"))
    ax.text(7.25, 4.0, "API REST", ha="center", va="center", fontsize=10, fontweight="bold", color=TEXTO)
    ax.text(7.25, 3.66, "Node.js · Fastify · Prisma\n1 CPU · 512 MiB", ha="center", va="center", fontsize=7.5, color=MUTED, linespacing=1.35)
    caixa(ax, 6.1, 2.3, 2.3, 0.85, "rotas e serviço", "cache-aside e invalidação", tam=8.5)
    caixa(ax, 6.1, 1.2, 2.3, 0.85, "cache em memória", "estratégia memory", cor=CORES["memory"], fundo="#eaf2fc", tam=8.5)

    caixa(ax, 9.4, 3.1, 1.7, 1.15, "Redis", "cache distribuído\n1 CPU · 256 MiB", cor=CORES["redis"], fundo="#fdefe8")
    caixa(ax, 9.4, 0.6, 1.7, 1.3, "PostgreSQL", "10.000 produtos\n2 CPU · 1 GiB")

    seta(ax, (2.4, 2.75), (3.2, 2.75), "HTTP", duplo=True)
    seta(ax, (5.1, 2.75), (5.9, 2.75), "HTTP", duplo=True)
    seta(ax, (8.6, 3.6), (9.4, 3.6), "estratégia\nredis", cor=CORES["redis"], estilo=(0, (4, 2)), duplo=True)
    seta(ax, (8.6, 1.3), (9.4, 1.3), "SQL", duplo=True)

    # Legenda das estratégias
    ax.text(3.2, 1.8, "estratégia http:\no nginx guarda as respostas\n(Cache-Control + ETag)", fontsize=7.5, color=CORES["http"], linespacing=1.35, va="top")
    ax.text(0.5, 0.55, "CACHE_STRATEGY = none | memory | redis | http\n(mesmo código; só muda o componente de cache)",
            fontsize=7.5, color=TEXTO, linespacing=1.35)
    os.makedirs(SAIDA, exist_ok=True)
    fig.savefig(os.path.join(SAIDA, "arquitetura.png"))
    plt.close(fig)


def cache_aside():
    fig, axes = plt.subplots(1, 2, figsize=(9.2, 3.9), gridspec_kw={"width_ratios": [1.1, 1]})
    for ax in axes:
        ax.set_xlim(0, 5)
        ax.set_ylim(-0.1, 5.8)
        ax.axis("off")

    # Leitura
    ax = axes[0]
    ax.set_title("Leitura (GET)", loc="left", fontsize=10, fontweight="bold", color=TEXTO)
    caixa(ax, 1.2, 5.0, 2.6, 0.6, "requisição GET", tam=8.5)
    caixa(ax, 1.2, 3.85, 2.6, 0.7, "busca a chave no cache", tam=8.5, cor=CORES["memory"])
    caixa(ax, 0.1, 2.35, 2.0, 0.8, "acerto", "responde do cache", tam=8.5, cor=CORES["http"], fundo="#e8f7f1")
    caixa(ax, 2.9, 2.35, 2.0, 0.8, "falha", "consulta o banco", tam=8.5, cor=CORES["redis"], fundo="#fdefe8")
    caixa(ax, 2.9, 1.0, 2.0, 0.8, "grava no cache", "com TTL de 60 s", tam=8.5)
    caixa(ax, 1.2, 0.0, 2.6, 0.55, "resposta", tam=8.5)
    seta(ax, (2.5, 5.0), (2.5, 4.55))
    seta(ax, (2.1, 3.85), (1.1, 3.15), "encontrou", dx=-0.25, dy=0.0, ha="right")
    seta(ax, (2.9, 3.85), (3.9, 3.15), "não encontrou", dx=0.25, dy=0.0, ha="left")
    seta(ax, (3.9, 2.35), (3.9, 1.8))
    seta(ax, (1.1, 2.35), (2.1, 0.55))
    seta(ax, (3.9, 1.0), (2.9, 0.55))

    # Escrita
    ax = axes[1]
    ax.set_title("Escrita (POST, PUT, PATCH, DELETE)", loc="left", fontsize=10, fontweight="bold", color=TEXTO)
    caixa(ax, 0.5, 5.0, 4.0, 0.6, "requisição de escrita", tam=8.5)
    caixa(ax, 0.5, 3.85, 4.0, 0.7, "grava no banco", tam=8.5)
    caixa(ax, 0.5, 2.45, 4.0, 0.9, "apaga a chave do produto", "a próxima leitura busca no banco", tam=8.5, cor=CORES["redis"], fundo="#fdefe8")
    caixa(ax, 0.5, 1.0, 4.0, 0.95, "incrementa a versão das listagens", "invalida todas as páginas de uma vez", tam=8.5, cor=CORES["redis"], fundo="#fdefe8")
    caixa(ax, 0.5, 0.0, 4.0, 0.55, "resposta", tam=8.5)
    seta(ax, (2.5, 5.0), (2.5, 4.55))
    seta(ax, (2.5, 3.85), (2.5, 3.35))
    seta(ax, (2.5, 2.45), (2.5, 1.95))
    seta(ax, (2.5, 1.0), (2.5, 0.55))

    fig.text(0.01, 0.0, "Estratégias memory e redis. Na estratégia http não há invalidação: o nginx serve a resposta guardada até o max-age (TTL) expirar.",
             fontsize=7.5, color=MUTED, ha="left", va="top")
    fig.savefig(os.path.join(SAIDA, "cache_aside.png"))
    plt.close(fig)


if __name__ == "__main__":
    arquitetura()
    cache_aside()
    print(f"Figuras em {os.path.relpath(SAIDA, ROOT)}/: arquitetura.png, cache_aside.png")
