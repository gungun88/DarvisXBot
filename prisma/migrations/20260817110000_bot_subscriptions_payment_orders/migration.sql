-- Bot-level subscriptions and provider payment orders are separate from per-chat memberships.
CREATE TYPE "BotSubscriptionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED');
CREATE TYPE "PaymentOrderStatus" AS ENUM ('PENDING', 'WAITING', 'CONFIRMED', 'FINISHED', 'FAILED', 'EXPIRED', 'REFUNDED');

CREATE TABLE "bot_subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "status" "BotSubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" VARCHAR(64) NOT NULL DEFAULT 'manual',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bot_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_orders" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" VARCHAR(32) NOT NULL DEFAULT 'nowpayments',
    "plan_key" VARCHAR(16) NOT NULL,
    "months" INTEGER NOT NULL,
    "amount_usd" DECIMAL(18,8) NOT NULL,
    "pay_currency" VARCHAR(32),
    "provider_payment_id" VARCHAR(128),
    "pay_url" VARCHAR(1024),
    "status" "PaymentOrderStatus" NOT NULL DEFAULT 'PENDING',
    "raw_payload" JSONB,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bot_subscriptions_user_id_key" ON "bot_subscriptions"("user_id");
CREATE INDEX "bot_subscriptions_status_expires_at_idx" ON "bot_subscriptions"("status", "expires_at");
CREATE UNIQUE INDEX "payment_orders_provider_payment_id_key" ON "payment_orders"("provider_payment_id");
CREATE INDEX "payment_orders_user_id_status_created_at_idx" ON "payment_orders"("user_id", "status", "created_at");
CREATE INDEX "payment_orders_status_updated_at_idx" ON "payment_orders"("status", "updated_at");

ALTER TABLE "bot_subscriptions" ADD CONSTRAINT "bot_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
