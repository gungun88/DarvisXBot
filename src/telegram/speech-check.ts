import { ChatStatus, Prisma, type Chat as PrismaChat } from "@prisma/client";
import { InlineKeyboard, type Context } from "grammy";
import type { ChatPermissions, User } from "grammy/types";
import { prisma } from "../lib/prisma.js";
import { canConfigureChat, isUserChatAdmin } from "./permissions.js";

type Locale = "zh-CN" | "en";

type SpeechCheckInputField = "forbidden_names" | "punishment" | "notice_delete" | "required_channel";

type SpeechCheckSettings = {
  requireLastName: boolean;
  requireUsername: boolean;
  requireAvatar: boolean;
  requireChannelSubscription: boolean;
  requiredChannel: string;
  forbiddenNameKeywords: string[];
  punishmentMinutes: number;
  noticeDeleteSeconds: number;
};

type SpeechCheckDraft = {
  chatId: string;
  field: SpeechCheckInputField;
};

const speechCheckSettingKey = "speech_check";
const defaultPunishmentMinutes = 10;
const minPunishmentMinutes = 1;
const maxPunishmentMinutes = 30 * 24 * 60;
const defaultNoticeDeleteSeconds = 600;
const minNoticeDeleteSeconds = 0;
const maxNoticeDeleteSeconds = 24 * 60 * 60;
const selectedChatIds = new Map<number, string>();
const inputDrafts = new Map<number, SpeechCheckDraft>();
const avatarCache = new Map<number, { hasAvatar: boolean; expiresAt: number }>();
const subscriptionCache = new Map<string, { subscribed: boolean; expiresAt: number }>();

export function rememberSelectedSpeechCheckChat(userId: number, chatId: string) {
  selectedChatIds.set(userId, chatId);
}

export function clearSpeechCheckDraft(userId: number) {
  inputDrafts.delete(userId);
}

export async function openSpeechCheckMenu(ctx: Context, locale: Locale) {
  const chat = await getSelectedGroupChat(ctx, locale);
  if (!chat) return;
  await renderSpeechCheckMenu(ctx, locale, chat);
}

export async function handleSpeechCheckAction(ctx: Context, locale: Locale, key: string) {
  if (!ctx.from) return;

  const chat = await getSelectedGroupChat(ctx, locale);
  if (!chat) return;

  if (key === "noop") return;

  const settings = await getSpeechCheckSettings(chat.id);

  if (key === "back") {
    await renderSpeechCheckMenu(ctx, locale, chat);
    return;
  }

  if (key === "toggle:last_name") {
    await saveSpeechCheckSettings(chat.id, { requireLastName: !settings.requireLastName });
    await renderSpeechCheckMenu(ctx, locale, chat);
    return;
  }

  if (key === "toggle:username") {
    await saveSpeechCheckSettings(chat.id, { requireUsername: !settings.requireUsername });
    await renderSpeechCheckMenu(ctx, locale, chat);
    return;
  }

  if (key === "toggle:avatar") {
    await saveSpeechCheckSettings(chat.id, { requireAvatar: !settings.requireAvatar });
    await renderSpeechCheckMenu(ctx, locale, chat);
    return;
  }

  if (key === "channel") {
    if (settings.requiredChannel) {
      await saveSpeechCheckSettings(chat.id, { requireChannelSubscription: !settings.requireChannelSubscription });
      await renderSpeechCheckMenu(ctx, locale, chat);
      return;
    }

    inputDrafts.set(ctx.from.id, { chatId: chat.id, field: "required_channel" });
    await renderMenu(ctx, speechCheckInputPrompt("required_channel", settings, locale), inputBackKeyboard(locale), "HTML");
    return;
  }

  if (key === "channel:set") {
    inputDrafts.set(ctx.from.id, { chatId: chat.id, field: "required_channel" });
    await renderMenu(ctx, speechCheckInputPrompt("required_channel", settings, locale), inputBackKeyboard(locale), "HTML");
    return;
  }

  if (key === "forbidden_names") {
    inputDrafts.set(ctx.from.id, { chatId: chat.id, field: "forbidden_names" });
    await renderMenu(ctx, speechCheckInputPrompt("forbidden_names", settings, locale), inputBackKeyboard(locale), "HTML");
    return;
  }

  if (key === "punishment") {
    inputDrafts.set(ctx.from.id, { chatId: chat.id, field: "punishment" });
    await renderMenu(ctx, speechCheckInputPrompt("punishment", settings, locale), inputBackKeyboard(locale), "HTML");
    return;
  }

  if (key === "notice_delete") {
    inputDrafts.set(ctx.from.id, { chatId: chat.id, field: "notice_delete" });
    await renderMenu(ctx, speechCheckInputPrompt("notice_delete", settings, locale), inputBackKeyboard(locale), "HTML");
    return;
  }

  await renderSpeechCheckMenu(ctx, locale, chat);
}

