import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/setup/global.ts"],
    // Testes de integração compartilham o mesmo banco: execução sequencial.
    fileParallelism: false,
  },
});
