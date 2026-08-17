import helmet from "@fastify/helmet";
import Fastify from "fastify";
import { webhookCallback } from "grammy";
import type { Bot } from "grammy";
import type { AppConfig } from "./lib/config.js";
import { prisma } from "./lib/prisma.js";
import { redis } from "./lib/redis.js";
import { registerAdminApi } from "./admin/routes.js";
import { registerAdminUi } from "./admin/static.js";
import { processNowPaymentsIpn } from "./subscriptions/subscription.service.js";

export async function createServer(config: AppConfig, bot?: Bot) {
  const app = Fastify({ logger: true });
  await app.register(helmet);
  await registerAdminApi(app, config);
  await registerAdminUi(app);

  app.post("/api/payments/nowpayments/ipn", async (request, reply) => {
    const signatureHeader = request.headers["x-nowpayments-sig"];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    try {
      await processNowPaymentsIpn(request.body as Record<string, unknown>, signature, config);
      return { ok: true };
    } catch (error) {
      request.log.warn({ error }, "NOWPayments IPN rejected");
      return reply.code(400).send({ ok: false, error: error instanceof Error ? error.message : "invalid payment callback" });
    }
  });

  app.get("/health", async () => {
    await prisma.$queryRaw`SELECT 1`;
    await redis.ping();
    return { ok: true, service: "darvisxbot" };
  });

  if (bot) app.post(
    config.webhookPath,
    {
      preHandler: async (request, reply) => {
        if (!config.webhookSecret) return;

        const secret = request.headers["x-telegram-bot-api-secret-token"];
        if (secret !== config.webhookSecret) {
          return reply.code(401).send({ ok: false, error: "invalid webhook secret" });
        }
      }
    },
    webhookCallback(bot, "fastify")
  );

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });

  return app;
}