export async function handleSpeechCheckPrivateMessage(ctx: Context, locale: Locale) {
  if (!ctx.from || !ctx.message) return false;
  const draft = inputDrafts.get(ctx.from.id);
  if (!draft) return false;

  const text = "text" in ctx.message ? ctx.message.text?.trim() : undefined;
  if (typeof text !== "string") {
    await ctx.reply(locale === "zh-CN" ? "请发送文本内容。" : "Send text content.");
    return true;
  }

  const chat = await prisma.chat.findUnique({ where: { id: draft.chatId } });
  if (!chat) {
    inputDrafts.delete(ctx.from.id);
    await ctx.reply(locale === "zh-CN" ? "未找到这个已绑定群组。" : "That bound group was not found.");
    return true;
  }

  if (!(await ensureCanConfigureChat(ctx, chat, locale))) {
    inputDrafts.delete(ctx.from.id);
    return true;
  }

  const patch = parseSpeechCheckInput(draft.field, text, locale);
  if (!patch.ok) {
    await ctx.reply(patch.message);
    return true;
  }

  inputDrafts.delete(ctx.from.id);
  await saveSpeechCheckSettings(chat.id, patch.value);
  await ctx.reply(buildSpeechCheckMessage(locale, await getSpeechCheckSettings(chat.id)), {
    parse_mode: "HTML",
    reply_markup: speechCheckKeyboard(locale, chat, await getSpeechCheckSettings(chat.id))
  });
  return true;
}

export async function handleSpeechCheckMessage(ctx: Context, locale: Locale) {
  if (!ctx.chat || ctx.chat.type === "private" || !ctx.message || !ctx.from) return false;
  if (ctx.from.is_bot) return false;

  const chat = await prisma.chat.findFirst({
    where: { telegramChatId: BigInt(ctx.chat.id), status: ChatStatus.ACTIVE },
    include: { settings: { where: { key: speechCheckSettingKey }, take: 1 } }
  });
  if (!chat) return false;

  const settings = parseSpeechCheckSettings(chat.settings[0]?.value);
  if (!hasEnabledSpeechCheckRule(settings)) return false;

  const isAdmin = await isUserChatAdmin(ctx, ctx.chat.id, ctx.from.id).catch(() => false);
  if (isAdmin) return false;

  const reasons = await findSpeechCheckFailures(ctx, ctx.from, settings);
  if (!reasons.length) return false;

  await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => undefined);
  await applySpeechCheckPunishment(ctx, ctx.chat.id, ctx.from.id, settings);

  const notice = await ctx.reply(buildViolationNotice(ctx.from, reasons, settings, locale), { parse_mode: "HTML" }).catch(() => null);
  if (notice && settings.noticeDeleteSeconds > 0) {
    setTimeout(() => {
      void ctx.api.deleteMessage(notice.chat.id, notice.message_id).catch(() => undefined);
    }, settings.noticeDeleteSeconds * 1000);
  }

  return true;
}

