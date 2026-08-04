import { InlineKeyboard, type Context } from "grammy";
import type { ChatPermissions } from "grammy/types";
import { ChatStatus, Prisma, type Chat as PrismaChat } from "@prisma/client";
import type { AppConfig } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";
import { canConfigureChat, isUserChatAdmin } from "./permissions.js";

type Locale = "zh-CN" | "en";

type OpenCloseSettings = {
  enabled: boolean;
  openKeyword: string;
  openPrompt: string;
  closeKeyword: string;
  closePrompt: string;
};

type OpenCloseField = "openKeyword" | "openPrompt" | "closeKeyword" | "closePrompt";

type Draft = {
  chatId: string;
  field: OpenCloseField;
};

const settingKey = "open_close";
const selectedChatIds = new Map<number, string>();
const drafts = new Map<number, Draft>();

const defaults: OpenCloseSettings = {
  enabled: false,
  openKeyword: "上课",
  openPrompt: "上课了，业务开始交易",
  closeKeyword: "下课",
  closePrompt: "今天下课了，明天在来"
};

export function rememberSelectedOpenCloseChat(userId: number, chatId: string) {
  selectedChatIds.set(userId, chatId);
}

export async function openOpenCloseMenu(ctx: Context, _config: AppConfig, locale: Locale) {
  const chat = await selectedChat(ctx, locale);
  if (!chat) return;
  await renderMenu(ctx, menuText(await getSettings(chat.id)), menuKeyboard(await getSettings(chat.id), chat.id), "HTML");
}

export async function handleOpenCloseAction(ctx: Context, _config: AppConfig, locale: Locale, key: string) {
  if (!ctx.from) return;
  const chat = await selectedChat(ctx, locale);
  if (!chat) return;

  if (key === "noop") return;

  if (key === "toggle:on" || key === "toggle:off") {
    const enabled = key.endsWith(":on");
    const settings = await getSettings(chat.id);
    const ok = await applyOpenCloseState(ctx, chat.telegramChatId, enabled).catch(() => false);
    if (!ok) {
      await ctx.answerCallbackQuery({
        text: locale === "zh-CN" ? "切换失败，请确认机器人有修改群权限。" : "Failed to switch. Make sure the bot can manage group permissions.",
        show_alert: true
      }).catch(() => undefined);
      return;
    }
    await saveSettings(chat.id, { enabled });
    await ctx.api.sendMessage(Number(chat.telegramChatId), enabled ? settings.openPrompt : settings.closePrompt).catch(() => undefined);
    await renderMenu(ctx, menuText(await getSettings(chat.id)), menuKeyboard(await getSettings(chat.id), chat.id), "HTML");
    return;
  }

  if (key.startsWith("edit:")) {
    const field = key.replace("edit:", "");
    if (!isField(field)) return;
    drafts.set(ctx.from.id, { chatId: chat.id, field });
    await renderMenu(ctx, `请发送新的 <b>${fieldLabel(field)}</b>。`, new InlineKeyboard().text("返回", "open_close:noop"), "HTML");
    return;
  }

  await renderMenu(ctx, menuText(await getSettings(chat.id)), menuKeyboard(await getSettings(chat.id), chat.id), "HTML");
}

export async function handleOpenClosePrivateMessage(ctx: Context, _config: AppConfig, locale: Locale) {
  if (!ctx.from || !ctx.message || !("text" in ctx.message)) return false;
  const draft = drafts.get(ctx.from.id);
  if (!draft) return false;

  const value = ctx.message.text?.trim();
  if (!value) {
    await ctx.reply(locale === "zh-CN" ? "内容不能为空，请重新发送。" : "The value cannot be empty. Send it again.");
    return true;
  }

  const chat = await prisma.chat.findUnique({ where: { id: draft.chatId } });
  if (!chat || !(await ensureCanConfigureChat(ctx, chat, locale))) {
    drafts.delete(ctx.from.id);
    return true;
  }

  await saveSettings(draft.chatId, { [draft.field]: value });
  drafts.delete(ctx.from.id);
  const settings = await getSettings(draft.chatId);
  await ctx.reply(menuText(settings), { parse_mode: "HTML", reply_markup: menuKeyboard(settings, draft.chatId) });
  return true;
}

export async function handleOpenCloseGroupMessage(ctx: Context) {
  if (!ctx.from || ctx.from.is_bot || !ctx.chat || ctx.chat.type === "private" || !ctx.message || !("text" in ctx.message)) return false;
  const text = ctx.message.text?.trim();
  if (!text || text.startsWith("/")) return false;

  const chat = await prisma.chat.findFirst({
    where: { telegramChatId: BigInt(ctx.chat.id), status: ChatStatus.ACTIVE }
  });
  if (!chat) return false;

  const settings = await getSettings(chat.id);
  const enabled = text === settings.openKeyword ? true : text === settings.closeKeyword ? false : null;
  if (enabled === null) return false;

  const admin = await isUserChatAdmin(ctx, ctx.chat.id, ctx.from.id).catch(() => false);
  if (!admin) return false;

  const ok = await applyOpenCloseState(ctx, chat.telegramChatId, enabled).catch(() => false);
  if (!ok) return false;
  await saveSettings(chat.id, { enabled });
  await ctx.reply(enabled ? settings.openPrompt : settings.closePrompt);
  return true;
}

