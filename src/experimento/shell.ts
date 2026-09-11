// Execução de comandos externos (docker, git) a partir do runner.
import { execFile } from "node:child_process";
import { ROOT } from "./paths";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function run(
  cmd: string,
  args: readonly string[],
  opts: { env?: Record<string, string>; allowFail?: boolean; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd: ROOT,
        env: { ...process.env, ...opts.env },
        maxBuffer: 64 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 0,
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        if (code !== 0 && !opts.allowFail) {
          reject(new Error(`${cmd} ${args.join(" ")} falhou (código ${code}):\n${stderr || stdout}`));
          return;
        }
        resolve({ stdout, stderr, code });
      },
    );
  });
}
