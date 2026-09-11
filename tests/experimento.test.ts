// Testes unitários das regras do runner: janela de amostragem de recursos,
// critério de sustentabilidade, confirmação de degraus e cálculo da capacidade.
import { describe, expect, it } from "vitest";
import { resumirAmostras, type Amostra } from "../src/experimento/ambiente";
import type { K6Resultado } from "../src/experimento/k6";
import { capacidades, chaveDe, sustentavel, type Medicao } from "../src/experimento/runner";

describe("resumirAmostras", () => {
  // Uma amostra por segundo: 5 s de inicialização do k6 (CPU 200%) e depois 10 s de cenário (CPU 50%).
  const amostras: Amostra[] = Array.from({ length: 16 }, (_, i) => ({
    t: 1000 * i,
    cpu: i <= 5 ? 200 : 50,
    mem: i <= 5 ? 10 : 20,
  }));

  it("sem janela, descarta só a primeira amostra", () => {
    const r = resumirAmostras(amostras)!;
    expect(r.amostras).toBe(15);
    expect(r.cpuMax).toBe(200);
  });

  it("com janela, usa só o cenário e descarta a amostra que inclui o início", () => {
    const r = resumirAmostras(amostras, { inicioMs: 5000, fimMs: 15000 })!;
    expect(r.amostras).toBe(10); // t = 6 s … 15 s
    expect(r.cpuMedia).toBe(50);
    expect(r.cpuMax).toBe(50);
    expect(r.memMediaMiB).toBe(20);
  });

  it("volta a usar todas as amostras se a janela tiver menos de 3", () => {
    const r = resumirAmostras(amostras, { inicioMs: 100_000, fimMs: 110_000 })!;
    expect(r.amostras).toBe(15);
  });

  it("devolve null sem amostras", () => {
    expect(resumirAmostras([])).toBeNull();
  });
});

function k6(p95: number, descartadas: number, taxaErros = 0): K6Resultado {
  const lat = { media: p95 / 2, p50: p95 / 3, p90: p95 * 0.9, p95, p99: p95 * 2, max: p95 * 3, n: 1000 };
  return {
    requisicoes: 1000,
    throughput: 100,
    latencia: lat,
    latenciaLeitura: lat,
    latenciaEscrita: lat,
    taxaErros,
    descartadas,
    nginxHits: 0,
    nginxMisses: 0,
    respostas304: 0,
    inicioMs: null,
  };
}

describe("sustentavel", () => {
  it("exige p95 < 100 ms, < 1% descartadas e < 1% de erros", () => {
    expect(sustentavel(k6(99, 0), 100, 30)).toBe(true);
    expect(sustentavel(k6(100, 0), 100, 30)).toBe(false);
    expect(sustentavel(k6(10, 29), 100, 30)).toBe(true); // 29/3000 < 1%
    expect(sustentavel(k6(10, 30), 100, 30)).toBe(false);
    expect(sustentavel(k6(10, 0, 0.01), 100, 30)).toBe(false);
  });
});

describe("chaveDe", () => {
  it("mantém a chave da primeira medição e distingue a confirmação", () => {
    const e = { estrategia: "none" as const, carga: "escrita" as const, taxa: 200, repeticao: 1 };
    expect(chaveDe("capacidade", e)).toBe("capacidade|none|escrita|t200|r1");
    expect(chaveDe("capacidade", { ...e, tentativa: 1 })).toBe("capacidade|none|escrita|t200|r1");
    expect(chaveDe("capacidade", { ...e, tentativa: 2 })).toBe("capacidade|none|escrita|t200|r1|a2");
  });
});

describe("capacidades", () => {
  const med = (taxa: number, ok: boolean, tentativa = 1, repeticao = 1) =>
    ({ estrategia: "redis", carga: "mista", taxa, repeticao, tentativa, sustentavel: ok }) as Medicao;

  it("um degrau reprovado e aprovado na confirmação conta como sustentável", () => {
    const ms = [med(400, true), med(600, false), med(600, true, 2), med(800, false), med(800, false, 2)];
    expect(capacidades(ms)).toEqual([{ estrategia: "redis", carga: "mista", repeticao: 1, capacidade: 600 }]);
  });

  it("capacidade 0 se nem o menor degrau for sustentável", () => {
    expect(capacidades([med(400, false), med(400, false, 2)])[0]!.capacidade).toBe(0);
  });

  it("separa as repetições", () => {
    const caps = capacidades([med(400, true, 1, 1), med(600, false, 1, 1), med(600, false, 2, 1), med(400, true, 1, 2), med(600, true, 1, 2)]);
    expect(caps.map((c) => c.capacidade)).toEqual([400, 600]);
  });
});