async function selectedChat(ctx: Context, locale: Locale) {
  if (!ctx.from) return null;
  const chatId = selectedChatIds.get(ctx.from.id);
  if (!chatId) {
    await renderMenu(ctx, locale === "zh-CN" ? "请先选择要设置的群组。" : "Choose a group first.", homeKeyboard(locale));
    return null;
  }

  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!chat || chat.type === "CHANNEL" || chat.type === "PRIVATE") {
    selectedChatIds.delete(ctx.from.id);
    await renderMenu(ctx, locale === "zh-CN" ? "未找到这个已绑定群组。" : "That bound group was not found.", homeKeyboard(locale));
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

async function getSettings(chatId: string): Promise<OpenCloseSettings> {
  const row = await prisma.setting.findUnique({ where: { chatId_key: { chatId, key: settingKey } }, select: { value: true } });
  if (!row || !isRecord(row.value)) return { ...defaults };
  return {
    enabled: typeof row.value.enabled === "boolean" ? row.value.enabled : defaults.enabled,
    openKeyword: textSetting(row.value.openKeyword, defaults.openKeyword),
    openPrompt: textSetting(row.value.openPrompt, defaults.openPrompt),
    closeKeyword: textSetting(row.value.closeKeyword, defaults.closeKeyword),
    closePrompt: textSetting(row.value.closePrompt, defaults.closePrompt)
  };
}

async function saveSettings(chatId: string, patch: Partial<OpenCloseSettings>) {
  const next = { ...await getSettings(chatId), ...patch };
  const value = next as unknown as Prisma.InputJsonObject;
  await prisma.setting.upsert({ where: { chatId_key: { chatId, key: settingKey } }, create: { chatId, key: settingKey, value }, update: { value } });
}

function menuText(settings: OpenCloseSettings) {
  return [
    "🔐 <b>开关群</b>",
    "",
    "手动开启或关闭 <b>全员禁言</b> 并设置自定义提示语",
    "",
    `<b>状态：</b> ${settings.enabled ? "开启" : "关闭"}`,
    "",
    `<b>开群关键词：</b> <code>${escapeHtml(settings.openKeyword)}</code>`,
    `<b>开群提示：</b> <code>${escapeHtml(settings.openPrompt)}</code>`,
    "",
    `<b>关群关键词：</b> <code>${escapeHtml(settings.closeKeyword)}</code>`,
    `<b>关群提示：</b> <code>${escapeHtml(settings.closePrompt)}</code>`
  ].join("\n");
}

function menuKeyboard(settings: OpenCloseSettings, chatId: string) {
  void chatId;
  return new InlineKeyboard()
    .text("状态:", "open_close:noop")
    .text(settings.enabled ? "✅开启" : "开启", "open_close:toggle:on")
    .text(!settings.enabled ? "✅关闭" : "关闭", "open_close:toggle:off")
    .row()
    .text("开群关键词", "open_close:edit:openKeyword")
    .row()
    .text("开群提示", "open_close:edit:openPrompt")
    .row()
    .text("关群关键词", "open_close:edit:closeKeyword")
    .row()
    .text("关群提示", "open_close:edit:closePrompt")
    .row()
    .text("返回", "menu:home");
}

function openPermissions(): ChatPermissions {
  return {
    can_send_messages: true,
    can_send_audios: true,
    can_send_documents: true,
    can_send_photos: true,
    can_send_videos: true,
    can_send_video_notes: true,
    can_send_voice_notes: true,
    can_send_polls: true,
    can_send_other_messages: true,
    can_add_web_page_previews: true,
    can_change_info: false,
    can_invite_users: true,
    can_pin_messages: false,
    can_manage_topics: false
  };
}

function closedPermissions(): ChatPermissions {
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
    can_add_web_page_previews: false,
    can_change_info: false,
    can_invite_users: false,
    can_pin_messages: false,
    can_manage_topics: false
  };
}

async function applyOpenCloseState(ctx: Context, chatId: PrismaChat["telegramChatId"], enabled: boolean) {
  const permissions = enabled ? openPermissions() : closedPermissions();
  await ctx.api.setChatPermissions(Number(chatId), permissions);
  return true;
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
  return new InlineKeyboard().text(locale === "zh-CN" ? "返回首页" : "Home", "menu:home");
}

function isField(value: string): value is OpenCloseField {
  return value === "openKeyword" || value === "openPrompt" || value === "closeKeyword" || value === "closePrompt";
}

function fieldLabel(field: OpenCloseField) {
  return ({ openKeyword: "开群关键词", openPrompt: "开群提示", closeKeyword: "关群关键词", closePrompt: "关群提示" } as const)[field];
}

function textSetting(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
