-- CreateTable
CREATE TABLE "Product" (
    "id" SERIAL NOT NULL,
    "stockCode" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "sku" TEXT,
    "price" DOUBLE PRECISION NOT NULL,
    "origin" TEXT,
    "length" DOUBLE PRECISION,
    "width" DOUBLE PRECISION,
    "size" TEXT,
    "stockLevel" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_stockCode_key" ON "Product"("stockCode");