import { InlineKeyboard, type Bot, type Context } from "grammy";
import type { ChatPermissions, Message } from "grammy/types";
import { ChatStatus, Prisma, type Chat as PrismaChat } from "@prisma/client";
import { find as findTimeZones } from "geo-tz";
import { prisma } from "../lib/prisma.js";
import { canConfigureChat, isUserChatAdmin } from "./permissions.js";

type Locale = "zh-CN" | "en";
type NightModeMode = "mute" | "media";
type NightModeDraft = {
  chatId: string;
  field: "time" | "timezone";
};

type NightModeSettings = {
  enabled: boolean;
  mode: NightModeMode;
  startTime: string;
  endTime: string;
  notify: boolean;
  timezone: string;
  applied: boolean;
};

const settingKey = "night_mode";
const selectedChatIds = new Map<number, string>();
const drafts = new Map<number, NightModeDraft>();
let scheduler: NodeJS.Timeout | undefined;

export function rememberSelectedNightModeChat(userId: number, chatId: string) {
  selectedChatIds.set(userId, chatId);
}

export function startNightModeScheduler(bot: Bot) {
  if (scheduler) return scheduler;
  scheduler = setInterval(() => {
    void reconcileAllNightModes(bot);
  }, 60_000);
  void reconcileAllNightModes(bot);
  return scheduler;
}

export function stopNightModeScheduler() {
  if (!scheduler) return;
  clearInterval(scheduler);
  scheduler = undefined;
}

export async function openNightModeMenu(ctx: Context, locale: Locale) {
  const chat = await getSelectedGroupChat(ctx, locale);
  if (!chat) return;
  await renderNightModeMenu(ctx, locale, chat);
}

export async function handleNightModeAction(ctx: Context, locale: Locale, key: string) {
  if (!ctx.from) return;

  const chat = await getSelectedGroupChat(ctx, locale);
  if (!chat) return;

  if (key === "noop") return;

  if (key === "status:on" || key === "status:off") {
    const enabled = key.endsWith(":on");
    const current = await getNightModeSettings(chat);
    const next = await saveNightModeSettings(chat, { enabled });
    if (!enabled && current.applied) {
      await applyNightModeState(ctx.api as Bot["api"], chat, next, false, false);
    } else if (enabled) {
      await reconcileNightModeChat(ctx.api as Bot["api"], chat);
    }
    await renderNightModeMenu(ctx, locale, chat);
    return;
  }

  if (key === "mode:mute" || key === "mode:media") {
    const next = await saveNightModeSettings(chat, { mode: key.endsWith(":mute") ? "mute" : "media" });
    if (next.enabled && isInsideWindow(next, new Date())) {
      await applyNightModeState(ctx.api as Bot["api"], chat, next, true, false);
    }
    await renderNightModeMenu(ctx, locale, chat);
    return;
  }

  if (key === "notify") {
    const current = await getNightModeSettings(chat);
    await saveNightModeSettings(chat, { notify: !current.notify });
    await renderNightModeMenu(ctx, locale, chat);
    return;
  }

  if (key === "time") {
    drafts.set(ctx.from.id, { chatId: chat.id, field: "time" });
    await renderMenu(
      ctx,
      locale === "zh-CN"
        ? ["<b>请发送夜间模式时间段</b>", "", "格式示例：<code>00:00-06:00</code>"].join("\n")
        : ["<b>Send the night mode time window</b>", "", "Example: <code>00:00-06:00</code>"].join("\n"),
      new InlineKeyboard().text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", "night_mode:noop"),
      "HTML"
    );
    return;
  }

  if (key === "timezone") {
    drafts.set(ctx.from.id, { chatId: chat.id, field: "timezone" });
    await renderMenu(
      ctx,
      locale === "zh-CN"
        ? ["<b>请发送群组时区</b>", "", "支持 IANA 时区，例如 <code>Asia/Shanghai</code>；也可以发送城市名或位置。"].join("\n")
        : ["<b>Send the group timezone</b>", "", "Use an IANA timezone such as <code>Asia/Shanghai</code>, a city name, or a location."].join("\n"),
      new InlineKeyboard().text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", "night_mode:noop"),
      "HTML"
    );
    return;
  }

  await renderNightModeMenu(ctx, locale, chat);
}

