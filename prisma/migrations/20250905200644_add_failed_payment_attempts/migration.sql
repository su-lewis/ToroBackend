-- CreateTable
CREATE TABLE "public"."FailedPaymentAttempt" (
    "id" TEXT NOT NULL,
    "stripePiId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FailedPaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FailedPaymentAttempt_stripePiId_key" ON "public"."FailedPaymentAttempt"("stripePiId");

-- CreateIndex
CREATE INDEX "FailedPaymentAttempt_recipientUserId_idx" ON "public"."FailedPaymentAttempt"("recipientUserId");
