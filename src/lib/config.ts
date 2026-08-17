import "dotenv/config";
import { z } from "zod";

const optionalString = (schema: z.ZodString) => z.preprocess(
  (value) => value === "" ? undefined : value,
  schema.optional()
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  BOT_MODE: z.enum(["polling", "webhook"]).default("polling"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  BOT_TOKEN: z.string().min(1),
  BOT_USERNAME: z.string().min(1).default("DarvisXBot"),
  WEBHOOK_PATH: z.string().startsWith("/").default("/telegram/webhook"),
  WEBHOOK_SECRET: optionalString(z.string().min(16)),
  DROP_PENDING_UPDATES: z.coerce.boolean().default(true),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  DEFAULT_TIMEZONE: z.string().default("Asia/Shanghai"),
  ADMIN_USERNAME: z.string().min(3).default("admin"),
  ADMIN_PASSWORD: z.string().min(10).default("darvisx-local"),
  ADMIN_JWT_SECRET: z.string().min(32).default("darvisx-development-secret-change-me"),
  ADMIN_TOKEN_TTL: z.string().regex(/^\d+[smhd]$/).default("8h"),
  ADMIN_TOTP_SECRET: optionalString(z.string().min(16)),
  NOWPAYMENTS_API_BASE: z.string().url().default("https://api.nowpayments.io/v1"),
  NOWPAYMENTS_API_KEY: optionalString(z.string().min(1)),
  NOWPAYMENTS_IPN_SECRET: optionalString(z.string().min(16)),
  PUBLIC_BASE_URL: optionalString(z.string().url()),
  BACKUP_DIR: optionalString(z.string().min(1)),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  BACKUP_MAX_AGE_HOURS: z.coerce.number().int().min(1).max(720).default(26),
  RESTORE_MAX_AGE_HOURS: z.coerce.number().int().min(1).max(2160).default(168),
  ALERT_WEBHOOK_URL: optionalString(z.string().url()),
  ALERT_COOLDOWN_MINUTES: z.coerce.number().int().min(1).max(1440).default(30)
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.message}`);
  }

  if (parsed.data.NODE_ENV === "production" &&
      (!process.env.ADMIN_PASSWORD || !process.env.ADMIN_JWT_SECRET ||
       parsed.data.ADMIN_PASSWORD === "darvisx-local" || parsed.data.ADMIN_JWT_SECRET === "darvisx-development-secret-change-me")) {
    throw new Error("ADMIN_PASSWORD and ADMIN_JWT_SECRET must be explicitly configured in production");
  }

  if (parsed.data.NODE_ENV === "production" && parsed.data.BOT_MODE === "webhook" && !parsed.data.WEBHOOK_SECRET) {
    throw new Error("WEBHOOK_SECRET must be configured for production webhook mode");
  }

  const paymentConfigValues = [parsed.data.NOWPAYMENTS_API_KEY, parsed.data.NOWPAYMENTS_IPN_SECRET, parsed.data.PUBLIC_BASE_URL];
  if (paymentConfigValues.some(Boolean) && !paymentConfigValues.every(Boolean)) {
    throw new Error("NOWPAYMENTS_API_KEY, NOWPAYMENTS_IPN_SECRET, and PUBLIC_BASE_URL must be configured together");
  }

  return {
    nodeEnv: parsed.data.NODE_ENV,
    botMode: parsed.data.BOT_MODE,
    host: parsed.data.HOST,
    port: parsed.data.PORT,
    botToken: parsed.data.BOT_TOKEN,
    botUsername: parsed.data.BOT_USERNAME,
    webhookPath: parsed.data.WEBHOOK_PATH,
    webhookSecret: parsed.data.WEBHOOK_SECRET,
    dropPendingUpdates: parsed.data.DROP_PENDING_UPDATES,
    databaseUrl: parsed.data.DATABASE_URL,
    redisUrl: parsed.data.REDIS_URL,
    defaultTimezone: parsed.data.DEFAULT_TIMEZONE,
    adminUsername: parsed.data.ADMIN_USERNAME,
    adminPassword: parsed.data.ADMIN_PASSWORD,
    adminJwtSecret: parsed.data.ADMIN_JWT_SECRET,
    adminTokenTtl: parsed.data.ADMIN_TOKEN_TTL,
    adminTotpSecret: parsed.data.ADMIN_TOTP_SECRET,
    nowPaymentsApiBase: parsed.data.NOWPAYMENTS_API_BASE,
    nowPaymentsApiKey: parsed.data.NOWPAYMENTS_API_KEY,
    nowPaymentsIpnSecret: parsed.data.NOWPAYMENTS_IPN_SECRET,
    publicBaseUrl: parsed.data.PUBLIC_BASE_URL,
    backupDir: parsed.data.BACKUP_DIR,
    backupRetentionDays: parsed.data.BACKUP_RETENTION_DAYS,
    backupMaxAgeHours: parsed.data.BACKUP_MAX_AGE_HOURS,
    restoreMaxAgeHours: parsed.data.RESTORE_MAX_AGE_HOURS,
    alertWebhookUrl: parsed.data.ALERT_WEBHOOK_URL,
    alertCooldownMinutes: parsed.data.ALERT_COOLDOWN_MINUTES
  };
}