async function renderSpeechCheckMenu(ctx: Context, locale: Locale, chat: PrismaChat) {
  const settings = await getSpeechCheckSettings(chat.id);
  await renderMenu(ctx, buildSpeechCheckMessage(locale, settings), speechCheckKeyboard(locale, chat, settings), "HTML");
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
    await renderMenu(ctx, locale === "zh-CN" ? "发言检查仅支持群组。" : "Speech check is only supported in groups.", homeKeyboard(locale));
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

async function getSpeechCheckSettings(chatId: string) {
  const record = await prisma.setting.findUnique({ where: { chatId_key: { chatId, key: speechCheckSettingKey } } });
  return parseSpeechCheckSettings(record?.value);
}

async function saveSpeechCheckSettings(chatId: string, patch: Partial<SpeechCheckSettings>) {
  const existing = await prisma.setting.findUnique({ where: { chatId_key: { chatId, key: speechCheckSettingKey } } });
  const next = { ...parseSpeechCheckSettings(existing?.value), ...patch };
  await prisma.setting.upsert({
    where: { chatId_key: { chatId, key: speechCheckSettingKey } },
    create: { chatId, key: speechCheckSettingKey, value: speechCheckSettingsToJson(next) },
    update: { value: speechCheckSettingsToJson(next) }
  });
  return next;
}

function parseSpeechCheckSettings(value: unknown): SpeechCheckSettings {
  if (!isRecord(value)) return defaultSpeechCheckSettings();
  return {
    requireLastName: typeof value.requireLastName === "boolean" ? value.requireLastName : false,
    requireUsername: typeof value.requireUsername === "boolean" ? value.requireUsername : false,
    requireAvatar: typeof value.requireAvatar === "boolean" ? value.requireAvatar : false,
    requireChannelSubscription: typeof value.requireChannelSubscription === "boolean" ? value.requireChannelSubscription : false,
    requiredChannel: typeof value.requiredChannel === "string" ? value.requiredChannel.trim() : "",
    forbiddenNameKeywords: normalizeForbiddenNameKeywords(value.forbiddenNameKeywords),
    punishmentMinutes: normalizePunishmentMinutes(value.punishmentMinutes),
    noticeDeleteSeconds: normalizeNoticeDeleteSeconds(value.noticeDeleteSeconds)
  };
}

function defaultSpeechCheckSettings(): SpeechCheckSettings {
  return {
    requireLastName: false,
    requireUsername: false,
    requireAvatar: false,
    requireChannelSubscription: false,
    requiredChannel: "",
    forbiddenNameKeywords: [],
    punishmentMinutes: defaultPunishmentMinutes,
    noticeDeleteSeconds: defaultNoticeDeleteSeconds
  };
}

function speechCheckSettingsToJson(settings: SpeechCheckSettings): Prisma.InputJsonObject {
  return {
    requireLastName: settings.requireLastName,
    requireUsername: settings.requireUsername,
    requireAvatar: settings.requireAvatar,
    requireChannelSubscription: settings.requireChannelSubscription,
    requiredChannel: settings.requiredChannel,
    forbiddenNameKeywords: settings.forbiddenNameKeywords,
    punishmentMinutes: settings.punishmentMinutes,
    noticeDeleteSeconds: settings.noticeDeleteSeconds
  };
}

function buildSpeechCheckMessage(locale: Locale, settings: SpeechCheckSettings) {
  if (locale !== "zh-CN") {
    return [
      "🔦 <b>Speech Check</b>",
      "",
      "Checks and blocks messages when users send them.",
      "",
      `<b>Punishment:</b> Mute ${formatDuration(locale, settings.punishmentMinutes)}`,
      `<b>Delete notice:</b> ${settings.noticeDeleteSeconds} seconds`,
      settings.requireChannelSubscription && settings.requiredChannel ? `<b>Required channel:</b> <code>${escapeHtml(settings.requiredChannel)}</code>` : "",
      settings.forbiddenNameKeywords.length ? `<b>Name forbidden contains:</b> ${settings.forbiddenNameKeywords.map(escapeHtml).join(", ")}` : ""
    ].filter(Boolean).join("\n");
  }

  return [
    "🔦 <b>发言检查</b>",
    "",
    "在用户发送消息时进行检查和屏蔽。",
    "",
    `<b>惩罚:</b> 禁言${formatDuration(locale, settings.punishmentMinutes)}`,
    `<b>删除提醒:</b> ${settings.noticeDeleteSeconds} 秒`,
    settings.requireChannelSubscription && settings.requiredChannel ? `<b>订阅频道:</b> <code>${escapeHtml(settings.requiredChannel)}</code>` : "",
    settings.forbiddenNameKeywords.length ? `<b>昵称禁止包含:</b> ${settings.forbiddenNameKeywords.map(escapeHtml).join("、")}` : ""
  ].filter(Boolean).join("\n");
}

function speechCheckKeyboard(locale: Locale, chat: PrismaChat, settings: SpeechCheckSettings) {
  const mark = (enabled: boolean, text: string) => `${enabled ? "✅" : "❌"}${text}`;
  const scope = chat.type === "CHANNEL" ? "channel" : "group";
  return new InlineKeyboard()
    .text(mark(settings.requireLastName, locale === "zh-CN" ? "必须设置姓氏" : "Require last name"), "speech_check:toggle:last_name")
    .row()
    .text(mark(settings.requireUsername, locale === "zh-CN" ? "必须设置用户名" : "Require username"), "speech_check:toggle:username")
    .row()
    .text(mark(settings.requireAvatar, locale === "zh-CN" ? "必须设置头像" : "Require avatar"), "speech_check:toggle:avatar")
    .row()
    .text(mark(settings.requireChannelSubscription, locale === "zh-CN" ? "必须订阅频道" : "Require channel subscription"), "speech_check:channel")
    .row()
    .text(locale === "zh-CN" ? "🈲昵称禁止包含" : "🈲Name forbidden contains", "speech_check:forbidden_names")
    .row()
    .text(locale === "zh-CN" ? "🚷惩罚" : "🚷Punishment", "speech_check:punishment")
    .text(locale === "zh-CN" ? "♻️删除提醒" : "♻️Delete notice", "speech_check:notice_delete")
    .row()
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `menu:chat:${scope}:${chat.id}`);
}

