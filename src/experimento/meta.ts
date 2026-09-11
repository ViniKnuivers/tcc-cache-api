// Metadados de reprodutibilidade: commit git, máquina, versões de software.
// Resultados de máquinas diferentes NÃO devem ser misturados numa análise.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "./paths";
import { run } from "./shell";

export interface GitInfo {
  commit: string;
  dirty: boolean;
  label: string;
}

export async function gitInfo(): Promise<GitInfo> {
  try {
    const commit = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
    const dirty = (await run("git", ["status", "--porcelain", "--", ".", ":(exclude)results"])).stdout.trim().length > 0;
    return { commit, dirty, label: `${commit.slice(0, 7)}${dirty ? "-dirty" : ""}` };
  } catch {
    return { commit: "unknown", dirty: true, label: "nogit" };
  }
}

export async function maquina(): Promise<Record<string, unknown>> {
  const cpus = os.cpus();
  const docker = await run("docker", ["info", "--format", "{{.ServerVersion}}|{{.NCPU}}|{{.MemTotal}}|{{.OperatingSystem}}"], {
    allowFail: true,
  });
  const [versao, ncpu, mem, sistema] = docker.stdout.trim().split("|");
  return {
    hostname: os.hostname(),
    plataforma: `${os.platform()} ${os.release()} (${os.arch()})`,
    cpu: cpus[0]?.model ?? "?",
    nucleos: cpus.length,
    memoriaGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    docker: {
      versao: versao ?? "?",
      cpusVm: Number(ncpu ?? NaN),
      memoriaVmGiB: Math.round((Number(mem ?? NaN) / 2 ** 30) * 10) / 10,
      sistema: sistema ?? "?",
    },
    node: process.version,
  };
}

export function versoes(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
  const images = Object.fromEntries([...compose.matchAll(/image:\s*(\S+)/g)].map((m) => [m[1]!.split(":")[0]!, m[1]!]));
  return { ...pkg.dependencies, ...images };
}

/** Identificador da rodada: tipo + timestamp UTC + commit, ex.: latencia-20260912-093000_5acb5be */
export function makeRunId(tipo: string, git: GitInfo, now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${tipo}-${ts}_${git.label}`;
}
