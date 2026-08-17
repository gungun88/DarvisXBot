CREATE TABLE "admin_sessions" (
    "id" TEXT NOT NULL,
    "jti" VARCHAR(64) NOT NULL,
    "username" VARCHAR(128) NOT NULL,
    "role" VARCHAR(32) NOT NULL DEFAULT 'owner',
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(512),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_sessions_jti_key" ON "admin_sessions"("jti");
CREATE INDEX "admin_sessions_username_revoked_at_expires_at_idx" ON "admin_sessions"("username", "revoked_at", "expires_at");
