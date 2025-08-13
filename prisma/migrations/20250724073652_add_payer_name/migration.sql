-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "payerName" TEXT;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "profileBackgroundColor" SET DEFAULT '#FFFFFF';
