-- CreateTable
CREATE TABLE "join_verifications" (
    "id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "telegram_chat_id" BIGINT NOT NULL,
    "telegram_user_id" BIGINT NOT NULL,
    "message_id" INTEGER NOT NULL,
    "mode" VARCHAR(32) NOT NULL,
    "answer" VARCHAR(64) NOT NULL,
    "punishment" VARCHAR(16) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "join_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "join_verifications_chat_id_telegram_user_id_key" ON "join_verifications"("chat_id", "telegram_user_id");

-- CreateIndex
CREATE INDEX "join_verifications_expires_at_idx" ON "join_verifications"("expires_at");

-- AddForeignKey
ALTER TABLE "join_verifications" ADD CONSTRAINT "join_verifications_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
