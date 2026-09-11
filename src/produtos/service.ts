// Regras de acesso aos produtos, com cache-aside para as leituras:
//   leitura: consulta o cache → se não houver, busca no banco e grava no cache;
//   escrita: altera o banco → invalida o produto e todas as listagens.
import type { Cache } from "../cache/types";
import type { Db } from "../db";
import { Prisma } from "../generated/prisma/client";
import type { Metrics } from "../metrics";

export interface ProdutoDTO {
  id: number;
  sku: string;
  nome: string;
  descricao: string;
  preco: number;
  estoque: number;
  ativo: boolean;
  categoria: { id: number; nome: string; slug: string };
  criadoEm: string;
  atualizadoEm: string;
}

export interface PaginaDTO {
  dados: ProdutoDTO[];
  pagina: number;
  limite: number;
  total: number;
}

export interface ProdutoInput {
  nome: string;
  descricao: string;
  preco: number;
  estoque: number;
  ativo?: boolean;
  categoriaId: number;
}

export interface ListarParams {
  categoriaId?: number;
  pagina: number;
  limite: number;
}

/** Erros de negócio mapeados para status HTTP pelas rotas. */
export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class InvalidReferenceError extends Error {}

const LISTAS = "listas";
const produtoKey = (id: number) => `produto:${id}`;

const include = { categoria: { select: { id: true, nome: true, slug: true } } } as const;
type ProdutoComCategoria = Prisma.ProdutoGetPayload<{ include: typeof include }>;

function toDTO(p: ProdutoComCategoria): ProdutoDTO {
  return {
    id: p.id,
    sku: p.sku,
    nome: p.nome,
    descricao: p.descricao,
    preco: p.preco.toNumber(),
    estoque: p.estoque,
    ativo: p.ativo,
    categoria: p.categoria,
    criadoEm: p.criadoEm.toISOString(),
    atualizadoEm: p.atualizadoEm.toISOString(),
  };
}

function mapPrismaError(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2025") throw new NotFoundError("Produto não encontrado");
    if (err.code === "P2002") throw new ConflictError("Já existe um produto com este SKU");
    if (err.code === "P2003") throw new InvalidReferenceError("Categoria inexistente");
  }
  throw err;
}

export class ProdutoService {
  constructor(
    private readonly prisma: Db,
    private readonly cache: Cache,
    private readonly metrics: Metrics,
    private readonly ttlSeconds: number,
  ) {}

  private async cached<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
    const hit = await this.cache.get<T>(key);
    if (hit !== undefined) {
      this.metrics.cacheHits++;
      return hit;
    }
    if (this.cache.name !== "none") this.metrics.cacheMisses++;
    const value = await load();
    // Ausências (404) não são armazenadas: evita cache negativo desatualizado.
    if (value !== null) await this.cache.set(key, value, this.ttlSeconds);
    return value;
  }

  async obter(id: number): Promise<ProdutoDTO> {
    const produto = await this.cached(produtoKey(id), async () => {
      const p = await this.prisma.produto.findUnique({ where: { id }, include });
      return p ? toDTO(p) : null;
    });
    if (!produto) throw new NotFoundError("Produto não encontrado");
    return produto;
  }

  async listar({ categoriaId, pagina, limite }: ListarParams): Promise<PaginaDTO> {
    const versao = await this.cache.getVersion(LISTAS);
    const key = `lista:v${versao}:c${categoriaId ?? "todas"}:p${pagina}:l${limite}`;
    const result = await this.cached(key, async () => {
      const where = { ativo: true, ...(categoriaId !== undefined ? { categoriaId } : {}) };
      const [dados, total] = await Promise.all([
        this.prisma.produto.findMany({ where, include, orderBy: { id: "asc" }, skip: (pagina - 1) * limite, take: limite }),
        this.prisma.produto.count({ where }),
      ]);
      return { dados: dados.map(toDTO), pagina, limite, total };
    });
    return result!;
  }

  async criar(sku: string, input: ProdutoInput): Promise<ProdutoDTO> {
    try {
      const p = await this.prisma.produto.create({ data: { sku, ...input }, include });
      await this.invalidar();
      return toDTO(p);
    } catch (err) {
      mapPrismaError(err);
    }
  }

  async atualizar(id: number, input: ProdutoInput): Promise<ProdutoDTO> {
    try {
      const p = await this.prisma.produto.update({ where: { id }, data: input, include });
      await this.invalidar(id);
      return toDTO(p);
    } catch (err) {
      mapPrismaError(err);
    }
  }

  async remover(id: number): Promise<void> {
    try {
      await this.prisma.produto.delete({ where: { id } });
      await this.invalidar(id);
    } catch (err) {
      mapPrismaError(err);
    }
  }

  /** Invalidação por escrita: o produto alterado e todas as listagens. */
  private async invalidar(id?: number): Promise<void> {
    if (this.cache.name === "none") return;
    if (id !== undefined) {
      await this.cache.delete([produtoKey(id)]);
      this.metrics.cacheInvalidations++;
    }
    await this.cache.bumpVersion(LISTAS);
    this.metrics.cacheInvalidations++;
  }
}
