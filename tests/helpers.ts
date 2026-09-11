// Utilitários dos testes de integração: aplicação montada sobre o banco de testes.
import type { FastifyInstance } from "fastify";
import { generateSeedData, resetDatabase } from "../prisma/seed";
import { buildApp } from "../src/app";
import type { Cache } from "../src/cache/types";
import { NoCache } from "../src/cache/types";
import type { CacheStrategy } from "../src/config";
import { createDb, type Db } from "../src/db";
import { Metrics } from "../src/metrics";
import { TEST_DATABASE_URL } from "./setup/global";

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  metrics: Metrics;
  cache: Cache;
}

const seed = generateSeedData();

export async function createTestApp(cache: Cache = new NoCache(), strategy: CacheStrategy = "none"): Promise<TestContext> {
  const metrics = new Metrics();
  const db = createDb(TEST_DATABASE_URL, 4, () => metrics.dbQueries++);
  await resetDatabase(db, seed);
  metrics.reset();
  const app = await buildApp({ db, cache, metrics, strategy, ttlSeconds: 60 });
  return { app, db, metrics, cache };
}

export async function closeTestApp(ctx: TestContext): Promise<void> {
  await ctx.app.close();
  await ctx.cache.close();
  await ctx.db.$disconnect();
}

export const novoProduto = {
  nome: "Cafeteira Expresso Teste",
  descricao: "Produto criado pelos testes.",
  preco: 499.9,
  estoque: 10,
  categoriaId: 28,
};
