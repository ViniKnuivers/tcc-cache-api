// Rotas REST do catálogo de produtos.
//   GET    /produtos?categoria=&pagina=&limite=   listagem paginada (só ativos)
//   GET    /produtos/:id                          consulta
//   POST   /produtos                              criação
//   PUT    /produtos/:id                          atualização completa
//   PATCH  /produtos/:id                          atualização parcial (ex.: preço, estoque)
//   DELETE /produtos/:id                          remoção
// Os JSON Schemas validam a entrada e aceleram a serialização da saída.
import type { FastifyInstance } from "fastify";
import {
  ConflictError,
  InvalidReferenceError,
  NotFoundError,
  type ProdutoInput,
  type ProdutoService,
} from "./service";

const categoriaSchema = {
  type: "object",
  properties: { id: { type: "integer" }, nome: { type: "string" }, slug: { type: "string" } },
} as const;

const produtoSchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    sku: { type: "string" },
    nome: { type: "string" },
    descricao: { type: "string" },
    preco: { type: "number" },
    estoque: { type: "integer" },
    ativo: { type: "boolean" },
    categoria: categoriaSchema,
    criadoEm: { type: "string" },
    atualizadoEm: { type: "string" },
  },
} as const;

const erroSchema = { type: "object", properties: { erro: { type: "string" } } } as const;

const camposEditaveis = {
  nome: { type: "string", minLength: 1, maxLength: 160 },
  descricao: { type: "string", maxLength: 2000 },
  preco: { type: "number", minimum: 0, maximum: 99_999_999.99 },
  estoque: { type: "integer", minimum: 0 },
  ativo: { type: "boolean" },
  categoriaId: { type: "integer", minimum: 1 },
} as const;

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "integer", minimum: 1 } },
} as const;

interface IdParams {
  id: number;
}
interface ListarQuery {
  categoria?: number;
  pagina: number;
  limite: number;
}
type CriarBody = ProdutoInput & { sku: string };

export async function produtoRoutes(app: FastifyInstance, opts: { service: ProdutoService }): Promise<void> {
  const { service } = opts;

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof NotFoundError) return reply.code(404).send({ erro: err.message });
    if (err instanceof ConflictError) return reply.code(409).send({ erro: err.message });
    if (err instanceof InvalidReferenceError) return reply.code(422).send({ erro: err.message });
    if ((err as { validation?: unknown }).validation) return reply.code(400).send({ erro: (err as Error).message });
    app.log.error(err);
    return reply.code(500).send({ erro: "Erro interno" });
  });

  app.get<{ Querystring: ListarQuery }>(
    "/produtos",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            categoria: { type: "integer", minimum: 1 },
            pagina: { type: "integer", minimum: 1, default: 1 },
            limite: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              dados: { type: "array", items: produtoSchema },
              pagina: { type: "integer" },
              limite: { type: "integer" },
              total: { type: "integer" },
            },
          },
        },
      },
    },
    async (req) => service.listar({ categoriaId: req.query.categoria, pagina: req.query.pagina, limite: req.query.limite }),
  );

  app.get<{ Params: IdParams }>(
    "/produtos/:id",
    { schema: { params: idParams, response: { 200: produtoSchema, 404: erroSchema } } },
    async (req) => service.obter(req.params.id),
  );

  app.post<{ Body: CriarBody }>(
    "/produtos",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["sku", "nome", "descricao", "preco", "estoque", "categoriaId"],
          properties: { sku: { type: "string", minLength: 1, maxLength: 20 }, ...camposEditaveis },
        },
        response: { 201: produtoSchema, 409: erroSchema, 422: erroSchema },
      },
    },
    async (req, reply) => {
      const { sku, ...input } = req.body;
      return reply.code(201).send(await service.criar(sku, input));
    },
  );

  app.put<{ Params: IdParams; Body: ProdutoInput }>(
    "/produtos/:id",
    {
      schema: {
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["nome", "descricao", "preco", "estoque", "categoriaId"],
          properties: camposEditaveis,
        },
        response: { 200: produtoSchema, 404: erroSchema, 422: erroSchema },
      },
    },
    async (req) => service.atualizar(req.params.id, req.body),
  );

  app.patch<{ Params: IdParams; Body: Partial<ProdutoInput> }>(
    "/produtos/:id",
    {
      schema: {
        params: idParams,
        body: { type: "object", additionalProperties: false, minProperties: 1, properties: camposEditaveis },
        response: { 200: produtoSchema, 404: erroSchema, 422: erroSchema },
      },
    },
    async (req) => service.atualizarParcial(req.params.id, req.body),
  );

  app.delete<{ Params: IdParams }>(
    "/produtos/:id",
    { schema: { params: idParams, response: { 404: erroSchema } } },
    async (req, reply) => {
      await service.remover(req.params.id);
      return reply.code(204).send();
    },
  );
}
