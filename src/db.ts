// Cliente Prisma (ORM 7, com driver adapter do node-postgres).
//
// Uma extensão conta cada operação enviada ao banco (onQuery), métrica
// "acessos ao banco" do pré-projeto. O runner também lê o pg_stat_statements
// do Postgres, que conta as consultas SQL efetivamente executadas.
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

export function createDb(connectionString: string, maxConnections = 10, onQuery?: () => void) {
  const adapter = new PrismaPg({ connectionString, max: maxConnections });
  return new PrismaClient({ adapter }).$extends({
    query: {
      async $allOperations({ args, query }) {
        onQuery?.();
        return query(args);
      },
    },
  });
}

export type Db = ReturnType<typeof createDb>;