function speechCheckInputPrompt(field: SpeechCheckInputField, settings: SpeechCheckSettings, locale: Locale) {
  if (field === "required_channel") {
    return locale === "zh-CN"
      ? [
          "<b>请发送必须订阅的频道</b>",
          "",
          "支持格式：<code>@channel_username</code> 或 <code>-1001234567890</code>",
          "Bot 需要能读取该频道/群组成员状态。",
          "",
          `当前：<code>${escapeHtml(settings.requiredChannel || "-")}</code>`
        ].join("\n")
      : [
          "<b>Send the required channel</b>",
          "",
          "Supported: <code>@channel_username</code> or <code>-1001234567890</code>.",
          "The bot must be able to read membership in that channel/group.",
          "",
          `Current: <code>${escapeHtml(settings.requiredChannel || "-")}</code>`
        ].join("\n");
  }

  if (field === "forbidden_names") {
    return locale === "zh-CN"
      ? [
          "<b>请发送昵称禁止包含的关键词</b>",
          "",
          "多个关键词用换行、逗号或空格分隔。发送 <code>clear</code> 清空。",
          "",
          `当前：<code>${escapeHtml(settings.forbiddenNameKeywords.join(", ") || "-")}</code>`
        ].join("\n")
      : [
          "<b>Send forbidden name keywords</b>",
          "",
          "Separate multiple keywords with new lines, commas, or spaces. Send <code>clear</code> to clear.",
          "",
          `Current: <code>${escapeHtml(settings.forbiddenNameKeywords.join(", ") || "-")}</code>`
        ].join("\n");
  }

  if (field === "punishment") {
    return locale === "zh-CN"
      ? [
          "<b>请发送禁言时长</b>",
          "",
          "支持格式：<code>10分钟</code>、<code>1小时</code>、<code>1天</code>、<code>10m</code>、<code>1h</code>、<code>1d</code>",
          "范围：1 分钟 - 30 天。",
          "",
          `当前：禁言${formatDuration(locale, settings.punishmentMinutes)}`
        ].join("\n")
      : [
          "<b>Send the mute duration</b>",
          "",
          "Supported: <code>10m</code>, <code>1h</code>, <code>1d</code>, <code>10 minutes</code>.",
          "Range: 1 minute - 30 days.",
          "",
          `Current: mute ${formatDuration(locale, settings.punishmentMinutes)}`
        ].join("\n");
  }

  return locale === "zh-CN"
    ? [
        "<b>请发送提醒删除时间</b>",
        "",
        "单位为秒，也支持 <code>10分钟</code>、<code>1小时</code>、<code>10m</code>、<code>1h</code>。",
        "发送 <code>0</code> 表示不自动删除提醒。",
        "",
        `当前：${settings.noticeDeleteSeconds} 秒`
      ].join("\n")
    : [
        "<b>Send notice deletion time</b>",
        "",
        "Use seconds, or duration like <code>10m</code>, <code>1h</code>. Send <code>0</code> to keep notices.",
        "",
        `Current: ${settings.noticeDeleteSeconds} seconds`
      ].join("\n");
}

