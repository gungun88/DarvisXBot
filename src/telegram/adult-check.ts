import { ChatStatus, Prisma, type Chat as PrismaChat } from "@prisma/client";
import { InlineKeyboard, type Context } from "grammy";
import { prisma } from "../lib/prisma.js";
import { canConfigureChat, isUserChatAdmin } from "./permissions.js";

type Locale = "zh-CN" | "en";
type AdultCheckSensitivity = "low" | "medium" | "high" | "extreme";
type AdultCheckDeleteDelaySeconds = 0 | 2 | 5 | 10 | 30;

type AdultCheckSettings = {
  enabled: boolean;
  sensitivity: AdultCheckSensitivity;
  notify: boolean;
  deleteDelaySeconds: AdultCheckDeleteDelaySeconds;
};

type AdultCheckCandidate = {
  message_id: number;
  text?: string;
  caption?: string;
  photo?: unknown;
  sticker?: {
    emoji?: string;
    set_name?: string;
    type?: string;
    is_animated?: boolean;
    is_video?: boolean;
  };
  animation?: MediaFileLike;
  video?: MediaFileLike;
  video_note?: unknown;
  document?: MediaFileLike;
};

type MediaFileLike = {
  file_name?: string;
  mime_type?: string;
};

const adultCheckSettingKey = "adult_check";
const selectedChatIds = new Map<number, string>();
const adultCheckSensitivityOptions = ["low", "medium", "high", "extreme"] as const;
const adultCheckDeleteDelayOptions = [0, 2, 5, 10, 30] as const;

const strongAdultPatterns = [
  /porn/i,
  /xxx/i,
  /nsfw/i,
  /hentai/i,
  /nude/i,
  /naked/i,
  /onlyfans/i,
  /成人/,
  /色情/,
  /裸/,
  /性爱|性交|AV视频|AV无码|约炮|援交/
] as const;

const suggestiveAdultPatterns = [
  /sexy/i,
  /erotic/i,
  /camgirl/i,
  /lingerie/i,
  /擦边/,
  /性感|私房|诱惑|挑逗/
] as const;

export function rememberSelectedAdultCheckChat(userId: number, chatId: string) {
  selectedChatIds.set(userId, chatId);
}

export async function openAdultCheckMenu(ctx: Context, locale: Locale) {
  const chat = await getSelectedChat(ctx, locale);
  if (!chat) return;
  await renderAdultCheckMenu(ctx, locale, chat);
}

export async function handleAdultCheckAction(ctx: Context, locale: Locale, key: string) {
  const chat = await getSelectedChat(ctx, locale);
  if (!chat) return;

  if (key === "noop") return;

  if (key === "toggle") {
    const current = await getAdultCheckSettings(chat.id);
    await saveAdultCheckSettings(chat.id, { enabled: !current.enabled });
    await renderAdultCheckMenu(ctx, locale, chat);
    return;
  }

  if (key.startsWith("sensitivity:")) {
    const sensitivity = key.replace("sensitivity:", "");
    if (isAdultCheckSensitivity(sensitivity)) {
      await saveAdultCheckSettings(chat.id, { sensitivity });
    }
    await renderAdultCheckMenu(ctx, locale, chat);
    return;
  }

  if (key === "notify") {
    const current = await getAdultCheckSettings(chat.id);
    await saveAdultCheckSettings(chat.id, { notify: !current.notify });
    await renderAdultCheckMenu(ctx, locale, chat);
    return;
  }

  if (key === "delay") {
    const current = await getAdultCheckSettings(chat.id);
    await saveAdultCheckSettings(chat.id, { deleteDelaySeconds: nextDeleteDelay(current.deleteDelaySeconds) });
    await renderAdultCheckMenu(ctx, locale, chat);
    return;
  }

  await renderAdultCheckMenu(ctx, locale, chat);
}

export async function handleAdultCheckMessage(ctx: Context, locale: Locale) {
  if (!ctx.chat || ctx.chat.type === "private" || !ctx.message) return false;

  const chat = await prisma.chat.findFirst({
    where: { telegramChatId: BigInt(ctx.chat.id), status: ChatStatus.ACTIVE },
    include: { settings: { where: { key: adultCheckSettingKey }, take: 1 } }
  });
  if (!chat) return false;

  const settings = parseAdultCheckSettings(chat.settings[0]?.value);
  if (!settings.enabled) return false;

  if (ctx.from) {
    const isAdmin = await isUserChatAdmin(ctx, ctx.chat.id, ctx.from.id).catch(() => false);
    if (isAdmin) return false;
  }

  const result = matchAdultContent(ctx.message as AdultCheckCandidate, settings.sensitivity);
  if (!result.matched) return false;

  const deleteMessage = () => ctx.api.deleteMessage(ctx.chat!.id, ctx.message!.message_id).catch(() => undefined);
  if (settings.deleteDelaySeconds > 0) {
    setTimeout(() => {
      void deleteMessage();
    }, settings.deleteDelaySeconds * 1000);
  } else {
    await deleteMessage();
  }

  if (settings.notify) {
    const notice = locale === "zh-CN"
      ? `检测到疑似色情内容，已处理。`
      : `Possible adult content detected and handled.`;
    const sent = await ctx.reply(notice).catch(() => null);
    if (sent) {
      setTimeout(() => {
        void ctx.api.deleteMessage(sent.chat.id, sent.message_id).catch(() => undefined);
      }, 10_000);
    }
  }

  return true;
}

