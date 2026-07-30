import type { UserFromGetMe } from "grammy/types";
import type { User as TelegramUser } from "grammy/types";
import { prisma } from "../lib/prisma.js";

type TelegramUserLike = TelegramUser | UserFromGetMe;

export async function upsertTelegramUser(user: TelegramUserLike, defaultTimezone: string) {
  return prisma.user.upsert({
    where: { telegramUserId: BigInt(user.id) },
    create: {
      telegramUserId: BigInt(user.id),
      username: user.username ?? null,
      firstName: user.first_name,
      lastName: "last_name" in user ? user.last_name ?? null : null,
      languageCode: "language_code" in user ? user.language_code ?? null : null,
      timezone: defaultTimezone
    },
    update: {
      username: user.username ?? null,
      firstName: user.first_name,
      lastName: "last_name" in user ? user.last_name ?? null : null
    }
  });
}

export async function updateUserTimezone(telegramUserId: number, timezone: string) {
  return prisma.user.update({
    where: { telegramUserId: BigInt(telegramUserId) },
    data: { timezone }
  });
}

export async function updateUserLanguage(telegramUserId: number, languageCode: string) {
  return prisma.user.update({
    where: { telegramUserId: BigInt(telegramUserId) },
    data: { languageCode }
  });
}

export async function getTelegramUserLanguageCode(telegramUserId: number) {
  const user = await prisma.user.findUnique({
    where: { telegramUserId: BigInt(telegramUserId) },
    select: { languageCode: true }
  });

  return user?.languageCode ?? null;
}
