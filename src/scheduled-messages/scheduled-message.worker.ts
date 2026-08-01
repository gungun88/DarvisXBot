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

      const telegramChatId = Number(scheduled.chat.telegramChatId);
      const previousMessageIds = content.lastMessageIds?.length
        ? content.lastMessageIds
        : content.lastMessageId
          ? [content.lastMessageId]
          : [];
      if (content.deletePrevious && previousMessageIds.length) {
        await Promise.all(previousMessageIds.map((messageId) => bot.api.deleteMessage(telegramChatId, messageId).catch(() => undefined)));
      }

      const replyMarkup = buildScheduledInlineKeyboard(scheduled.buttons);
      const sentMessages = await sendScheduledMessage(bot, telegramChatId, content, replyMarkup);
      const sent = sentMessages[sentMessages.length - 1];
      if (!sent) return;

      if (content.pin) {
        await bot.api.pinChatMessage(telegramChatId, sent.message_id, {
          disable_notification: true
        }).catch(() => undefined);
      }

      const nextRun = nextScheduledRun(repeatRule, new Date());
      if (!nextRun) {
        await prisma.scheduledMessage.update({
          where: { id: scheduled.id },
          data: {
            status: ScheduledMessageStatus.SENT,
            content: scheduledContentToJson({
              ...content,
              lastMessageId: sent.message_id,
              lastMessageIds: sentMessages.map((message) => message.message_id)
            })
          }
        });
        return;
      }

      await prisma.scheduledMessage.update({
        where: { id: scheduled.id },
        data: {
          sendAt: nextRun,
          content: scheduledContentToJson({
            ...content,
            lastMessageId: sent.message_id,
            lastMessageIds: sentMessages.map((message) => message.message_id)
          })
        }
      });
      await enqueueScheduledMessage(scheduled.id, nextRun);
    },
    { connection: redis }
  );
}

async function sendScheduledMessage(
  bot: Bot,
  chatId: number,
  content: ReturnType<typeof parseScheduledContent>,
  replyMarkup: InlineKeyboard | undefined
) {
  const mediaKind = content.mediaKind ?? (content.photoFileId ? "photo" : undefined);
  const mediaFileId = content.mediaFileId ?? content.photoFileId;
  const sent = [];

  if (mediaFileId && mediaKind === "photo") {
    sent.push(await bot.api.sendPhoto(chatId, mediaFileId, {
      ...(content.text ? { caption: content.text } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    }));
    return sent;
  }

  if (mediaFileId && mediaKind === "video") {
    sent.push(await bot.api.sendVideo(chatId, mediaFileId, {
      ...(content.text ? { caption: content.text } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    }));
    return sent;
  }

  if (mediaFileId && mediaKind === "animation") {
    sent.push(await bot.api.sendAnimation(chatId, mediaFileId, {
      ...(content.text ? { caption: content.text } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    }));
    return sent;
  }

  if (mediaFileId && mediaKind === "sticker") {
    sent.push(await bot.api.sendSticker(chatId, mediaFileId, {
      ...(!content.text && replyMarkup ? { reply_markup: replyMarkup } : {})
    }));
    if (content.text) {
      sent.push(await bot.api.sendMessage(chatId, content.text, {
        ...(replyMarkup ? { reply_markup: replyMarkup } : {})
      }));
    }
    return sent;
  }

  sent.push(await bot.api.sendMessage(chatId, content.text ?? "", {
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  }));
  return sent;
}

function buildScheduledInlineKeyboard(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return undefined;

  const keyboard = new InlineKeyboard();
  value.forEach((row, rowIndex) => {
    if (rowIndex > 0) keyboard.row();
    const buttons = Array.isArray(row) ? row : [row];
    buttons.forEach((button) => {
      if (!isRecord(button)) return;
      const text = typeof button.text === "string" ? button.text : "";
      const url = typeof button.url === "string" ? button.url : "";
      if (!text || !url) return;
      keyboard.url(text, url);
    });
  });

  return keyboard.inline_keyboard.length ? keyboard : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
