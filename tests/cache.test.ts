// Testes unitários das implementações de cache e comportamento cache-aside
// do serviço (acerto, erro, invalidação por escrita), para memória e Redis.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryCache } from "../src/cache/memory";
import { RedisCache } from "../src/cache/redis";
import type { Cache } from "../src/cache/types";
import { closeTestApp, createTestApp, novoProduto, type TestContext } from "./helpers";

const REDIS_TEST_URL = "redis://localhost:6380/15";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const factories: Array<[string, () => Promise<Cache>]> = [
  ["memory", async () => new MemoryCache(1000)],
  [
    "redis",
    async () => {
      const c = new RedisCache(REDIS_TEST_URL);
      await c.ping();
      await c.clear();
      return c;
    },
  ],
];

describe.each(factories)("implementação %s", (_name, factory) => {
  let cache: Cache;
  beforeAll(async () => {
    cache = await factory();
  });
  afterAll(async () => {
    await cache.close();
  });

  it("guarda e devolve valores; ausência → undefined", async () => {
    await cache.set("k1", { a: 1, b: [2, 3] }, 60);
    expect(await cache.get("k1")).toEqual({ a: 1, b: [2, 3] });
    expect(await cache.get("nao-existe")).toBeUndefined();
  });

  it("expira pelo TTL", async () => {
    await cache.set("curta", { x: 1 }, 1);
    expect(await cache.get("curta")).toEqual({ x: 1 });
    await sleep(1_100);
    expect(await cache.get("curta")).toBeUndefined();
  });

  it("remove chaves e versiona namespaces", async () => {
    await cache.set("k2", { v: 2 }, 60);
    await cache.delete(["k2"]);
    expect(await cache.get("k2")).toBeUndefined();
    const v0 = await cache.getVersion("ns");
    await cache.bumpVersion("ns");
    expect(await cache.getVersion("ns")).toBe(v0 + 1);
  });

  it("clear esvazia tudo", async () => {
    await cache.set("k3", { v: 3 }, 60);
    await cache.clear();
    expect(await cache.get("k3")).toBeUndefined();
    expect(await cache.getVersion("ns")).toBe(0);
  });
});

describe("MemoryCache — LRU", () => {
  it("descarta a entrada menos usada ao atingir o limite", async () => {
    const c = new MemoryCache(2);
    await c.set("a", { v: 1 }, 60);
    await c.set("b", { v: 2 }, 60);
    await c.get("a"); // "a" passa a ser a mais recente
    await c.set("c", { v: 3 }, 60);
    expect(await c.get("b")).toBeUndefined();
    expect(await c.get("a")).toEqual({ v: 1 });
    expect(c.size).toBe(2);
  });
});

describe.each(factories)("serviço com cache %s (cache-aside)", (name, factory) => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestApp(await factory(), name as "memory" | "redis");
  });
  afterAll(async () => {
    await closeTestApp(ctx);
  });

  const get = (url: string) => ctx.app.inject({ method: "GET", url });
  const metrics = async () => (await ctx.app.inject({ method: "GET", url: "/internal/metrics" })).json();

  it("primeira leitura vai ao banco (miss); a segunda vem do cache (hit)", async () => {
    await ctx.app.inject({ method: "POST", url: "/internal/reset" });
    const a = await get("/produtos/7");
    const b = await get("/produtos/7");
    expect(b.json()).toEqual(a.json());
    const m = await metrics();
    expect(m).toMatchObject({ cacheMisses: 1, cacheHits: 1, dbQueries: 1, cacheHitRate: 0.5 });
  });

  it("listagens também são cacheadas (inclui a contagem total)", async () => {
    await ctx.app.inject({ method: "POST", url: "/internal/reset" });
    await get("/produtos?categoria=5&limite=10");
    await get("/produtos?categoria=5&limite=10");
    expect(await metrics()).toMatchObject({ cacheMisses: 1, cacheHits: 1, dbQueries: 2 });
  });

  it("PUT invalida o produto: a leitura seguinte já traz o dado novo", async () => {
    await get("/produtos/8");
    await ctx.app.inject({ method: "PUT", url: "/produtos/8", payload: { ...novoProduto, nome: "Nome Novo" } });
    expect((await get("/produtos/8")).json().nome).toBe("Nome Novo");
  });

  it("PATCH também invalida o produto", async () => {
    await get("/produtos/15");
    await ctx.app.inject({ method: "PATCH", url: "/produtos/15", payload: { estoque: 321 } });
    expect((await get("/produtos/15")).json().estoque).toBe(321);
  });

  it("escritas invalidam todas as listagens", async () => {
    const antes = (await get("/produtos?categoria=28&limite=100")).json();
    const criado = (await ctx.app.inject({ method: "POST", url: "/produtos", payload: { sku: `CACHE-${name}`, ...novoProduto } })).json();
    const depois = (await get("/produtos?categoria=28&limite=100")).json();
    expect(depois.total).toBe(antes.total + 1);
    await ctx.app.inject({ method: "DELETE", url: `/produtos/${criado.id}` });
    expect((await get("/produtos?categoria=28&limite=100")).json().total).toBe(antes.total);
    expect((await get(`/produtos/${criado.id}`)).statusCode).toBe(404);
  });

  it("/internal/metrics/reset zera as métricas mas mantém o cache aquecido", async () => {
    await get("/produtos/16");
    await ctx.app.inject({ method: "POST", url: "/internal/metrics/reset" });
    await get("/produtos/16");
    expect(await metrics()).toMatchObject({ cacheHits: 1, cacheMisses: 0, dbQueries: 0 });
  });

  it("404 não é armazenado no cache", async () => {
    await ctx.app.inject({ method: "POST", url: "/internal/reset" });
    await get("/produtos/999999");
    await get("/produtos/999999");
    expect(await metrics()).toMatchObject({ cacheHits: 0, cacheMisses: 2 });
  });

  it("respostas não levam cabeçalhos de cache HTTP (no-store)", async () => {
    const res = await get("/produtos/9");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["etag"]).toBeUndefined();
  });
});
