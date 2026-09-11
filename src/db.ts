// Cliente Prisma (ORM 7, com driver adapter do node-postgres).
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

export function createPrisma(connectionString: string, maxConnections = 10): PrismaClient {
  const adapter = new PrismaPg({ connectionString, max: maxConnections });
  return new PrismaClient({ adapter });
}

export type { PrismaClient };