export async function handleNightModePrivateMessage(ctx: Context, locale: Locale) {
  if (!ctx.from || !ctx.message) return false;
  const draft = drafts.get(ctx.from.id);
  if (!draft) return false;

  const chat = await prisma.chat.findUnique({ where: { id: draft.chatId } });
  if (!chat || !(await ensureCanConfigureChat(ctx, chat, locale))) {
    drafts.delete(ctx.from.id);
    return true;
  }

  if (draft.field === "time") {
    const text = "text" in ctx.message ? ctx.message.text?.trim() : undefined;
    const parsed = text ? parseTimeWindow(text) : null;
    if (!parsed) {
      await ctx.reply(locale === "zh-CN" ? "时间段格式不正确，请发送 00:00-06:00。" : "Invalid time window. Send 00:00-06:00.");
      return true;
    }

    const current = await getNightModeSettings(chat);
    await saveNightModeSettings(chat, {
      startTime: parsed.startTime,
      endTime: parsed.endTime,
      enabled: false,
      applied: false
    });
    if (current.applied) {
      await applyNightModeState(ctx.api as Bot["api"], chat, { ...current, enabled: false, applied: false }, false, false);
    }
    drafts.delete(ctx.from.id);
    await ctx.reply(await buildNightModeMessage(locale, chat), {
      parse_mode: "HTML",
      reply_markup: nightModeKeyboard(locale, chat, await getNightModeSettings(chat))
    });
    return true;
  }

  const timezone = await timezoneFromMessage(ctx);
  if (!timezone) {
    await ctx.reply(locale === "zh-CN" ? "未识别时区，请发送 Asia/Shanghai、城市名或位置。" : "No timezone recognized. Send Asia/Shanghai, a city name, or a location.");
    return true;
  }

  const current = await getNightModeSettings(chat);
  await saveNightModeSettings(chat, { timezone, enabled: false, applied: false });
  if (current.applied) {
    await applyNightModeState(ctx.api as Bot["api"], chat, { ...current, enabled: false, applied: false }, false, false);
  }
  drafts.delete(ctx.from.id);
  await ctx.reply(await buildNightModeMessage(locale, chat), {
    parse_mode: "HTML",
    reply_markup: nightModeKeyboard(locale, chat, await getNightModeSettings(chat))
  });
  return true;
}

export async function handleNightModeMessage(ctx: Context) {
  if (!ctx.chat || ctx.chat.type === "private" || !ctx.message || !ctx.from || ctx.from.is_bot) return false;

  const chat = await prisma.chat.findFirst({
    where: { telegramChatId: BigInt(ctx.chat.id), status: ChatStatus.ACTIVE },
    include: { settings: { where: { key: settingKey }, take: 1 } }
  });
  if (!chat) return false;

  const settings = parseNightModeSettings(chat.settings[0]?.value, chat.timezone);
  if (!settings.enabled || !isInsideWindow(settings, new Date())) return false;

  const admin = await isUserChatAdmin(ctx, ctx.chat.id, ctx.from.id).catch(() => false);
  if (admin) return false;

  if (settings.mode === "mute") {
    await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => undefined);
    return true;
  }

  if (messageContainsMedia(ctx.message)) {
    await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => undefined);
    return true;
  }

  return false;
}

