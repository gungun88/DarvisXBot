import { Bot } from "grammy";
import { Worker } from "bullmq";
import type { AppConfig } from "../lib/config.js";
import { redis } from "../lib/redis.js";

type SignInDeleteJobData = {
  chatId?: number;
  messageId?: number;
};

export function startSignInMessageDeleteWorker(config: AppConfig) {
  const bot = new Bot(config.botToken);

  return new Worker(
    "sign-in-message-deletes",
    async (job) => {
      const data = (job.data ?? {}) as SignInDeleteJobData;
      const chatId = Number(data.chatId ?? 0);
      const messageId = Number(data.messageId ?? 0);
      if (!Number.isFinite(chatId) || !Number.isFinite(messageId) || chatId === 0 || messageId === 0) return;

      await bot.api.deleteMessage(chatId, messageId).catch((error) => {
        console.warn("Failed to delete sign-in message", {
          chatId,
          messageId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    },
    { connection: redis }
  );
}
