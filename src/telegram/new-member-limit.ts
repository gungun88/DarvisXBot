import { ChatStatus, Prisma, type Chat as PrismaChat } from "@prisma/client";
import { InlineKeyboard, type Context } from "grammy";
import type { ChatPermissions, User } from "grammy/types";
import type { AppConfig } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";
import { canConfigureChat } from "./permissions.js";

type Locale = "zh-CN" | "en";

type NewMemberLimitSettings = {
  enabled: boolean;
  durationMinutes: number;
};

type DurationDraft = {
  chatId: string;
};

const newMemberLimitSettingKey = "new_member_limit";
const defaultDurationMinutes = 1;
const minDurationMinutes = 1;
const maxDurationMinutes = 30 * 24 * 60;

const selectedChatIds = new Map<number, string>();
const durationDrafts = new Map<number, DurationDraft>();

export function rememberSelectedNewMemberLimitChat(userId: number, chatId: string) {
  selectedChatIds.set(userId, chatId);
}

export async function openNewMemberLimitMenu(ctx: Context, _config: AppConfig, locale: Locale) {
  const chat = await getSelectedGroupChat(ctx, locale);
  if (!chat) return;
  await renderNewMemberLimitMenu(ctx, locale, chat);
}

export async function handleNewMemberLimitAction(ctx: Context, _config: AppConfig, locale: Locale, key: string) {
  if (!ctx.from) return;

  const chat = await getSelectedGroupChat(ctx, locale);
  if (!chat) return;

  if (key === "noop") return;

  if (key === "back") {
    await renderNewMemberLimitMenu(ctx, locale, chat);
    return;
  }

  if (key === "toggle:on") {
    await saveNewMemberLimitSettings(chat.id, { enabled: true });
    await renderNewMemberLimitMenu(ctx, locale, chat);
    return;
  }

  if (key === "toggle:off") {
    await saveNewMemberLimitSettings(chat.id, { enabled: false });
    await renderNewMemberLimitMenu(ctx, locale, chat);
    return;
  }

  if (key === "duration") {
    durationDrafts.set(ctx.from.id, { chatId: chat.id });
    await renderMenu(
      ctx,
      locale === "zh-CN"
        ? [
            "<b>请发送禁言时长</b>",
            "",
            "支持格式：10、10分钟、2小时、1天、10m、2h、1d",
            "范围：1 分钟 - 30 天"
          ].join("\n")
        : [
            "<b>Send the mute duration</b>",
            "",
            "Supported: 1m, 10m, 2h, 1d, 1 minute, 2 hours",
            "Range: 1 minute - 30 days"
          ].join("\n"),
      new InlineKeyboard().text(locale === "zh-CN" ? "返回" : "Back", "new_member_limit:back"),
      "HTML"
    );
    return;
  }

  await renderNewMemberLimitMenu(ctx, locale, chat);
}

export async function handleNewMemberLimitPrivateMessage(ctx: Context, _config: AppConfig, locale: Locale) {
  if (!ctx.from || !ctx.message) return false;
  const draft = durationDrafts.get(ctx.from.id);
  if (!draft) return false;

  const text = "text" in ctx.message ? ctx.message.text?.trim() : undefined;
  const durationMinutes = text ? parseDurationMinutes(text) : null;
  if (!durationMinutes) {
    await ctx.reply(
      locale === "zh-CN"
        ? "格式不正确。请发送 10、10分钟、2小时、1天、10m、2h 或 1d。"
        : "Invalid duration. Send 10, 10m, 2h, 1d, 10 minutes, or 2 hours."
    );
    return true;
  }

  const chat = await prisma.chat.findUnique({ where: { id: draft.chatId } });
  durationDrafts.delete(ctx.from.id);
  if (!chat) {
    await ctx.reply(locale === "zh-CN" ? "未找到这个已绑定群组。" : "That bound group was not found.");
    return true;
  }

  if (!(await ensureCanConfigureChat(ctx, chat, locale))) {
    durationDrafts.delete(ctx.from.id);
    return true;
  }

  await saveNewMemberLimitSettings(chat.id, { durationMinutes });
  await ctx.reply(await buildNewMemberLimitMessage(locale, chat), {
    parse_mode: "HTML",
    reply_markup: newMemberLimitKeyboard(locale, await getNewMemberLimitSettings(chat.id))
  });
  return true;
}

