-- CreateTable
CREATE TABLE "categoria" (
    "id" SERIAL NOT NULL,
    "nome" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(80) NOT NULL,

    CONSTRAINT "categoria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "produto" (
    "id" SERIAL NOT NULL,
    "sku" VARCHAR(20) NOT NULL,
    "nome" VARCHAR(160) NOT NULL,
    "descricao" TEXT NOT NULL,
    "preco" DECIMAL(10,2) NOT NULL,
    "estoque" INTEGER NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "categoria_id" INTEGER NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "produto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "categoria_slug_key" ON "categoria"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "produto_sku_key" ON "produto"("sku");

-- CreateIndex
CREATE INDEX "produto_categoria_id_id_idx" ON "produto"("categoria_id", "id");

-- AddForeignKey
ALTER TABLE "produto" ADD CONSTRAINT "produto_categoria_id_fkey" FOREIGN KEY ("categoria_id") REFERENCES "categoria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
