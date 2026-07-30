import { Bot, InlineKeyboard } from "grammy";
import { Worker } from "bullmq";
import { ScheduledMessageStatus } from "@prisma/client";
import type { AppConfig } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";
import {
  enqueueScheduledMessage,
  hasScheduledMessageContent,
  nextScheduledRun,
  parseScheduledContent,
  parseScheduledRepeatRule,
  scheduledContentToJson
} from "./scheduled-message.service.js";

export function startScheduledMessageWorker(config: AppConfig) {
  const bot = new Bot(config.botToken);

  return new Worker(
    "scheduled-messages",
    async (job) => {
      const scheduledMessageId = String(job.data?.scheduledMessageId ?? "");
      if (!scheduledMessageId) return;

      const scheduled = await prisma.scheduledMessage.findUnique({
        where: { id: scheduledMessageId },
        include: { chat: true }
      });

      if (!scheduled || scheduled.status !== ScheduledMessageStatus.PENDING) return;
      if (scheduled.sendAt.getTime() > Date.now() + 1000) {
        await enqueueScheduledMessage(scheduled.id, scheduled.sendAt);
        return;
      }

      const content = parseScheduledContent(scheduled.content);
      const repeatRule = parseScheduledRepeatRule(scheduled.repeatRule);

      if (!hasScheduledMessageContent(content)) {
        await prisma.scheduledMessage.update({
          where: { id: scheduled.id },
          data: { status: ScheduledMessageStatus.DRAFT }
        });
        return;
      }

      if (content.deletePrevious && content.lastMessageId) {
        await bot.api.deleteMessage(Number(scheduled.chat.telegramChatId), content.lastMessageId).catch(() => undefined);
      }

      const replyMarkup = buildScheduledInlineKeyboard(scheduled.buttons);
      const sent = content.photoFileId
        ? await bot.api.sendPhoto(Number(scheduled.chat.telegramChatId), content.photoFileId, {
            ...(content.text ? { caption: content.text } : {}),
            ...(replyMarkup ? { reply_markup: replyMarkup } : {})
          })
        : await bot.api.sendMessage(Number(scheduled.chat.telegramChatId), content.text ?? "", {
            ...(replyMarkup ? { reply_markup: replyMarkup } : {})
          });

      if (content.pin) {
        await bot.api.pinChatMessage(Number(scheduled.chat.telegramChatId), sent.message_id, {
          disable_notification: true
        }).catch(() => undefined);
      }

      const nextRun = nextScheduledRun(repeatRule, new Date());
      if (!nextRun) {
        await prisma.scheduledMessage.update({
          where: { id: scheduled.id },
          data: {
            status: ScheduledMessageStatus.SENT,
            content: scheduledContentToJson({ ...content, lastMessageId: sent.message_id })
          }
        });
        return;
      }

      await prisma.scheduledMessage.update({
        where: { id: scheduled.id },
        data: {
          sendAt: nextRun,
          content: scheduledContentToJson({ ...content, lastMessageId: sent.message_id })
        }
      });
      await enqueueScheduledMessage(scheduled.id, nextRun);
    },
    { connection: redis }
  );
}

function buildScheduledInlineKeyboard(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return undefined;

  const keyboard = new InlineKeyboard();
  value.forEach((button, index) => {
    if (!isRecord(button)) return;
    const text = typeof button.text === "string" ? button.text : "";
    const url = typeof button.url === "string" ? button.url : "";
    if (!text || !url) return;
    if (index > 0) keyboard.row();
    keyboard.url(text, url);
  });

  return keyboard.inline_keyboard.length ? keyboard : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
