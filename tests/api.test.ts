import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestApp, createTestApp, novoProduto, type TestContext } from "./helpers";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await closeTestApp(ctx);
});

describe("GET /produtos/:id", () => {
  it("retorna o produto com a categoria e o preço numérico", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/produtos/1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ id: 1, sku: "SKU-000001", nome: "Chapéu Ergonômico de Concreto" });
    expect(typeof body.preco).toBe("number");
    expect(body.categoria).toEqual({ id: 5, nome: "Monitores", slug: "monitores" });
  });

  it("404 para produto inexistente", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/produtos/999999" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ erro: "Produto não encontrado" });
  });

  it("400 para id inválido", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/produtos/abc" })).statusCode).toBe(400);
  });
});

describe("GET /produtos (listagem)", () => {
  it("pagina com limite padrão de 20 e informa o total de ativos", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/produtos" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dados).toHaveLength(20);
    expect(body.pagina).toBe(1);
    expect(body.limite).toBe(20);
    expect(body.total).toBeGreaterThan(9000);
    expect(body.total).toBeLessThan(10_000); // ~5% dos produtos estão inativos
    expect(body.dados.every((p: { ativo: boolean }) => p.ativo)).toBe(true);
  });

  it("filtra por categoria e respeita página e limite", async () => {
    const p1 = (await ctx.app.inject({ method: "GET", url: "/produtos?categoria=13&limite=5" })).json();
    const p2 = (await ctx.app.inject({ method: "GET", url: "/produtos?categoria=13&limite=5&pagina=2" })).json();
    expect(p1.dados).toHaveLength(5);
    expect(p1.dados.every((p: { categoria: { id: number } }) => p.categoria.id === 13)).toBe(true);
    expect(p2.dados[0].id).toBeGreaterThan(p1.dados[4].id);
    expect(p1.total).toBe(p2.total);
  });

  it("rejeita limite acima de 100", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/produtos?limite=101" })).statusCode).toBe(400);
  });
});

describe("escritas", () => {
  it("POST cria o produto (201) e ele passa a ser consultável", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/produtos", payload: { sku: "TESTE-001", ...novoProduto } });
    expect(res.statusCode).toBe(201);
    const criado = res.json();
    expect(criado.id).toBeGreaterThan(10_000);
    const get = await ctx.app.inject({ method: "GET", url: `/produtos/${criado.id}` });
    expect(get.json()).toMatchObject({ sku: "TESTE-001", preco: 499.9 });
  });

  it("POST com SKU repetido → 409; categoria inexistente → 422; corpo inválido → 400", async () => {
    const dup = await ctx.app.inject({ method: "POST", url: "/produtos", payload: { sku: "SKU-000002", ...novoProduto } });
    expect(dup.statusCode).toBe(409);
    const cat = await ctx.app.inject({ method: "POST", url: "/produtos", payload: { sku: "TESTE-002", ...novoProduto, categoriaId: 999 } });
    expect(cat.statusCode).toBe(422);
    const inval = await ctx.app.inject({ method: "POST", url: "/produtos", payload: { sku: "TESTE-003", ...novoProduto, preco: -1 } });
    expect(inval.statusCode).toBe(400);
  });

  it("PUT atualiza o produto; 404 se não existir", async () => {
    const res = await ctx.app.inject({ method: "PUT", url: "/produtos/2", payload: { ...novoProduto, nome: "Atualizado" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 2, nome: "Atualizado", preco: 499.9 });
    const missing = await ctx.app.inject({ method: "PUT", url: "/produtos/999999", payload: novoProduto });
    expect(missing.statusCode).toBe(404);
  });

  it("DELETE remove (204) e depois responde 404", async () => {
    expect((await ctx.app.inject({ method: "DELETE", url: "/produtos/3" })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: "GET", url: "/produtos/3" })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "DELETE", url: "/produtos/3" })).statusCode).toBe(404);
  });
});

describe("métricas internas", () => {
  it("conta requisições e acessos ao banco e zera no reset", async () => {
    await ctx.app.inject({ method: "POST", url: "/internal/reset" });
    await ctx.app.inject({ method: "GET", url: "/produtos/10" });
    await ctx.app.inject({ method: "GET", url: "/produtos?limite=5" });
    const m = (await ctx.app.inject({ method: "GET", url: "/internal/metrics" })).json();
    expect(m).toMatchObject({ estrategia: "none", requests: 2, cacheHits: 0, cacheMisses: 0, cacheHitRate: null });
    expect(m.dbQueries).toBe(3); // 1 consulta + listagem (itens + contagem)
    await ctx.app.inject({ method: "POST", url: "/internal/reset" });
    expect((await ctx.app.inject({ method: "GET", url: "/internal/metrics" })).json().requests).toBe(0);
  });

  it("rotas internas e /health não contam como requisições", async () => {
    await ctx.app.inject({ method: "POST", url: "/internal/reset" });
    await ctx.app.inject({ method: "GET", url: "/health" });
    expect((await ctx.app.inject({ method: "GET", url: "/internal/metrics" })).json().requests).toBe(0);
  });
});
