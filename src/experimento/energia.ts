// Condições da máquina durante as medições.
//
// Uma medição só vale se a máquina ficou acordada o tempo todo e nas mesmas
// condições de energia. No macOS, o `caffeinate` impede só o repouso por
// inatividade: com a tampa fechada ou na bateria o sistema ainda suspende, e
// as requisições em andamento "congelam" (latências de minutos).
//
// - Antes de cada medição: espera o carregador estar conectado e a tampa
//   aberta (macOS; em outros sistemas as verificações são ignoradas).
// - Depois: verifica se houve suspensão no intervalo. Se houve, a medição é
//   descartada e repetida automaticamente.
import os from "node:os";
import { run } from "./shell";

const MAC = os.platform() === "darwin";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Condicoes {
  /** "AC", "bateria" ou null se não for possível saber. */
  energia: "AC" | "bateria" | null;
  /** true se a tampa do notebook está fechada; null se não se aplica. */
  tampaFechada: boolean | null;
}

export async function condicoes(): Promise<Condicoes> {
  if (!MAC) return { energia: null, tampaFechada: null };
  const batt = await run("pmset", ["-g", "batt"], { allowFail: true });
  const energia = /AC Power/.test(batt.stdout) ? "AC" : /Battery Power/.test(batt.stdout) ? "bateria" : null;
  const io = await run("ioreg", ["-r", "-k", "AppleClamshellState", "-d", "1"], { allowFail: true });
  const m = /"AppleClamshellState" = (Yes|No)/.exec(io.stdout);
  return { energia, tampaFechada: m ? m[1] === "Yes" : null };
}

export function condicoesOk(c: Condicoes): boolean {
  return c.energia !== "bateria" && c.tampaFechada !== true;
}

/** Espera (avisando) até o carregador estar conectado e a tampa aberta. */
export async function aguardarCondicoes(): Promise<void> {
  let avisou = false;
  for (;;) {
    const c = await condicoes();
    if (condicoesOk(c)) {
      if (avisou) console.log("  ▶ Condições restabelecidas; continuando.");
      return;
    }
    if (!avisou) {
      const falta = [c.energia === "bateria" ? "conecte o carregador" : null, c.tampaFechada ? "abra a tampa" : null].filter(Boolean).join(" e ");
      console.warn(`  ⏸ Medições pausadas: ${falta}. O experimento continua sozinho em seguida.`);
      avisou = true;
    }
    await sleep(15_000);
  }
}

/** Instante do último despertar do sistema (macOS), em ms; null se indisponível. */
async function ultimoDespertar(): Promise<number | null> {
  if (!MAC) return null;
  const r = await run("sysctl", ["-n", "kern.waketime"], { allowFail: true });
  const m = /sec = (\d+), usec = (\d+)/.exec(r.stdout);
  return m ? Number(m[1]) * 1000 + Math.floor(Number(m[2]) / 1000) : null;
}

/**
 * Marca o início de um intervalo e devolve uma função que diz quantos segundos
 * o sistema passou suspenso nele (0 se não houve suspensão).
 *
 * Dois sinais independentes: no macOS, mudança de `kern.waketime` (o sistema
 * dormiu e acordou); em qualquer sistema, diferença entre o relógio de parede
 * e o relógio monotônico (que não conta o tempo suspenso no Linux).
 */
export async function vigiarSuspensao(): Promise<() => Promise<number>> {
  const despertar0 = await ultimoDespertar();
  const parede0 = Date.now();
  const mono0 = performance.now();
  return async () => {
    const despertar1 = await ultimoDespertar();
    const diferencaRelogios = (Date.now() - parede0 - (performance.now() - mono0)) / 1000;
    const acordou = despertar0 !== null && despertar1 !== null && despertar1 !== despertar0;
    if (acordou) return Math.max(1, diferencaRelogios);
    return diferencaRelogios > 2 ? diferencaRelogios : 0;
  };
}

export interface MemoriaHost {
  /** Swap em uso no sistema hospedeiro (MiB). */
  swapMiB: number | null;
  /** Memória livre segundo o `memory_pressure` do macOS (%). */
  livrePct: number | null;
}

/** Memória do hospedeiro (macOS). Swap alto indica que a VM do Docker pode estar sendo paginada. */
export async function memoriaHost(): Promise<MemoriaHost> {
  if (!MAC) return { swapMiB: null, livrePct: null };
  const sw = await run("sysctl", ["-n", "vm.swapusage"], { allowFail: true });
  const used = /used = ([\d.]+)M/.exec(sw.stdout);
  const mp = await run("memory_pressure", [], { allowFail: true });
  const livre = /free percentage: (\d+)%/.exec(mp.stdout);
  return { swapMiB: used ? Number(used[1]) : null, livrePct: livre ? Number(livre[1]) : null };
}