async function reconcileAllNightModes(bot: Bot) {
  const rows = await prisma.setting.findMany({
    where: { key: settingKey },
    include: { chat: true }
  });

  await Promise.all(rows.map(async (row) => {
    if (row.chat.status !== ChatStatus.ACTIVE || row.chat.type === "CHANNEL" || row.chat.type === "PRIVATE") return;
    await reconcileNightModeChat(bot.api, row.chat).catch((error) => {
      console.error("Failed to reconcile night mode", {
        chatId: row.chat.id,
        telegramChatId: row.chat.telegramChatId.toString(),
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }));
}

async function reconcileNightModeChat(api: Bot["api"], chat: PrismaChat) {
  const settings = await getNightModeSettings(chat);
  if (!settings.enabled) return;
  const shouldApply = isInsideWindow(settings, new Date());
  if (settings.applied === shouldApply) return;
  await applyNightModeState(api, chat, settings, shouldApply, settings.notify);
}

async function applyNightModeState(api: Bot["api"], chat: PrismaChat, settings: NightModeSettings, applied: boolean, notify: boolean) {
  const telegramChatId = Number(chat.telegramChatId);
  await api.setChatPermissions(telegramChatId, applied ? restrictedPermissions(settings.mode) : openPermissions());
  await saveNightModeSettings(chat, { applied });

  if (!notify) return;
  const text = applied
    ? (settings.mode === "mute" ? "🌙 夜间模式已开始，本群已全员禁言。" : "🌙 夜间模式已开始，本群已禁止发送媒体。")
    : "☀️ 夜间模式已结束，群组发言权限已恢复。";
  await api.sendMessage(telegramChatId, text).catch(() => undefined);
}

async function getSelectedGroupChat(ctx: Context, locale: Locale) {
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

  const text = locale === "zh-CN" ? "只有符合控制权限的管理员可以设置机器人。" : "Only permitted admins can configure the bot.";
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text, show_alert: true }).catch(() => undefined);
  } else {
    await ctx.reply(text).catch(() => undefined);
  }
  return false;
}

async function renderNightModeMenu(ctx: Context, locale: Locale, chat: PrismaChat) {
  await renderMenu(ctx, await buildNightModeMessage(locale, chat), nightModeKeyboard(locale, chat, await getNightModeSettings(chat)), "HTML");
}

async function buildNightModeMessage(locale: Locale, chat: PrismaChat) {
  const settings = await getNightModeSettings(chat);
  const title = escapeHtml(chat.title ?? String(chat.telegramChatId));
  if (locale !== "zh-CN") {
    return [
      "🌙 <b>Night mode</b>",
      "",
      `Limits messages in <b>${title}</b> during the configured time window.`,
      "",
      "🔔<b>Tip:</b> after changing the time window or timezone, turn night mode on again to apply it.",
      "",
      `<b>Status:</b> ${settings.enabled ? "On✅" : "Off❌"}`,
      `<b>Mode:</b> ${settings.mode === "mute" ? "Mute all🤫" : "Block media🖼"}`,
      `<b>Time window:</b> <b>${settings.startTime}</b> to <b>${settings.endTime}</b>`,
      `<b>Start/end notifications:</b> ${settings.notify ? "On✅" : "Off❌"}`,
      `<b>Current time:</b> ${formatTimezoneNow(settings.timezone)}`
    ].join("\n");
  }

  return [
    "🌙 <b>夜间模式</b>",
    "",
    `限制 [<b>${title}</b>] 内用户在指定时间段的发言`,
    "",
    "🔔<b>提示:</b> 修改时间段或者时区后，请重新开启夜间模式才能生效",
    "",
    `<b>状态：</b> ${settings.enabled ? "开启✅" : "关闭❌"}`,
    `<b>模式：</b> ${settings.mode === "mute" ? "全员禁言🤫" : "禁止媒体🖼"}`,
    `<b>时间段：</b> <b>${settings.startTime}</b> 点 到 <b>${settings.endTime}</b> 点`,
    `<b>开始和结束通知：</b> ${settings.notify ? "开启✅" : "关闭❌"}`,
    `<b>当前时间：</b> ${formatTimezoneNow(settings.timezone)}`
  ].join("\n");
}

function nightModeKeyboard(locale: Locale, chat: PrismaChat, settings: NightModeSettings) {
  const scope = chat.type === "CHANNEL" ? "channel" : "group";
  const selected = (active: boolean, text: string) => active ? `✅${text}` : text;

  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "状态:" : "Status:", "night_mode:noop")
    .text(selected(settings.enabled, locale === "zh-CN" ? "开启" : "On"), "night_mode:status:on")
    .text(selected(!settings.enabled, locale === "zh-CN" ? "关闭" : "Off"), "night_mode:status:off")
    .row()
    .text(locale === "zh-CN" ? "模式:" : "Mode:", "night_mode:noop")
    .text(selected(settings.mode === "mute", locale === "zh-CN" ? "全员禁言" : "Mute all"), "night_mode:mode:mute")
    .text(selected(settings.mode === "media", locale === "zh-CN" ? "禁止媒体" : "Block media"), "night_mode:mode:media")
    .row()
    .text(locale === "zh-CN" ? "⏱️设置时段" : "⏱️ Time window", "night_mode:time")
    .row()
    .text(`${locale === "zh-CN" ? "开始和结束通知" : "Start/end notifications"}${settings.notify ? "✅" : "❌"}`, "night_mode:notify")
    .row()
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `menu:chat:${scope}:${chat.id}`)
    .text(locale === "zh-CN" ? "🌍 设置时区" : "🌍 Timezone", "night_mode:timezone");
}