async function renderAdultCheckMenu(ctx: Context, locale: Locale, chat: PrismaChat) {
  const settings = await getAdultCheckSettings(chat.id);
  await renderMenu(ctx, buildAdultCheckMessage(locale, settings), adultCheckKeyboard(locale, chat, settings), "HTML");
}

async function getSelectedChat(ctx: Context, locale: Locale) {
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
    await renderMenu(ctx, locale === "zh-CN" ? "色情检测暂只支持群组。" : "Adult detection is currently only supported in groups.", homeKeyboard(locale));
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

async function getAdultCheckSettings(chatId: string) {
  const record = await prisma.setting.findUnique({ where: { chatId_key: { chatId, key: adultCheckSettingKey } } });
  return parseAdultCheckSettings(record?.value);
}

async function saveAdultCheckSettings(chatId: string, patch: Partial<AdultCheckSettings>) {
  const existing = await prisma.setting.findUnique({ where: { chatId_key: { chatId, key: adultCheckSettingKey } } });
  const next = { ...parseAdultCheckSettings(existing?.value), ...patch };
  await prisma.setting.upsert({
    where: { chatId_key: { chatId, key: adultCheckSettingKey } },
    create: { chatId, key: adultCheckSettingKey, value: adultCheckSettingsToJson(next) },
    update: { value: adultCheckSettingsToJson(next) }
  });
  return next;
}

function parseAdultCheckSettings(value: unknown): AdultCheckSettings {
  if (!isRecord(value)) return defaultAdultCheckSettings();
  const sensitivity = typeof value.sensitivity === "string" && isAdultCheckSensitivity(value.sensitivity)
    ? value.sensitivity
    : "medium";
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : false,
    sensitivity,
    notify: typeof value.notify === "boolean" ? value.notify : true,
    deleteDelaySeconds: normalizeDeleteDelay(value.deleteDelaySeconds)
  };
}

function adultCheckSettingsToJson(settings: AdultCheckSettings): Prisma.InputJsonObject {
  return {
    enabled: settings.enabled,
    sensitivity: settings.sensitivity,
    notify: settings.notify,
    deleteDelaySeconds: settings.deleteDelaySeconds
  };
}

function defaultAdultCheckSettings(): AdultCheckSettings {
  return { enabled: false, sensitivity: "medium", notify: true, deleteDelaySeconds: 2 };
}

function buildAdultCheckMessage(locale: Locale, settings: AdultCheckSettings) {
  if (locale !== "zh-CN") {
    return [
      "🔞 <b>Adult Detection</b>",
      "",
      "Checks stickers, GIFs, videos, and images with text/caption metadata rules, then deletes matching messages.",
      "",
      "<b>Low</b>: only the clearest adult content",
      "<b>Medium</b>: obvious adult content",
      "<b>High</b>: broader matching, may false positive",
      "<b>Extreme</b>: suggestive content may be blocked",
      "",
      `<b>Status</b>: ${settings.enabled ? "On✅" : "Off❌"}`,
      `<b>Sensitivity</b>: ${formatSensitivity(locale, settings.sensitivity)}`,
      `<b>Detection notice</b>: ${settings.notify ? "On✅" : "Off❌"}`,
      `<b>Delete delay</b>: ${settings.deleteDelaySeconds}s`
    ].join("\n");
  }

  return [
    "🔞 <b>色情检测</b>",
    "",
    "可检测贴纸、GIF、视频、图片并删除命中内容。",
    "",
    "<b>低</b>: 仅拦截最明显的色情内容",
    "<b>中等</b>: 拦截较为明显的色情内容",
    "<b>高</b>: 拦截多数色情内容，可能有误判",
    "<b>极高</b>: 擦边也可能拦截，容易误判",
    "",
    `<b>状态</b>: ${settings.enabled ? "开启✅" : "关闭❌"}`,
    `<b>灵敏度</b>: ${formatSensitivity(locale, settings.sensitivity)}`,
    `<b>检测提示</b>: ${settings.notify ? "开启✅" : "关闭❌"}`,
    `<b>延迟删除</b>: ${settings.deleteDelaySeconds}s`
  ].join("\n");
}

