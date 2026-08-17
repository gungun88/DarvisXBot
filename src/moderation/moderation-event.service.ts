import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export async function recordModerationEvent(input: {
  chatId: string;
  telegramUserId?: bigint | number | undefined;
  eventType: string;
  action: string;
  reason?: string | undefined;
  matchedPattern?: string | undefined;
  messageId?: number | undefined;
  metadata?: Prisma.InputJsonObject | undefined;
}) {
  return prisma.moderationEvent.create({
    data: {
      chatId: input.chatId,
      telegramUserId: input.telegramUserId === undefined ? null : BigInt(input.telegramUserId),
      eventType: input.eventType.slice(0, 64),
      action: input.action.slice(0, 64),
      reason: input.reason?.slice(0, 255) ?? null,
      matchedPattern: input.matchedPattern?.slice(0, 255) ?? null,
      messageId: input.messageId ?? null,
      metadata: input.metadata ?? {}
    }
  });
}