function parseSpeechCheckInput(field: SpeechCheckInputField, text: string, locale: Locale):
  | { ok: true; value: Partial<SpeechCheckSettings> }
  | { ok: false; message: string } {
  if (field === "required_channel") {
    const channel = normalizeRequiredChannel(text);
    if (!channel) {
      return { ok: false, message: locale === "zh-CN" ? "频道格式不正确，请发送 @username 或 -100 开头的频道 ID。" : "Invalid channel. Send @username or a -100 channel ID." };
    }
    return { ok: true, value: { requiredChannel: channel, requireChannelSubscription: true } };
  }

  if (field === "forbidden_names") {
    if (text.toLowerCase() === "clear") return { ok: true, value: { forbiddenNameKeywords: [] } };
    const keywords = normalizeForbiddenNameKeywords(text.split(/[\s,，、;；|]+/));
    if (!keywords.length) {
      return { ok: false, message: locale === "zh-CN" ? "请至少发送一个关键词，或发送 clear 清空。" : "Send at least one keyword, or send clear." };
    }
    return { ok: true, value: { forbiddenNameKeywords: keywords } };
  }

  if (field === "punishment") {
    const minutes = parseDurationMinutes(text);
    if (!minutes) {
      return { ok: false, message: locale === "zh-CN" ? "时长格式不正确，请发送 10分钟、1小时、1天、10m、1h 或 1d。" : "Invalid duration. Send 10m, 1h, or 1d." };
    }
    return { ok: true, value: { punishmentMinutes: minutes } };
  }

  const seconds = parseNoticeDeleteSeconds(text);
  if (seconds === null) {
    return { ok: false, message: locale === "zh-CN" ? "时间格式不正确，请发送秒数、10分钟、1小时、10m 或 1h。" : "Invalid time. Send seconds, 10m, or 1h." };
  }
  return { ok: true, value: { noticeDeleteSeconds: seconds } };
}

async function findSpeechCheckFailures(ctx: Context, user: User, settings: SpeechCheckSettings) {
  const reasons: string[] = [];
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ");
  const nameTarget = `${fullName} ${user.username ?? ""}`.toLowerCase();

  if (settings.requireLastName && !user.last_name?.trim()) reasons.push("last_name");
  if (settings.requireUsername && !user.username?.trim()) reasons.push("username");
  if (settings.requireAvatar && !(await userHasAvatar(ctx, user.id))) reasons.push("avatar");
  if (settings.requireChannelSubscription && settings.requiredChannel && !(await userSubscribedToRequiredChannel(ctx, settings.requiredChannel, user.id))) {
    reasons.push("channel");
  }
  if (settings.forbiddenNameKeywords.some((keyword) => keyword && nameTarget.includes(keyword.toLowerCase()))) reasons.push("forbidden_name");

  return reasons;
}

async function userHasAvatar(ctx: Context, userId: number) {
  const cached = avatarCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.hasAvatar;

  const photos = await ctx.api.getUserProfilePhotos(userId, { limit: 1 }).catch(() => null);
  const hasAvatar = Boolean(photos?.total_count);
  avatarCache.set(userId, { hasAvatar, expiresAt: Date.now() + 5 * 60_000 });
  return hasAvatar;
}

async function userSubscribedToRequiredChannel(ctx: Context, channel: string, userId: number) {
  const key = `${channel}:${userId}`;
  const cached = subscriptionCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.subscribed;

  const member = await ctx.api.getChatMember(channel, userId).catch(() => null);
  const subscribed = Boolean(member && member.status !== "left" && member.status !== "kicked");
  subscriptionCache.set(key, { subscribed, expiresAt: Date.now() + 60_000 });
  return subscribed;
}

async function applySpeechCheckPunishment(ctx: Context, chatId: number, userId: number, settings: SpeechCheckSettings) {
  const untilDate = Math.floor((Date.now() + settings.punishmentMinutes * 60_000) / 1000);
  await ctx.api.restrictChatMember(chatId, userId, mutedChatPermissions(), { until_date: untilDate }).catch(() => undefined);
}

