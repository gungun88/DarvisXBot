ALTER TYPE "GiveawayStatus" ADD VALUE 'FAILED';

ALTER TABLE "scheduled_messages"
ADD COLUMN "last_error" TEXT,
ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "last_attempt_at" TIMESTAMP(3);

ALTER TABLE "giveaways"
ADD COLUMN "last_error" TEXT,
ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "last_attempt_at" TIMESTAMP(3);
