/*
  Warnings:

  - You are about to alter the column `price` on the `Product` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(65,30)`.

*/
-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "length" DOUBLE PRECISION,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "origin" TEXT,
ADD COLUMN     "size" TEXT,
ADD COLUMN     "sku" TEXT,
ADD COLUMN     "width" DOUBLE PRECISION,
ALTER COLUMN "description" DROP NOT NULL,
ALTER COLUMN "price" SET DATA TYPE DECIMAL(65,30);