function buildViolationNotice(user: User, reasons: string[], settings: SpeechCheckSettings, locale: Locale) {
  const name = escapeHtml([user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || String(user.id));
  const labels = reasons.map((reason) => violationReasonLabel(reason, locale));
  if (locale !== "zh-CN") {
    return [
      `<b>${name}</b> message blocked.`,
      `Reason: ${labels.join(", ")}`,
      `Punishment: muted ${formatDuration(locale, settings.punishmentMinutes)}`
    ].join("\n");
  }

  return [
    `<b>${name}</b> 的发言已被屏蔽。`,
    `原因：${labels.join("、")}`,
    `惩罚：禁言${formatDuration(locale, settings.punishmentMinutes)}`
  ].join("\n");
}

function violationReasonLabel(reason: string, locale: Locale) {
  const zh: Record<string, string> = {
    last_name: "未设置姓氏",
    username: "未设置用户名",
    avatar: "未设置头像",
    channel: "未订阅指定频道",
    forbidden_name: "昵称包含禁用词"
  };
  const en: Record<string, string> = {
    last_name: "missing last name",
    username: "missing username",
    avatar: "missing avatar",
    channel: "not subscribed to required channel",
    forbidden_name: "name contains forbidden keyword"
  };
  return locale === "zh-CN" ? zh[reason] ?? reason : en[reason] ?? reason;
}

function hasEnabledSpeechCheckRule(settings: SpeechCheckSettings) {
  return settings.requireLastName
    || settings.requireUsername
    || settings.requireAvatar
    || (settings.requireChannelSubscription && Boolean(settings.requiredChannel))
    || settings.forbiddenNameKeywords.length > 0;
}

function normalizeForbiddenNameKeywords(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))]
    .slice(0, 50);
}

function normalizeRequiredChannel(text: string) {
  const value = text.trim();
  if (/^@[A-Za-z0-9_]{5,32}$/.test(value)) return value;
  if (/^-100\d{5,}$/.test(value)) return value;
  return "";
}

function parseDurationMinutes(input: string) {
  const text = input.trim().toLowerCase().replace(/\s+/g, "");
  const match = text.match(/^(\d+)(分钟|分|小时|时|天|日|minute|minutes|min|m|hour|hours|h|day|days|d)$/i);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (!Number.isSafeInteger(amount) || amount <= 0 || !unit) return null;

  const multiplier = unit === "天" || unit === "日" || unit === "day" || unit === "days" || unit === "d"
    ? 24 * 60
    : unit === "小时" || unit === "时" || unit === "hour" || unit === "hours" || unit === "h"
      ? 60
      : 1;

  return normalizePunishmentMinutes(amount * multiplier);
}

function parseNoticeDeleteSeconds(input: string) {
  const text = input.trim().toLowerCase().replace(/\s+/g, "");
  if (/^\d+$/.test(text)) return normalizeNoticeDeleteSeconds(Number(text));

  const minutes = parseDurationMinutes(text);
  return minutes ? normalizeNoticeDeleteSeconds(minutes * 60) : null;
}

function normalizePunishmentMinutes(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultPunishmentMinutes;
  const minutes = Math.round(value);
  return Math.min(maxPunishmentMinutes, Math.max(minPunishmentMinutes, minutes));
}

function normalizeNoticeDeleteSeconds(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultNoticeDeleteSeconds;
  const seconds = Math.round(value);
  return Math.min(maxNoticeDeleteSeconds, Math.max(minNoticeDeleteSeconds, seconds));
}

function formatDuration(locale: Locale, minutes: number) {
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return locale === "zh-CN" ? `${days}天` : `${days} day${days === 1 ? "" : "s"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return locale === "zh-CN" ? `${hours}小时` : `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return locale === "zh-CN" ? `${minutes}分钟` : `${minutes} minute${minutes === 1 ? "" : "s"}`;
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

function inputBackKeyboard(locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "返回" : "Back", "speech_check:back");
}

function homeKeyboard(locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "返回首页" : "Home", "menu:home");
}

async function renderMenu(ctx: Context, text: string, replyMarkup: InlineKeyboard, parseMode?: "HTML") {
  const options = parseMode ? { parse_mode: parseMode, reply_markup: replyMarkup } : { reply_markup: replyMarkup };
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, options as never).catch(async () => {
      await ctx.reply(text, options as never);
    });
    return;
  }
  await ctx.reply(text, options as never);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
