-- CreateTable
CREATE TABLE "Product" (
    "id" SERIAL NOT NULL,
    "stockCode" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "stockLevel" INTEGER NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_stockCode_key" ON "Product"("stockCode");
