// Estratégia "http": Cache-Control, ETag e validação condicional (304).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { etagOf, matchesIfNoneMatch } from "../src/http-cache";
import { closeTestApp, createTestApp, novoProduto, type TestContext } from "./helpers";

describe("matchesIfNoneMatch", () => {
  const etag = etagOf("corpo");
  it("casa ETag igual, lista com vírgulas, prefixo W/ e *", () => {
    expect(matchesIfNoneMatch(etag, etag)).toBe(true);
    expect(matchesIfNoneMatch(`"outro", ${etag}`, etag)).toBe(true);
    expect(matchesIfNoneMatch(`W/${etag}`, etag)).toBe(true);
    expect(matchesIfNoneMatch("*", etag)).toBe(true);
  });
  it("não casa ETag diferente ou ausente", () => {
    expect(matchesIfNoneMatch('"outro"', etag)).toBe(false);
    expect(matchesIfNoneMatch(undefined, etag)).toBe(false);
  });
});

describe("estratégia http", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestApp(undefined, "http");
  });
  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it("GET 200 recebe Cache-Control público com max-age = TTL e ETag", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/produtos/11" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    expect(res.headers["etag"]).toBe(etagOf(res.body));
  });

  it("If-None-Match com o ETag atual → 304 sem corpo (e conta notModified)", async () => {
    await ctx.app.inject({ method: "POST", url: "/internal/reset" });
    const first = await ctx.app.inject({ method: "GET", url: "/produtos/12" });
    const again = await ctx.app.inject({ method: "GET", url: "/produtos/12", headers: { "if-none-match": first.headers["etag"] as string } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
    const m = (await ctx.app.inject({ method: "GET", url: "/internal/metrics" })).json();
    expect(m.notModified).toBe(1);
    // A validação condicional não evita a consulta ao banco na própria API.
    expect(m.dbQueries).toBe(2);
  });

  it("após uma alteração o ETag muda e o cliente recebe o dado novo (200)", async () => {
    const first = await ctx.app.inject({ method: "GET", url: "/produtos/13" });
    await ctx.app.inject({ method: "PUT", url: "/produtos/13", payload: { ...novoProduto, nome: "Alterado" } });
    const again = await ctx.app.inject({ method: "GET", url: "/produtos/13", headers: { "if-none-match": first.headers["etag"] as string } });
    expect(again.statusCode).toBe(200);
    expect(again.json().nome).toBe("Alterado");
  });

  it("escritas, 404 e rotas internas não são cacheáveis", async () => {
    const put = await ctx.app.inject({ method: "PUT", url: "/produtos/14", payload: novoProduto });
    expect(put.headers["cache-control"]).toBe("no-store");
    const missing = await ctx.app.inject({ method: "GET", url: "/produtos/999999" });
    expect(missing.headers["cache-control"]).toBe("no-store");
    const internal = await ctx.app.inject({ method: "GET", url: "/internal/metrics" });
    expect(internal.headers["cache-control"]).toBeUndefined();
  });
});
