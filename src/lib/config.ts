import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  BOT_MODE: z.enum(["polling", "webhook"]).default("polling"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  BOT_TOKEN: z.string().min(1),
  BOT_USERNAME: z.string().min(1).default("DarvisXBot"),
  WEBHOOK_PATH: z.string().startsWith("/").default("/telegram/webhook"),
  WEBHOOK_SECRET: z.string().min(16).optional(),
  DROP_PENDING_UPDATES: z.coerce.boolean().default(true),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  DEFAULT_TIMEZONE: z.string().default("Asia/Shanghai")
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.message}`);
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
    defaultTimezone: parsed.data.DEFAULT_TIMEZONE
  };
}
