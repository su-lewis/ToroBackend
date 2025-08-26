/*
  MANUAL MIGRATION SCRIPT
  This script safely handles the following potentially destructive changes:
  1. Adds a required `updatedAt` column to the `Payment` table by providing a temporary default for existing rows.
  2. Converts the `status` column on the `Payment` table from String to a new `PaymentStatus` ENUM without losing data.
  3. Replaces the `stripeAutoPayoutsEnabled` column on the `User` table with the new `autoInstantPayoutsEnabled` column.
*/

-- Step 1: Create the new ENUM type for PaymentStatus.
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- Step 2: Add the required 'updatedAt' column to 'Payment' with a temporary default.
-- This populates the column for all existing rows.
ALTER TABLE "Payment" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Step 3: Safely migrate the 'status' column on the 'Payment' table.
-- First, add a temporary column with the new enum type.
ALTER TABLE "Payment" ADD COLUMN "status_new" "PaymentStatus" NOT NULL DEFAULT 'PENDING';

-- Second, copy and cast the data from the old string column to the new enum column.
-- This is the crucial data-preserving step.
UPDATE "Payment" SET "status_new" = 
  CASE 
    WHEN "status" = 'succeeded' THEN 'SUCCEEDED'::"PaymentStatus"
    WHEN "status" = 'failed' THEN 'FAILED'::"PaymentStatus"
    WHEN "status" = 'canceled' THEN 'CANCELED'::"PaymentStatus"
    ELSE 'PENDING'::"PaymentStatus"
  END;

-- Third, drop the old string 'status' column.
ALTER TABLE "Payment" DROP COLUMN "status";

-- Fourth, rename the new column to its final name.
ALTER TABLE "Payment" RENAME COLUMN "status_new" TO "status";


-- Step 4: Alter the 'User' table: drop the old column and add the new one.
-- We are intentionally dropping the old column as its logic is being replaced.
ALTER TABLE "User" DROP COLUMN "stripeAutoPayoutsEnabled";
ALTER TABLE "User" ADD COLUMN "autoInstantPayoutsEnabled" BOOLEAN NOT NULL DEFAULT false;


-- Step 5: Clean up the temporary default on Payment.updatedAt.
-- Prisma's `@updatedAt` will handle this for all future updates.
ALTER TABLE "Payment" ALTER COLUMN "updatedAt" DROP DEFAULT;