export async function handleNewMemberLimitNewChatMembers(ctx: Context) {
  if (!ctx.chat || ctx.chat.type === "private" || !ctx.message) return;
  const telegramChatId = ctx.chat.id;
  const message = ctx.message as { new_chat_members?: User[] };
  const newMembers = message.new_chat_members;
  if (!newMembers?.length) return;

  const chat = await prisma.chat.findFirst({
    where: { telegramChatId: BigInt(telegramChatId), status: ChatStatus.ACTIVE },
    include: { settings: { where: { key: newMemberLimitSettingKey }, take: 1 } }
  });
  if (!chat) return;

  const settings = parseNewMemberLimitSettings(chat.settings[0]?.value);
  if (!settings.enabled) return;

  const untilDate = Math.floor((Date.now() + settings.durationMinutes * 60_000) / 1000);
  await Promise.all(
    newMembers
      .filter((member) => !member.is_bot)
      .map((member) =>
        ctx.api.restrictChatMember(telegramChatId, member.id, mutedChatPermissions(), { until_date: untilDate }).catch(() => undefined)
      )
  );
}

async function renderNewMemberLimitMenu(ctx: Context, locale: Locale, chat: PrismaChat) {
  await renderMenu(ctx, await buildNewMemberLimitMessage(locale, chat), newMemberLimitKeyboard(locale, await getNewMemberLimitSettings(chat.id)), "HTML");
}

async function getSelectedGroupChat(ctx: Context, locale: Locale) {
  if (!ctx.from) return null;
  const chatId = selectedChatIds.get(ctx.from.id);
  if (!chatId) {
    await renderMenu(ctx, locale === "zh-CN" ? "请先选择要设置的群组。" : "Choose a group first.", homeKeyboard(locale));
    return null;
  }

  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!chat) {
    selectedChatIds.delete(ctx.from.id);
    await renderMenu(ctx, locale === "zh-CN" ? "未找到这个已绑定群组。" : "That bound group was not found.", homeKeyboard(locale));
    return null;
  }

  if (chat.type === "CHANNEL") {
    await renderMenu(ctx, locale === "zh-CN" ? "新成员限制仅支持群组。" : "New member limits are only supported in groups.", homeKeyboard(locale));
    return null;
  }

  if (!(await ensureCanConfigureChat(ctx, chat, locale))) return null;

  return chat;
}

async function ensureCanConfigureChat(ctx: Context, chat: PrismaChat, locale: Locale) {
  if (!ctx.from) return false;
  const allowed = await canConfigureChat(ctx, chat, ctx.from.id).catch(() => false);
  if (allowed) return true;

  const text = locale === "zh-CN"
    ? "只有符合控制权限的管理员可以设置机器人。"
    : "Only permitted admins can configure the bot.";
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text, show_alert: true }).catch(() => undefined);
  } else {
    await ctx.reply(text).catch(() => undefined);
  }
  return false;
}

async function getNewMemberLimitSettings(chatId: string) {
  const record = await prisma.setting.findUnique({ where: { chatId_key: { chatId, key: newMemberLimitSettingKey } } });
  return parseNewMemberLimitSettings(record?.value);
}

async function saveNewMemberLimitSettings(chatId: string, patch: Partial<NewMemberLimitSettings>) {
  const existing = await prisma.setting.findUnique({ where: { chatId_key: { chatId, key: newMemberLimitSettingKey } } });
  const next = { ...parseNewMemberLimitSettings(existing?.value), ...patch };
  await prisma.setting.upsert({
    where: { chatId_key: { chatId, key: newMemberLimitSettingKey } },
    create: { chatId, key: newMemberLimitSettingKey, value: next as Prisma.InputJsonValue },
    update: { value: next as Prisma.InputJsonValue }
  });
  return next;
}

