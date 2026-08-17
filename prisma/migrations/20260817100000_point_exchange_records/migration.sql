CREATE TYPE "PointProductCodeStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'DELIVERED', 'VOID');
CREATE TYPE "PointRedemptionStatus" AS ENUM ('DELIVERY_PENDING', 'FULFILLED', 'REFUNDED', 'CANCELLED');

CREATE TABLE "point_products" (
    "id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "external_id" VARCHAR(16) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "cost" INTEGER NOT NULL,
    "listed" BOOLEAN NOT NULL DEFAULT false,
    "daily_limit" INTEGER NOT NULL DEFAULT 0,
    "sold_count" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "point_products_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "point_product_codes" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "value" VARCHAR(255) NOT NULL,
    "status" "PointProductCodeStatus" NOT NULL DEFAULT 'AVAILABLE',
    "reserved_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "point_product_codes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "point_redemptions" (
    "id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "code_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "cost" INTEGER NOT NULL,
    "day_key" VARCHAR(10) NOT NULL,
    "status" "PointRedemptionStatus" NOT NULL DEFAULT 'DELIVERY_PENDING',
    "delivery_error" TEXT,
    "delivered_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "point_redemptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "point_products_chat_id_external_id_key" ON "point_products"("chat_id", "external_id");
CREATE INDEX "point_products_chat_id_listed_archived_at_idx" ON "point_products"("chat_id", "listed", "archived_at");
CREATE UNIQUE INDEX "point_product_codes_product_id_value_key" ON "point_product_codes"("product_id", "value");
CREATE INDEX "point_product_codes_product_id_status_created_at_idx" ON "point_product_codes"("product_id", "status", "created_at");
CREATE UNIQUE INDEX "point_redemptions_code_id_key" ON "point_redemptions"("code_id");
CREATE UNIQUE INDEX "point_redemptions_transaction_id_key" ON "point_redemptions"("transaction_id");
CREATE INDEX "point_redemptions_chat_id_status_created_at_idx" ON "point_redemptions"("chat_id", "status", "created_at");
CREATE INDEX "point_redemptions_chat_id_user_id_day_key_idx" ON "point_redemptions"("chat_id", "user_id", "day_key");
CREATE INDEX "point_redemptions_product_id_created_at_idx" ON "point_redemptions"("product_id", "created_at");

ALTER TABLE "point_products" ADD CONSTRAINT "point_products_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "point_product_codes" ADD CONSTRAINT "point_product_codes_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "point_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "point_redemptions" ADD CONSTRAINT "point_redemptions_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "point_redemptions" ADD CONSTRAINT "point_redemptions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "point_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "point_redemptions" ADD CONSTRAINT "point_redemptions_code_id_fkey" FOREIGN KEY ("code_id") REFERENCES "point_product_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "point_redemptions" ADD CONSTRAINT "point_redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "point_redemptions" ADD CONSTRAINT "point_redemptions_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "chat_point_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "point_products" ("id", "chat_id", "external_id", "name", "cost", "listed", "daily_limit", "sold_count", "created_at", "updated_at")
SELECT
    'legacy_' || md5(s."chat_id" || ':' || (product.value->>'id')),
    s."chat_id",
    left(product.value->>'id', 16),
    left(COALESCE(product.value->>'name', ''), 64),
    GREATEST(1, LEAST(1000000, COALESCE((product.value->>'cost')::integer, 1))),
    COALESCE((product.value->>'listed')::boolean, false),
    GREATEST(0, LEAST(1000000, COALESCE((product.value->>'dailyLimit')::integer, 0))),
    GREATEST(0, COALESCE((product.value->>'soldCount')::integer, 0)),
    s."created_at",
    s."updated_at"
FROM "settings" s
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s."value"->'products', '[]'::jsonb)) AS product(value)
WHERE s."key" = 'point_exchange'
  AND COALESCE(product.value->>'id', '') <> ''
ON CONFLICT ("chat_id", "external_id") DO NOTHING;

INSERT INTO "point_product_codes" ("id", "product_id", "value", "created_at")
SELECT
    'legacy_code_' || md5(p."id" || ':' || code.value),
    p."id",
    left(code.value, 255),
    p."created_at"
FROM "point_products" p
JOIN "settings" s ON s."chat_id" = p."chat_id" AND s."key" = 'point_exchange'
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s."value"->'products', '[]'::jsonb)) AS product(value)
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(product.value->'codes', '[]'::jsonb)) AS code(value)
WHERE product.value->>'id' = p."external_id"
  AND btrim(code.value) <> ''
ON CONFLICT ("product_id", "value") DO NOTHING;
