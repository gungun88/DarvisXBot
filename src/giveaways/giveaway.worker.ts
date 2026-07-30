import { Bot } from "grammy";
import { Worker } from "bullmq";
import { GiveawayStatus, Prisma } from "@prisma/client";
import type { User } from "@prisma/client";
import type { AppConfig } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";
import { enqueueGiveawayDraw } from "./giveaway.service.js";

export function startGiveawayDrawWorker(config: AppConfig) {
  const bot = new Bot(config.botToken);

  return new Worker(
    "giveaway-draws",
    async (job) => {
      const giveawayId = String(job.data?.giveawayId ?? "");
      if (!giveawayId) return;

      const giveaway = await prisma.giveaway.findUnique({
        where: { id: giveawayId },
        include: {
          chat: true,
          entries: {
            where: { isValid: true },
            include: { user: true },
            orderBy: { joinedAt: "asc" }
          }
        }
      });

      if (!giveaway || giveaway.status !== GiveawayStatus.ACTIVE) return;
      if (giveaway.drawAt.getTime() > Date.now() + 1000) {
        await enqueueGiveawayDraw(giveaway.id, giveaway.drawAt);
        return;
      }

      const winners = pickWinners(giveaway.entries, giveaway.winnersCount);
      const drawResult: Prisma.InputJsonObject = {
        drawnAt: new Date().toISOString(),
        entryCount: giveaway.entries.length,
        winnerCount: winners.length,
        winnerUserIds: winners.map((entry) => entry.userId),
        winnerTelegramUserIds: winners.map((entry) => entry.user.telegramUserId.toString())
      };

      await prisma.giveaway.update({
        where: { id: giveaway.id },
        data: {
          status: GiveawayStatus.DRAWN,
          drawResult
        }
      });

      await prisma.auditLog.create({
        data: {
          chatId: giveaway.chatId,
          action: "giveaway.drawn",
          targetType: "giveaway",
          targetId: giveaway.id,
          metadata: drawResult
        }
      });

      await bot.api.sendMessage(
        Number(giveaway.chat.telegramChatId),
        buildDrawMessage(giveaway.title, giveaway.prize, winners.map((entry) => entry.user)),
        { parse_mode: "HTML" }
      ).catch(() => undefined);
    },
    { connection: redis }
  );
}

export async function syncActiveGiveawayDrawJobs() {
  const giveaways = await prisma.giveaway.findMany({
    where: { status: GiveawayStatus.ACTIVE },
    select: { id: true, drawAt: true }
  });

  await Promise.all(giveaways.map((giveaway) => enqueueGiveawayDraw(giveaway.id, giveaway.drawAt)));
}

function pickWinners<T>(entries: T[], winnersCount: number) {
  const shuffled = [...entries];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled.slice(0, Math.max(0, Math.min(winnersCount, shuffled.length)));
}

function buildDrawMessage(title: string, prize: string, winners: User[]) {
  const header = [
    `🎁 <b>${escapeHtml(title)}</b>`,
    "",
    `奖品: <b>${escapeHtml(prize)}</b>`
  ];

  if (winners.length === 0) {
    return [...header, "", "本次抽奖没有有效参与者，已自动结束。"].join("\n");
  }

  return [
    ...header,
    "",
    "<b>中奖用户:</b>",
    ...winners.map((user, index) => `${index + 1}. ${mentionStoredUser(user)}`)
  ].join("\n");
}

function mentionStoredUser(user: User) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim()
    || user.username
    || user.telegramUserId.toString();
  return `<a href="tg://user?id=${user.telegramUserId.toString()}">${escapeHtml(name)}</a>`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
