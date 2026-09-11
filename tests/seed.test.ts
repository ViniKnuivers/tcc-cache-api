import { describe, expect, it } from "vitest";
import { N_PRODUTOS, generateSeedData, seedFingerprint } from "../prisma/seed";

describe("seed sintético", () => {
  it("é determinístico (mesmo conteúdo a cada geração)", () => {
    expect(seedFingerprint(generateSeedData())).toBe(seedFingerprint(generateSeedData()));
  });

  it("tem o fingerprint de referência documentado no README", () => {
    expect(seedFingerprint(generateSeedData())).toBe("239da9743c2035fc");
  });

  it("gera 50 categorias com slugs únicos e 10.000 produtos com SKUs únicos", () => {
    const { categorias, produtos } = generateSeedData();
    expect(categorias).toHaveLength(50);
    expect(new Set(categorias.map((c) => c.slug)).size).toBe(50);
    expect(produtos).toHaveLength(N_PRODUTOS);
    expect(new Set(produtos.map((p) => p.sku)).size).toBe(N_PRODUTOS);
    expect(produtos.every((p) => p.categoriaId >= 1 && p.categoriaId <= 50)).toBe(true);
  });
});