async function getNightModeSettings(chat: PrismaChat): Promise<NightModeSettings> {
  const row = await prisma.setting.findUnique({ where: { chatId_key: { chatId: chat.id, key: settingKey } } });
  return parseNightModeSettings(row?.value, chat.timezone);
}

async function saveNightModeSettings(chat: PrismaChat, patch: Partial<NightModeSettings>) {
  const next = { ...await getNightModeSettings(chat), ...patch };
  const value = nightModeSettingsToJson(next);
  await prisma.setting.upsert({
    where: { chatId_key: { chatId: chat.id, key: settingKey } },
    create: { chatId: chat.id, key: settingKey, value },
    update: { value }
  });
  if (patch.timezone && patch.timezone !== chat.timezone) {
    await prisma.chat.update({ where: { id: chat.id }, data: { timezone: patch.timezone } });
  }
  return next;
}

function parseNightModeSettings(value: unknown, fallbackTimezone: string): NightModeSettings {
  if (!isRecord(value)) {
    return defaultNightModeSettings(fallbackTimezone);
  }
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : false,
    mode: value.mode === "media" ? "media" : "mute",
    startTime: parseClockTime(value.startTime) ?? "00:00",
    endTime: parseClockTime(value.endTime) ?? "06:00",
    notify: typeof value.notify === "boolean" ? value.notify : true,
    timezone: typeof value.timezone === "string" && isValidTimeZone(value.timezone) ? value.timezone : fallbackTimezone,
    applied: typeof value.applied === "boolean" ? value.applied : false
  };
}

function defaultNightModeSettings(timezone: string): NightModeSettings {
  return {
    enabled: false,
    mode: "mute",
    startTime: "00:00",
    endTime: "06:00",
    notify: true,
    timezone: isValidTimeZone(timezone) ? timezone : "Asia/Shanghai",
    applied: false
  };
}

function nightModeSettingsToJson(settings: NightModeSettings): Prisma.InputJsonObject {
  return {
    enabled: settings.enabled,
    mode: settings.mode,
    startTime: settings.startTime,
    endTime: settings.endTime,
    notify: settings.notify,
    timezone: settings.timezone,
    applied: settings.applied
  };
}

