// Prepara o banco de testes (catalogo_test), separado do banco do experimento:
// cria o banco se não existir e aplica as migrações.
import { execSync } from "node:child_process";
import pg from "pg";

export const TEST_DATABASE_URL = "postgresql://catalogo:catalogo@localhost:5434/catalogo_test";

export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: "postgresql://catalogo:catalogo@localhost:5434/catalogo" });
  await admin.connect();
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'catalogo_test'");
    if (exists.rowCount === 0) await admin.query("CREATE DATABASE catalogo_test");
  } finally {
    await admin.end();
  }
  execSync("pnpm exec prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "ignore",
  });
  process.env["DATABASE_URL"] = TEST_DATABASE_URL;
}
