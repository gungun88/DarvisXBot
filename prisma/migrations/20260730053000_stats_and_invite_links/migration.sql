-- CreateEnum
CREATE TYPE "ChatStatsEventType" AS ENUM ('JOIN', 'LEAVE', 'INVITE');

-- CreateTable
CREATE TABLE "chat_daily_message_stats" (
    "id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "stat_date" VARCHAR(10) NOT NULL,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_daily_message_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_stats_events" (
    "id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "event_type" "ChatStatsEventType" NOT NULL,
    "actor_user_id" TEXT,
    "target_user_id" TEXT,
    "stat_date" VARCHAR(10) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_stats_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite_links" (
    "id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "creator_user_id" TEXT NOT NULL,
    "invite_link" VARCHAR(512) NOT NULL,
    "expire_at" TIMESTAMP(3),
    "member_limit" INTEGER,
    "creates_join_request" BOOLEAN NOT NULL DEFAULT false,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invite_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite_joins" (
    "id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "invite_link_id" TEXT,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),

    CONSTRAINT "invite_joins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_daily_message_stats_chat_id_user_id_stat_date_key" ON "chat_daily_message_stats"("chat_id", "user_id", "stat_date");

-- CreateIndex
CREATE INDEX "chat_daily_message_stats_chat_id_stat_date_idx" ON "chat_daily_message_stats"("chat_id", "stat_date");

-- CreateIndex
CREATE INDEX "chat_stats_events_chat_id_event_type_stat_date_idx" ON "chat_stats_events"("chat_id", "event_type", "stat_date");

-- CreateIndex
CREATE INDEX "chat_stats_events_chat_id_actor_user_id_stat_date_idx" ON "chat_stats_events"("chat_id", "actor_user_id", "stat_date");

-- CreateIndex
CREATE UNIQUE INDEX "invite_links_invite_link_key" ON "invite_links"("invite_link");

-- CreateIndex
CREATE INDEX "invite_links_chat_id_creator_user_id_revoked_at_idx" ON "invite_links"("chat_id", "creator_user_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "invite_joins_chat_id_user_id_key" ON "invite_joins"("chat_id", "user_id");

-- CreateIndex
CREATE INDEX "invite_joins_chat_id_invite_link_id_idx" ON "invite_joins"("chat_id", "invite_link_id");

-- AddForeignKey
ALTER TABLE "chat_daily_message_stats" ADD CONSTRAINT "chat_daily_message_stats_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_stats_events" ADD CONSTRAINT "chat_stats_events_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_creator_user_id_fkey" FOREIGN KEY ("creator_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_joins" ADD CONSTRAINT "invite_joins_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_joins" ADD CONSTRAINT "invite_joins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_joins" ADD CONSTRAINT "invite_joins_invite_link_id_fkey" FOREIGN KEY ("invite_link_id") REFERENCES "invite_links"("id") ON DELETE SET NULL ON UPDATE CASCADE;
