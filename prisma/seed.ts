// Dados sintéticos do catálogo: 50 categorias e 10.000 produtos.
//
// Determinístico: faker com seed fixo e datas fixas (nada depende do relógio),
// para que toda execução do experimento comece exatamente do mesmo estado.
// A versão do @faker-js/faker está fixada no package.json.
//
// Uso:  pnpm db:seed          (apaga os dados atuais e reinsere)
import { Faker, base, en, pt_BR } from "@faker-js/faker";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { config } from "../src/config";
import { createDb, type Db } from "../src/db";

export const SEED = 20_263;
export const N_PRODUTOS = 10_000;
const BATCH = 1_000;
/** Data de referência do mundo sintético (cadastros entre 2023 e esta data). */
const REF = Date.UTC(2026, 5, 30);

const CATEGORIAS = [
  "Celulares", "Smartphones Recondicionados", "Notebooks", "Computadores", "Monitores", "Periféricos",
  "Componentes de PC", "Impressoras", "Redes e Wi-Fi", "Armazenamento", "Tablets", "Smartwatches",
  "Fones de Ouvido", "Caixas de Som", "TVs", "Áudio e Home Theater", "Games", "Consoles",
  "Câmeras e Drones", "Eletroportáteis", "Geladeiras", "Fogões e Cooktops", "Micro-ondas",
  "Máquinas de Lavar", "Ar-Condicionado", "Ventiladores", "Aspiradores", "Cafeteiras", "Móveis",
  "Colchões", "Cama, Mesa e Banho", "Decoração", "Iluminação", "Utilidades Domésticas",
  "Ferramentas", "Jardim", "Automotivo", "Esporte e Lazer", "Bicicletas", "Suplementos",
  "Beleza e Perfumaria", "Saúde", "Bebês", "Brinquedos", "Livros", "Papelaria",
  "Pet Shop", "Moda Masculina", "Moda Feminina", "Calçados",
];

function slug(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export interface SeedData {
  categorias: Array<{ id: number; nome: string; slug: string }>;
  produtos: Array<{
    id: number;
    sku: string;
    nome: string;
    descricao: string;
    preco: string;
    estoque: number;
    ativo: boolean;
    categoriaId: number;
    criadoEm: Date;
    atualizadoEm: Date;
  }>;
}

export function generateSeedData(): SeedData {
  const faker = new Faker({ locale: [pt_BR, en, base] });
  faker.seed(SEED);
  faker.setDefaultRefDate(new Date(REF));

  const categorias = CATEGORIAS.map((nome, i) => ({ id: i + 1, nome, slug: slug(nome) }));
  const produtos: SeedData["produtos"] = [];
  const inicio = Date.UTC(2023, 0, 1);
  for (let i = 1; i <= N_PRODUTOS; i++) {
    const criado = inicio + faker.number.int({ min: 0, max: REF - inicio });
    const atualizado = criado + faker.number.int({ min: 0, max: REF - criado });
    const nome = faker.commerce.productName();
    produtos.push({
      id: i,
      sku: `SKU-${String(i).padStart(6, "0")}`,
      nome,
      descricao:
        `${nome}: produto ${faker.commerce.productAdjective().toLowerCase()} feito de ` +
        `${faker.commerce.productMaterial().toLowerCase()}, com garantia de ${faker.helpers.arrayElement([3, 6, 12, 24])} meses.`,
      preco: faker.commerce.price({ min: 9.9, max: 9_999.9, dec: 2 }),
      estoque: faker.number.int({ min: 0, max: 500 }),
      ativo: faker.number.float({ min: 0, max: 1 }) < 0.95,
      categoriaId: faker.number.int({ min: 1, max: categorias.length }),
      criadoEm: new Date(criado),
      atualizadoEm: new Date(atualizado),
    });
  }
  return { categorias, produtos };
}

/** Hash do conteúdo gerado: permite conferir que o seed é idêntico entre máquinas. */
export function seedFingerprint(data: SeedData): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
}

/** Apaga tudo e reinsere o estado inicial (usado antes de cada execução do experimento). */
export async function resetDatabase(prisma: Db, data = generateSeedData()): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("TRUNCATE produto, categoria RESTART IDENTITY CASCADE");
    await tx.categoria.createMany({ data: data.categorias });
    for (let i = 0; i < data.produtos.length; i += BATCH) {
      await tx.produto.createMany({ data: data.produtos.slice(i, i + BATCH) });
    }
    // As sequências precisam continuar depois dos IDs explícitos do seed.
    await tx.$executeRawUnsafe("SELECT setval(pg_get_serial_sequence('categoria', 'id'), (SELECT MAX(id) FROM categoria))");
    await tx.$executeRawUnsafe("SELECT setval(pg_get_serial_sequence('produto', 'id'), (SELECT MAX(id) FROM produto))");
  }, { timeout: 120_000 });
  await prisma.$executeRawUnsafe("ANALYZE produto, categoria");
}

async function main(): Promise<void> {
  const prisma = createDb(config.databaseUrl, 2);
  try {
    const t0 = Date.now();
    const data = generateSeedData();
    await resetDatabase(prisma, data);
    console.log(
      `✓ ${data.categorias.length} categorias e ${data.produtos.length} produtos inseridos em ${Date.now() - t0} ms ` +
        `(fingerprint ${seedFingerprint(data)})`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
