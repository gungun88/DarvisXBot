import helmet from "@fastify/helmet";
import Fastify from "fastify";
import { webhookCallback } from "grammy";
import { createBot, registerBotCommands } from "./telegram/bot.js";
import type { AppConfig } from "./lib/config.js";
import { prisma } from "./lib/prisma.js";
import { redis } from "./lib/redis.js";
import { startScheduledMessageWorker } from "./scheduled-messages/scheduled-message.worker.js";
import { startGiveawayDrawWorker, syncActiveGiveawayDrawJobs } from "./giveaways/giveaway.worker.js";

export async function createServer(config: AppConfig) {
  const app = Fastify({ logger: true });
  await app.register(helmet);

  const bot = createBot(config);
  await registerBotCommands(bot);
  const scheduledMessageWorker = startScheduledMessageWorker(config);
  const giveawayDrawWorker = startGiveawayDrawWorker(config);
  await syncActiveGiveawayDrawJobs();

  app.get("/health", async () => {
    await prisma.$queryRaw`SELECT 1`;
    await redis.ping();
    return { ok: true, service: "darvisxbot" };
  });

  app.post(
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
    await scheduledMessageWorker.close();
    await giveawayDrawWorker.close();
    await prisma.$disconnect();
    redis.disconnect();
  });

  return app;
}
