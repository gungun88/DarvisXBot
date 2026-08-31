CREATE TABLE "payment_providers" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "provider_key" VARCHAR(32) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "refund_enabled" BOOLEAN NOT NULL DEFAULT true,
    "supported_types" JSONB NOT NULL DEFAULT '[]',
    "config" JSONB NOT NULL DEFAULT '{}',
    "limits" JSONB NOT NULL DEFAULT '{}',
    "public_base_url" VARCHAR(255) NOT NULL DEFAULT '',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_providers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payment_providers_enabled_sort_order_idx" ON "payment_providers"("enabled", "sort_order");
