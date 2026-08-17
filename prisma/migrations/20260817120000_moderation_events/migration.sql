CREATE TABLE "moderation_events" (
    "id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "telegram_user_id" BIGINT,
    "event_type" VARCHAR(64) NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "reason" VARCHAR(255),
    "matched_pattern" VARCHAR(255),
    "message_id" INTEGER,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "moderation_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "moderation_events_chat_id_created_at_idx" ON "moderation_events"("chat_id", "created_at");
CREATE INDEX "moderation_events_event_type_action_created_at_idx" ON "moderation_events"("event_type", "action", "created_at");
CREATE INDEX "moderation_events_telegram_user_id_created_at_idx" ON "moderation_events"("telegram_user_id", "created_at");
ALTER TABLE "moderation_events" ADD CONSTRAINT "moderation_events_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
