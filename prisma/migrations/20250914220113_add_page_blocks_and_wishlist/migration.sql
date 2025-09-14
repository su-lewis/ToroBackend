/*
  Warnings:

  - You are about to drop the `Link` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "public"."PageBlockType" AS ENUM ('LINK', 'WISHLIST', 'HEADER');

-- DropForeignKey
ALTER TABLE "public"."Link" DROP CONSTRAINT "Link_userId_fkey";

-- AlterTable
ALTER TABLE "public"."Payment" ADD COLUMN     "pageBlockId" TEXT;

-- DropTable
DROP TABLE "public"."Link";

-- CreateTable
CREATE TABLE "public"."PageBlock" (
    "id" TEXT NOT NULL,
    "type" "public"."PageBlockType" NOT NULL DEFAULT 'LINK',
    "order" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT,
    "url" TEXT,
    "priceCents" INTEGER,
    "quantityGoal" INTEGER,
    "isUnlimited" BOOLEAN NOT NULL DEFAULT false,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PageBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PageBlock_userId_idx" ON "public"."PageBlock"("userId");

-- CreateIndex
CREATE INDEX "Payment_pageBlockId_idx" ON "public"."Payment"("pageBlockId");

-- AddForeignKey
ALTER TABLE "public"."PageBlock" ADD CONSTRAINT "PageBlock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Payment" ADD CONSTRAINT "Payment_pageBlockId_fkey" FOREIGN KEY ("pageBlockId") REFERENCES "public"."PageBlock"("id") ON DELETE SET NULL ON UPDATE SET NULL;
