-- CreateEnum
CREATE TYPE "PointTransactionType" AS ENUM ('SIGN_IN', 'SPEECH', 'INVITE', 'MANUAL', 'LOTTERY', 'EXCHANGE');

-- CreateTable
CREATE TABLE "chat_point_balances" (
    "id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "last_transaction_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_point_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_point_transactions" (
    "id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "type" "PointTransactionType" NOT NULL,
    "delta" INTEGER NOT NULL,
    "balance_after" INTEGER,
    "reference_key" VARCHAR(128),
    "day_key" VARCHAR(10),
    "note" VARCHAR(255),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_point_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_point_balances_chat_id_user_id_key" ON "chat_point_balances"("chat_id", "user_id");

-- CreateIndex
CREATE INDEX "chat_point_balances_chat_id_balance_idx" ON "chat_point_balances"("chat_id", "balance");

-- CreateIndex
CREATE UNIQUE INDEX "chat_point_transactions_reference_key_key" ON "chat_point_transactions"("reference_key");

-- CreateIndex
CREATE INDEX "chat_point_transactions_chat_id_user_id_created_at_idx" ON "chat_point_transactions"("chat_id", "user_id", "created_at");

-- CreateIndex
CREATE INDEX "chat_point_transactions_chat_id_user_id_type_day_key_idx" ON "chat_point_transactions"("chat_id", "user_id", "type", "day_key");

-- CreateIndex
CREATE INDEX "chat_point_transactions_chat_id_type_created_at_idx" ON "chat_point_transactions"("chat_id", "type", "created_at");

-- AddForeignKey
ALTER TABLE "chat_point_balances" ADD CONSTRAINT "chat_point_balances_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_point_balances" ADD CONSTRAINT "chat_point_balances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_point_transactions" ADD CONSTRAINT "chat_point_transactions_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_point_transactions" ADD CONSTRAINT "chat_point_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_point_transactions" ADD CONSTRAINT "chat_point_transactions_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
