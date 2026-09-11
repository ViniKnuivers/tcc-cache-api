// Caminhos do projeto usados pelo runner.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const RESULTS_DIR = path.join(ROOT, "results");
/** URL da API no host (rotas internas de métricas; a carga entra pelo nginx). */
export const API_URL = process.env["API_URL"] ?? "http://localhost:3000";
