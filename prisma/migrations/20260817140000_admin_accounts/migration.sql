CREATE TABLE "admin_accounts" (
    "id" TEXT NOT NULL,
    "username" VARCHAR(128) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "role" VARCHAR(32) NOT NULL DEFAULT 'operator',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "bootstrap_managed" BOOLEAN NOT NULL DEFAULT false,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_accounts_username_key" ON "admin_accounts"("username");
CREATE INDEX "admin_accounts_enabled_role_idx" ON "admin_accounts"("enabled", "role");
