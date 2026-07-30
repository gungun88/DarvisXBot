import type { Chat as TelegramChat } from "grammy/types";
import { ChatStatus, ChatType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export async function bindTelegramChat(
  chat: TelegramChat,
  ownerUserId: string | undefined,
  defaultTimezone: string
) {
  const title = "title" in chat ? chat.title ?? null : null;
  const username = "username" in chat ? chat.username ?? null : null;

  const savedChat = await prisma.chat.upsert({
    where: { telegramChatId: BigInt(chat.id) },
    create: {
      telegramChatId: BigInt(chat.id),
      type: mapTelegramChatType(chat.type),
      title,
      username,
      timezone: defaultTimezone,
      ...(ownerUserId ? { owner: { connect: { id: ownerUserId } } } : {})
    },
    update: {
      type: mapTelegramChatType(chat.type),
      title,
      username,
      status: ChatStatus.ACTIVE,
      ...(ownerUserId ? { owner: { connect: { id: ownerUserId } } } : {})
    }
  });

  if (ownerUserId) {
    await prisma.chatAdmin.upsert({
      where: {
        chatId_userId: {
          chatId: savedChat.id,
          userId: ownerUserId
        }
      },
      create: {
        chatId: savedChat.id,
        userId: ownerUserId,
        role: "administrator",
        permissions: {}
      },
      update: {
        role: "administrator"
      }
    });
  }

  return savedChat;
}

export async function deactivateTelegramChat(telegramChatId: number) {
  return prisma.chat.updateMany({
    where: { telegramChatId: BigInt(telegramChatId) },
    data: { status: ChatStatus.DISABLED }
  });
}

export function mapTelegramChatType(type: TelegramChat["type"]) {
  switch (type) {
    case "group":
      return ChatType.GROUP;
    case "supergroup":
      return ChatType.SUPERGROUP;
    case "channel":
      return ChatType.CHANNEL;
    case "private":
      return ChatType.PRIVATE;
  }
}

export async function listManagedChats(ownerUserId: string) {
  return prisma.chat.findMany({
    where: {
      status: ChatStatus.ACTIVE,
      OR: [
        { ownerUserId },
        {
          admins: {
            some: { userId: ownerUserId }
          }
        }
      ]
    },
    orderBy: { updatedAt: "desc" },
    take: 20
  });
}