export function parseNewMemberLimitSettings(value: unknown): NewMemberLimitSettings {
  if (!isRecord(value)) return defaultNewMemberLimitSettings();
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : false,
    durationMinutes: normalizeDurationMinutes(value.durationMinutes)
  };
}

function defaultNewMemberLimitSettings(): NewMemberLimitSettings {
  return { enabled: false, durationMinutes: defaultDurationMinutes };
}

async function buildNewMemberLimitMessage(locale: Locale, chat: PrismaChat) {
  const settings = await getNewMemberLimitSettings(chat.id);
  if (locale !== "zh-CN") {
    return [
      "🔒 <b>New Member Limit</b>",
      "",
      "Temporarily mute new members after they join.",
      "",
      `<b>Status</b>: ${settings.enabled ? "On✅" : "Off❌"}`,
      `<b>Mute duration</b>: ${formatDuration(locale, settings.durationMinutes)}`
    ].join("\n");
  }

  return [
    "🔒 <b>新成员限制</b>",
    "",
    "限制新成员禁止发言多久",
    "",
    `<b>状态</b>: ${settings.enabled ? "开启✅" : "关闭❌"}`,
    `<b>禁言时长</b>: ${formatDuration(locale, settings.durationMinutes)}`
  ].join("\n");
}

function newMemberLimitKeyboard(locale: Locale, settings: NewMemberLimitSettings) {
  const onText = locale === "zh-CN" ? "开启" : "On";
  const offText = locale === "zh-CN" ? "关闭" : "Off";
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "状态:" : "Status:", "new_member_limit:noop")
    .text(settings.enabled ? `✅${onText}` : onText, "new_member_limit:toggle:on")
    .text(!settings.enabled ? `✅${offText}` : offText, "new_member_limit:toggle:off")
    .row()
    .text(locale === "zh-CN" ? "⚙️ 设置禁言时长" : "⚙️ Set mute duration", "new_member_limit:duration")
    .row()
    .text(locale === "zh-CN" ? "🏠 返回首页" : "🏠 Home", "menu:home");
}

function mutedChatPermissions(): ChatPermissions {
  return {
    can_send_messages: false,
    can_send_audios: false,
    can_send_documents: false,
    can_send_photos: false,
    can_send_videos: false,
    can_send_video_notes: false,
    can_send_voice_notes: false,
    can_send_polls: false,
    can_send_other_messages: false,
    can_add_web_page_previews: false
  };
}

export function parseDurationMinutes(input: string) {
  const text = input.trim().toLowerCase().replace(/\s+/g, "");
  const match = text.match(/^(\d+)(分钟|分|单位\/?分钟|小时|时|天|日|minute|minutes|min|m|hour|hours|h|day|days|d)?$/i);
  if (!match) return null;

  const amountText = match[1];
  const rawUnit = match[2] ?? "分钟";
  if (!amountText) return null;
  const amount = Number(amountText);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;

  const unit = rawUnit.toLowerCase();
  const multiplier = unit === "天" || unit === "日" || unit === "day" || unit === "days" || unit === "d"
    ? 24 * 60
    : unit === "小时" || unit === "时" || unit === "hour" || unit === "hours" || unit === "h"
      ? 60
      : 1;

  return normalizeDurationMinutes(amount * multiplier);
}

function normalizeDurationMinutes(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultDurationMinutes;
  const minutes = Math.round(value);
  return Math.min(maxDurationMinutes, Math.max(minDurationMinutes, minutes));
}

export function formatDuration(locale: Locale, minutes: number) {
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return locale === "zh-CN" ? `${days} 天` : `${days} day${days === 1 ? "" : "s"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return locale === "zh-CN" ? `${hours} 小时` : `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return locale === "zh-CN" ? `${minutes} 分钟` : `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

async function renderMenu(ctx: Context, text: string, replyMarkup: InlineKeyboard, parseMode?: "HTML") {
  const options = parseMode ? { parse_mode: parseMode, reply_markup: replyMarkup } : { reply_markup: replyMarkup };
  try {
    await ctx.editMessageText(text, options as never);
  } catch {
    await ctx.reply(text, options as never);
  }
}

function homeKeyboard(locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "🏠 首页" : "🏠 Home", "menu:home");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
