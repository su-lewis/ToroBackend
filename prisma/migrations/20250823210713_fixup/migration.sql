/*
  Warnings:

  - You are about to drop the column `country` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `dobDay` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `dobMonth` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `dobYear` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `firstName` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `lastName` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `phone` on the `User` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."User" DROP COLUMN "country",
DROP COLUMN "dobDay",
DROP COLUMN "dobMonth",
DROP COLUMN "dobYear",
DROP COLUMN "firstName",
DROP COLUMN "lastName",
DROP COLUMN "phone";

-- CreateIndex
CREATE INDEX "Payment_recipientUserId_idx" ON "public"."Payment"("recipientUserId");