function parseTimeWindow(input: string) {
  const match = input.match(/(\d{1,2}):(\d{2}).*?(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const startTime = normalizeTime(Number(match[1]), Number(match[2]));
  const endTime = normalizeTime(Number(match[3]), Number(match[4]));
  if (!startTime || !endTime || startTime === endTime) return null;
  return { startTime, endTime };
}

function parseClockTime(value: unknown) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return normalizeTime(Number(match[1]), Number(match[2]));
}

function normalizeTime(hour: number, minute: number) {
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function isInsideWindow(settings: NightModeSettings, date: Date) {
  const current = minutesInTimezone(settings.timezone, date);
  const start = minutesFromTime(settings.startTime);
  const end = minutesFromTime(settings.endTime);
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

function minutesInTimezone(timezone: string, date: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24;
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function minutesFromTime(value: string) {
  const parts = value.split(":");
  const hour = Number(parts[0] ?? 0);
  const minute = Number(parts[1] ?? 0);
  return hour * 60 + minute;
}

function restrictedPermissions(mode: NightModeMode): ChatPermissions {
  if (mode === "media") {
    return {
      can_send_messages: true,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: true,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
      can_change_info: false,
      can_invite_users: true,
      can_pin_messages: false,
      can_manage_topics: false
    };
  }

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

function messageContainsMedia(message: Message) {
  return "photo" in message || "video" in message || "animation" in message || "document" in message ||
    "audio" in message || "voice" in message || "video_note" in message || "sticker" in message ||
    "poll" in message || "dice" in message;
}

async function timezoneFromMessage(ctx: Context) {
  const message = ctx.message;
  if (!message) return null;

  if ("location" in message && message.location) {
    const zones = findTimeZones(message.location.latitude, message.location.longitude);
    return zones[0] ?? null;
  }

  if (!("text" in message) || !message.text) return null;
  const input = message.text.trim();
  if (!input) return null;
  const known = cityTimezoneMap.get(input.toLowerCase().replace(/\s+/g, " "));
  if (known) return known;
  return isValidTimeZone(input) ? input : null;
}

const cityTimezoneMap = new Map<string, string>([
  ["上海", "Asia/Shanghai"],
  ["shanghai", "Asia/Shanghai"],
  ["北京", "Asia/Shanghai"],
  ["beijing", "Asia/Shanghai"],
  ["广州", "Asia/Shanghai"],
  ["guangzhou", "Asia/Shanghai"],
  ["深圳", "Asia/Shanghai"],
  ["shenzhen", "Asia/Shanghai"],
  ["香港", "Asia/Hong_Kong"],
  ["hong kong", "Asia/Hong_Kong"],
  ["台北", "Asia/Taipei"],
  ["taipei", "Asia/Taipei"],
  ["东京", "Asia/Tokyo"],
  ["tokyo", "Asia/Tokyo"],
  ["首尔", "Asia/Seoul"],
  ["seoul", "Asia/Seoul"],
  ["新加坡", "Asia/Singapore"],
  ["singapore", "Asia/Singapore"],
  ["曼谷", "Asia/Bangkok"],
  ["bangkok", "Asia/Bangkok"],
  ["纽约", "America/New_York"],
  ["new york", "America/New_York"],
  ["洛杉矶", "America/Los_Angeles"],
  ["los angeles", "America/Los_Angeles"],
  ["伦敦", "Europe/London"],
  ["london", "Europe/London"],
  ["巴黎", "Europe/Paris"],
  ["paris", "Europe/Paris"],
  ["迪拜", "Asia/Dubai"],
  ["dubai", "Asia/Dubai"]
]);

function isValidTimeZone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function formatTimezoneNow(timezone: string) {
  const date = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} ${formatTimezoneOffset(timezone, date)}`;
}

function formatTimezoneOffset(timezone: string, date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  const offsetMinutes = Math.round((asUtc - date.getTime()) / 60000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `${sign}${hours}${minutes}`;
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

function homeKeyboard(locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "返回首页" : "Home", "menu:home");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