function adultCheckKeyboard(locale: Locale, chat: PrismaChat, settings: AdultCheckSettings) {
  const labels = sensitivityLabels(locale);
  return new InlineKeyboard()
    .text(settings.enabled ? (locale === "zh-CN" ? "✅关闭色情检测" : "✅ Turn off") : (locale === "zh-CN" ? "❌开启色情检测" : "❌ Turn on"), "adult_check:toggle")
    .row()
    .text(locale === "zh-CN" ? "⬇️请选择灵敏度⬇️" : "⬇️ Choose sensitivity ⬇️", "adult_check:noop")
    .row()
    .text(settings.sensitivity === "low" ? `✅${labels.low}` : labels.low, "adult_check:sensitivity:low")
    .text(settings.sensitivity === "medium" ? `✅${labels.medium}` : labels.medium, "adult_check:sensitivity:medium")
    .text(settings.sensitivity === "high" ? `✅${labels.high}` : labels.high, "adult_check:sensitivity:high")
    .text(settings.sensitivity === "extreme" ? `✅${labels.extreme}` : labels.extreme, "adult_check:sensitivity:extreme")
    .row()
    .text(settings.notify ? (locale === "zh-CN" ? "✅检测到色情的提示" : "✅ Detection notice") : (locale === "zh-CN" ? "❌检测到色情的提示" : "❌ Detection notice"), "adult_check:notify")
    .row()
    .text(locale === "zh-CN" ? `⏲ 延迟删除(${settings.deleteDelaySeconds})s` : `⏲ Delete delay (${settings.deleteDelaySeconds})s`, "adult_check:delay")
    .row()
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `managed_chat:${chat.id}`);
}

function matchAdultContent(message: AdultCheckCandidate, sensitivity: AdultCheckSensitivity) {
  const text = collectMessageText(message).join(" ");
  let score = 0;

  if (strongAdultPatterns.some((pattern) => pattern.test(text))) score += 4;
  if (suggestiveAdultPatterns.some((pattern) => pattern.test(text))) score += 2;

  const mediaKind = detectMediaKind(message);
  if (mediaKind) {
    if (sensitivity === "high") score += 1;
    if (sensitivity === "extreme") score += 2;
    if ((mediaKind === "sticker" || mediaKind === "animation" || mediaKind === "video" || mediaKind === "video_note") && sensitivity !== "low") {
      score += sensitivity === "medium" ? 1 : 2;
    }
  }

  return { matched: score >= sensitivityThreshold(sensitivity), score, mediaKind };
}

function collectMessageText(message: AdultCheckCandidate) {
  return [
    message.text,
    message.caption,
    message.sticker?.emoji,
    message.sticker?.set_name,
    message.sticker?.type,
    message.animation?.file_name,
    message.animation?.mime_type,
    message.video?.file_name,
    message.video?.mime_type,
    message.document?.file_name,
    message.document?.mime_type
  ].filter((value): value is string => Boolean(value));
}

function detectMediaKind(message: AdultCheckCandidate) {
  if (message.sticker) return "sticker";
  if (message.animation) return "animation";
  if (message.video) return "video";
  if (message.video_note) return "video_note";
  if (message.photo) return "photo";
  if (message.document?.mime_type?.startsWith("image/")) return "photo";
  if (message.document?.mime_type?.startsWith("video/")) return "video";
  return null;
}

function sensitivityThreshold(sensitivity: AdultCheckSensitivity) {
  if (sensitivity === "low") return 4;
  if (sensitivity === "medium") return 3;
  if (sensitivity === "high") return 2;
  return 1;
}

function sensitivityLabels(locale: Locale) {
  return locale === "zh-CN"
    ? { low: "低", medium: "中等", high: "高", extreme: "极高" }
    : { low: "Low", medium: "Medium", high: "High", extreme: "Extreme" };
}

function formatSensitivity(locale: Locale, sensitivity: AdultCheckSensitivity) {
  return sensitivityLabels(locale)[sensitivity];
}

function isAdultCheckSensitivity(value: string): value is AdultCheckSensitivity {
  return adultCheckSensitivityOptions.includes(value as AdultCheckSensitivity);
}

function normalizeDeleteDelay(value: unknown): AdultCheckDeleteDelaySeconds {
  return adultCheckDeleteDelayOptions.includes(value as AdultCheckDeleteDelaySeconds)
    ? value as AdultCheckDeleteDelaySeconds
    : 2;
}

function nextDeleteDelay(current: AdultCheckDeleteDelaySeconds): AdultCheckDeleteDelaySeconds {
  const index = adultCheckDeleteDelayOptions.indexOf(current);
  return adultCheckDeleteDelayOptions[(index + 1) % adultCheckDeleteDelayOptions.length] ?? 2;
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
