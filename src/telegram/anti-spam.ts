import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { Chat, Message, MessageEntity, User } from "grammy/types";
import { ChatStatus, Prisma, type Chat as PrismaChat } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { canConfigureChat, isUserChatAdmin } from "./permissions.js";

type Locale = "zh-CN" | "en";

type AntiSpamToggleKey =
  | "aiSpam"
  | "blockChannelMasquerade"
  | "blockChannelForward"
  | "blockUserForward"
  | "blockExternalReply"
  | "blockEditToMedia"
  | "blockEditMessage"
  | "blockRichText"
  | "blockLinks"
  | "blockMentions"
  | "deleteCommands"
  | "blockCustomStickers"
  | "blockLongMessage"
  | "blockLongNickname";

type AntiSpamPunishment = "warn" | "mute" | "kick" | "ban" | "delete_only";
type AntiSpamFinalPunishment = "mute" | "kick" | "ban";
type AntiSpamInputField = "maxMessageLength" | "maxNicknameLength" | "muteMinutes" | "whitelist";

type AntiSpamSettings = Record<AntiSpamToggleKey, boolean> & {
  punishment: AntiSpamPunishment;
  warningPunishment: AntiSpamFinalPunishment;
  warningLimit: number;
  muteMinutes: number;
  noticeDeleteSeconds: number;
  maxMessageLength: number;
  maxNicknameLength: number;
  whitelistUserIds: number[];
};

type AntiSpamInputDraft = {
  chatId: string;
  field: AntiSpamInputField;
};

const antiSpamToggleTokens: Record<AntiSpamToggleKey, string> = {
  aiSpam: "ai",
  blockChannelMasquerade: "cm",
  blockChannelForward: "cf",
  blockUserForward: "uf",
  blockExternalReply: "er",
  blockEditToMedia: "em",
  blockEditMessage: "ed",
  blockRichText: "rt",
  blockLinks: "ln",
  blockMentions: "at",
  deleteCommands: "cmd",
  blockCustomStickers: "cs",
  blockLongMessage: "lm",
  blockLongNickname: "nn"
};

const antiSpamToggleKeys = Object.keys(antiSpamToggleTokens) as AntiSpamToggleKey[];
const antiSpamToggleKeyByToken = new Map(Object.entries(antiSpamToggleTokens).map(([key, token]) => [token, key as AntiSpamToggleKey]));

const defaultAntiSpamSettings: AntiSpamSettings = {
  aiSpam: false,
  blockChannelMasquerade: false,
  blockChannelForward: false,
  blockUserForward: false,
  blockExternalReply: false,
  blockEditToMedia: false,
  blockEditMessage: false,
  blockRichText: false,
  blockLinks: false,
  blockMentions: false,
  deleteCommands: false,
  blockCustomStickers: false,
  blockLongMessage: false,
  blockLongNickname: false,
  punishment: "warn",
  warningPunishment: "mute",
  warningLimit: 3,
  muteMinutes: 60,
  noticeDeleteSeconds: 60,
  maxMessageLength: 500,
  maxNicknameLength: 32,
  whitelistUserIds: []
};

const antiSpamWarnings = new Map<string, { count: number; expiresAt: number }>();
const antiSpamMessageMediaState = new Map<string, boolean>();
const antiSpamInputDrafts = new Map<number, AntiSpamInputDraft>();

export function clearAntiSpamDraft(userId: number) {
  antiSpamInputDrafts.delete(userId);
}

export async function openAntiSpamMenu(ctx: Context, locale: Locale, chat: PrismaChat) {
  const settings = await getAntiSpamSettings(chat.id);
  await editOrReply(ctx, antiSpamText(settings, locale), antiSpamKeyboard(chat.id, settings, locale));
}

export async function handleAntiSpamCallback(ctx: Context) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const locale = await getLocale(ctx);
  const parts = ctx.callbackQuery?.data?.split(":") ?? [];
  const action = parts[1];
  const chatId = parts[3] ?? parts[2];
  if (!action || !chatId) return;

  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!chat) {
    await editOrReply(ctx, locale === "zh-CN" ? "找不到该管理对象。" : "Managed chat not found.", homeKeyboard(locale));
    return;
  }

  if (!(await ensureAccess(ctx, chat, locale))) return;

  const settings = await getAntiSpamSettings(chat.id);

  if (action === "t") {
    const key = antiSpamToggleKeyByToken.get(parts[2] ?? "");
    if (key === "blockLongMessage") {
      if (ctx.from) antiSpamInputDrafts.set(ctx.from.id, { chatId: chat.id, field: "maxMessageLength" });
      await editOrReply(ctx, antiSpamMaxLengthPromptText(settings, "maxMessageLength", locale), antiSpamBackKeyboard(chat.id, locale));
      return;
    }
    if (key === "blockLongNickname") {
      if (ctx.from) antiSpamInputDrafts.set(ctx.from.id, { chatId: chat.id, field: "maxNicknameLength" });
      await editOrReply(ctx, antiSpamMaxLengthPromptText(settings, "maxNicknameLength", locale), antiSpamBackKeyboard(chat.id, locale));
      return;
    }
    if (key) {
      settings[key] = !settings[key];
      await saveAntiSpamSettings(chat.id, settings);
    }
    await openAntiSpamMenu(ctx, locale, chat);
    return;
  }

  if (action === "p") {
    await editOrReply(ctx, antiSpamPunishmentText(settings, locale), antiSpamPunishmentKeyboard(chat.id, settings, locale));
    return;
  }

  if (action === "ps") {
    const value = parts[2];
    if (isAntiSpamPunishment(value)) {
      settings.punishment = value;
      await saveAntiSpamSettings(chat.id, settings);
    }
    await editOrReply(ctx, antiSpamPunishmentText(settings, locale), antiSpamPunishmentKeyboard(chat.id, settings, locale));
    return;
  }

  if (action === "wa") {
    const value = parts[2];
    if (isAntiSpamFinalPunishment(value)) {
      settings.warningPunishment = value;
      await saveAntiSpamSettings(chat.id, settings);
    }
    await editOrReply(ctx, antiSpamPunishmentText(settings, locale), antiSpamPunishmentKeyboard(chat.id, settings, locale));
    return;
  }

  if (action === "wc") {
    settings.warningLimit = clampNumber(Number(parts[2] ?? settings.warningLimit), 1, 5);
    await saveAntiSpamSettings(chat.id, settings);
    await editOrReply(ctx, antiSpamPunishmentText(settings, locale), antiSpamPunishmentKeyboard(chat.id, settings, locale));
    return;
  }

  if (action === "md") {
    settings.muteMinutes = clampNumber(Number(parts[2] ?? settings.muteMinutes), 0, 525600);
    await saveAntiSpamSettings(chat.id, settings);
    await editOrReply(ctx, antiSpamPunishmentText(settings, locale), antiSpamPunishmentKeyboard(chat.id, settings, locale));
    return;
  }

  if (action === "mp") {
    if (ctx.from) antiSpamInputDrafts.set(ctx.from.id, { chatId: chat.id, field: "muteMinutes" });
    await editOrReply(ctx, antiSpamMuteDurationPromptText(settings, locale), antiSpamBackKeyboard(chat.id, locale));
    return;
  }

  if (action === "nd") {
    await editOrReply(ctx, antiSpamNoticeDeleteText(locale), antiSpamNoticeKeyboard(chat.id, settings, locale));
    return;
  }

  if (action === "ns") {
    settings.noticeDeleteSeconds = clampNumber(Number(parts[2] ?? settings.noticeDeleteSeconds), -1, 43200);
    await saveAntiSpamSettings(chat.id, settings);
    await editOrReply(ctx, antiSpamNoticeDeleteText(locale), antiSpamNoticeKeyboard(chat.id, settings, locale));
    return;
  }

  if (action === "wl") {
    await editOrReply(ctx, antiSpamWhitelistText(settings, locale), antiSpamWhitelistKeyboard(chat.id, locale));
    return;
  }

  if (action === "wl_add") {
    if (ctx.from) antiSpamInputDrafts.set(ctx.from.id, { chatId: chat.id, field: "whitelist" });
    await editOrReply(ctx, antiSpamWhitelistAddPromptText(locale), antiSpamBackKeyboard(chat.id, locale));
    return;
  }

  if (action === "b") {
    if (ctx.from) antiSpamInputDrafts.delete(ctx.from.id);
    await openAntiSpamMenu(ctx, locale, chat);
  }
}

export async function handleAntiSpamInputMessage(ctx: Context, locale: Locale) {
  if (!ctx.from) return false;
  const draft = antiSpamInputDrafts.get(ctx.from.id);
  if (!draft) return false;

  const chat = await prisma.chat.findUnique({ where: { id: draft.chatId } });
  if (!chat) {
    antiSpamInputDrafts.delete(ctx.from.id);
    await ctx.reply(locale === "zh-CN" ? "找不到该管理对象。" : "Managed chat not found.", { reply_markup: homeKeyboard(locale) }).catch(() => undefined);
    return true;
  }

  if (!(await ensureAccess(ctx, chat, locale))) return true;

  const settings = await getAntiSpamSettings(chat.id);
  const text = getMessageText(ctx.message);

  if (draft.field === "maxMessageLength" || draft.field === "maxNicknameLength" || draft.field === "muteMinutes") {
    const value = Number(text.trim());
    const limit = antiSpamInputNumberLimit(draft.field);
    if (!Number.isInteger(value) || value < limit.min || value > limit.max) {
      await ctx.reply(antiSpamInvalidNumberText(draft.field, settings, locale), {
        parse_mode: "HTML",
        reply_markup: antiSpamBackKeyboard(chat.id, locale)
      });
      return true;
    }

    if (draft.field === "maxMessageLength") {
      settings.maxMessageLength = value;
      settings.blockLongMessage = true;
    } else if (draft.field === "maxNicknameLength") {
      settings.maxNicknameLength = value;
      settings.blockLongNickname = true;
    } else {
      settings.muteMinutes = value;
    }
    await saveAntiSpamSettings(chat.id, settings);
    antiSpamInputDrafts.delete(ctx.from.id);
    await ctx.reply(antiSpamSavedText(locale), {
      parse_mode: "HTML",
      reply_markup: draft.field === "muteMinutes"
        ? antiSpamPunishmentKeyboard(chat.id, settings, locale)
        : antiSpamKeyboard(chat.id, settings, locale)
    });
    return true;
  }

  const userIds = parseWhitelistUserIds(text, ctx.message);
  if (!userIds.length) {
    await ctx.reply(antiSpamWhitelistAddPromptText(locale), {
      parse_mode: "HTML",
      reply_markup: antiSpamBackKeyboard(chat.id, locale)
    });
    return true;
  }

  const next = new Set(settings.whitelistUserIds);
  for (const userId of userIds) next.add(userId);
  settings.whitelistUserIds = [...next].slice(0, 500);
  await saveAntiSpamSettings(chat.id, settings);
  antiSpamInputDrafts.delete(ctx.from.id);
  await ctx.reply(antiSpamWhitelistText(settings, locale), {
    parse_mode: "HTML",
    reply_markup: antiSpamWhitelistKeyboard(chat.id, locale)
  });
  return true;
}

export async function handleAntiSpamMessage(ctx: Context, chat: PrismaChat, message: Message, locale: Locale) {
  if (!ctx.chat || !isGroupLike(ctx.chat)) return false;
  rememberMessageMediaState(ctx.chat.id, message);
  return handleAntiSpamViolation(ctx, chat, message, locale, "message");
}

export async function handleAntiSpamEditedMessage(ctx: Context, locale: Locale) {
  const message = ctx.update.edited_message;
  if (!message) return false;
  const chat = await getActiveChatByTelegramId(message.chat.id);
  if (!chat || !isGroupLike(message.chat)) return false;
  return handleAntiSpamViolation(ctx, chat, message, locale, "edit");
}

async function handleAntiSpamViolation(
  ctx: Context,
  chat: PrismaChat,
  message: Message,
  locale: Locale,
  mode: "message" | "edit"
) {
  const settings = await getAntiSpamSettings(chat.id);
  if (!hasEnabledRule(settings)) return false;

  const user = message.from;
  if (user?.is_bot) return false;
  if (user && settings.whitelistUserIds.includes(user.id)) return false;
  if (user && await isUserChatAdmin(ctx, Number(chat.telegramChatId), user.id).catch(() => false)) return false;

  const reason = detectAntiSpamReason(chat, message, settings, mode);
  if (!reason) return false;

  await ctx.api.deleteMessage(Number(chat.telegramChatId), message.message_id).catch((error) => {
    console.error("Failed to delete anti-spam message", {
      chatId: chat.id,
      telegramChatId: chat.telegramChatId,
      messageId: message.message_id,
      reason,
      error
    });
  });

  await applyAntiSpamPunishment(ctx, chat, user, reason, settings, locale);
  return true;
}

function detectAntiSpamReason(
  chat: PrismaChat,
  message: Message,
  settings: AntiSpamSettings,
  mode: "message" | "edit"
) {
  const text = getMessageText(message);
  const entities = getMessageEntities(message);

  if (mode === "edit") {
    if (settings.blockEditToMedia && wasEditedToMedia(message)) return "编辑消息为媒体";
    if (settings.blockEditMessage) return "编辑消息";
  }

  if (settings.blockChannelMasquerade && isChannelMasquerade(chat, message)) return "频道马甲";
  if (settings.blockChannelForward && isChannelForward(message)) return "频道转发";
  if (settings.blockUserForward && isUserForward(message)) return "用户转发";
  if (settings.blockExternalReply && hasExternalReply(message)) return "外部引用";
  if (settings.deleteCommands && hasCommand(message, entities)) return "命令消息";
  if (settings.blockCustomStickers && hasCustomSticker(message)) return "自定义贴纸";
  if (settings.blockLinks && hasLink(text, entities)) return "链接";
  if (settings.blockMentions && hasMention(text, entities)) return "@用户";
  if (settings.blockRichText && hasRichText(entities)) return "富文本";
  if (settings.blockLongMessage && text.length > settings.maxMessageLength) return "超长消息";
  if (settings.blockLongNickname && message.from && displayNameLength(message.from) > settings.maxNicknameLength) return "超长昵称";
  if (settings.aiSpam && isLikelySpam(text, entities)) return "疑似垃圾消息";

  return null;
}

async function applyAntiSpamPunishment(
  ctx: Context,
  chat: PrismaChat,
  user: User | undefined,
  reason: string,
  settings: AntiSpamSettings,
  locale: Locale
) {
  const telegramChatId = Number(chat.telegramChatId);
  if (!user) {
    await sendAntiSpamNotice(ctx, telegramChatId, antiSpamNoticeText(undefined, reason, "delete_only", settings, locale), settings);
    return;
  }

  if (settings.punishment === "delete_only") {
    await sendAntiSpamNotice(ctx, telegramChatId, antiSpamNoticeText(user, reason, "delete_only", settings, locale), settings);
    return;
  }

  if (settings.punishment !== "warn") {
    await applyFinalPunishment(ctx, telegramChatId, user.id, settings.punishment, settings.muteMinutes);
    clearWarning(chat.id, user.id);
    await sendAntiSpamNotice(ctx, telegramChatId, antiSpamNoticeText(user, reason, settings.punishment, settings, locale), settings);
    return;
  }

  const count = incrementWarning(chat.id, user.id);
  if (count >= settings.warningLimit) {
    await applyFinalPunishment(ctx, telegramChatId, user.id, settings.warningPunishment, settings.muteMinutes);
    clearWarning(chat.id, user.id);
    await sendAntiSpamNotice(
      ctx,
      telegramChatId,
      antiSpamWarningLimitNoticeText(user, reason, settings, locale),
      settings
    );
    return;
  }

  await sendAntiSpamNotice(ctx, telegramChatId, antiSpamWarningNoticeText(user, reason, count, settings, locale), settings);
}

async function applyFinalPunishment(
  ctx: Context,
  chatId: number,
  userId: number,
  punishment: AntiSpamFinalPunishment,
  muteMinutes: number
) {
  if (punishment === "mute") {
    const untilDate = muteMinutes <= 0 ? 0 : Math.floor((Date.now() + muteMinutes * 60 * 1000) / 1000);
    await ctx.api.restrictChatMember(chatId, userId, noChatPermissions(), { until_date: untilDate }).catch((error) => {
      console.error("Failed to mute anti-spam member", { chatId, userId, muteMinutes, error });
    });
    return;
  }

  if (punishment === "kick") {
    await ctx.api.banChatMember(chatId, userId).catch((error) => {
      console.error("Failed to kick anti-spam member", { chatId, userId, error });
    });
    await ctx.api.unbanChatMember(chatId, userId, { only_if_banned: true }).catch(() => undefined);
    return;
  }

  await ctx.api.banChatMember(chatId, userId).catch((error) => {
    console.error("Failed to ban anti-spam member", { chatId, userId, error });
  });
}

async function sendAntiSpamNotice(ctx: Context, telegramChatId: number, text: string, settings: AntiSpamSettings) {
  if (settings.noticeDeleteSeconds < 0) return;
  const sent = await ctx.api.sendMessage(telegramChatId, text, { parse_mode: "HTML" }).catch(() => null);
  if (!sent || settings.noticeDeleteSeconds <= 0) return;
  setTimeout(() => {
    void ctx.api.deleteMessage(telegramChatId, sent.message_id).catch(() => undefined);
  }, settings.noticeDeleteSeconds * 1000);
}

function antiSpamText(settings: AntiSpamSettings, locale: Locale) {
  return locale === "zh-CN"
    ? ["📨 <strong>反垃圾</strong>", "", `惩罚：${punishmentSummary(settings, locale)}`].join("\n")
    : ["📨 <strong>Anti-spam</strong>", "", `Punishment: ${punishmentSummary(settings, locale)}`].join("\n");
}

function antiSpamKeyboard(chatId: string, settings: AntiSpamSettings, locale: Locale) {
  const label = (key: AntiSpamToggleKey, zh: string, en: string) => `${settings[key] ? "✅" : ""}${locale === "zh-CN" ? zh : en}`;
  return new InlineKeyboard()
    .text(label("aiSpam", "AI屏蔽垃圾消息", "AI spam filter"), toggleData("aiSpam", chatId))
    .row()
    .text(label("blockChannelMasquerade", "屏蔽频道马甲", "Block channel alias"), toggleData("blockChannelMasquerade", chatId))
    .row()
    .text(label("blockChannelForward", "屏蔽频道转发", "Block channel forwards"), toggleData("blockChannelForward", chatId))
    .text(label("blockUserForward", "屏蔽用户转发", "Block user forwards"), toggleData("blockUserForward", chatId))
    .row()
    .text(label("blockExternalReply", "屏蔽外部引用", "Block external replies"), toggleData("blockExternalReply", chatId))
    .text(label("blockEditToMedia", "屏蔽编辑消息为媒体", "Block edit to media"), toggleData("blockEditToMedia", chatId))
    .row()
    .text(label("blockEditMessage", "屏蔽编辑消息", "Block edited messages"), toggleData("blockEditMessage", chatId))
    .text(label("blockRichText", "屏蔽富文本", "Block rich text"), toggleData("blockRichText", chatId))
    .row()
    .text(label("blockLinks", "屏蔽链接", "Block links"), toggleData("blockLinks", chatId))
    .text(label("blockMentions", "屏蔽@用户", "Block @mentions"), toggleData("blockMentions", chatId))
    .row()
    .text(label("deleteCommands", "清除命令消息", "Delete commands"), toggleData("deleteCommands", chatId))
    .text(label("blockCustomStickers", "屏蔽自定义贴纸", "Block custom stickers"), toggleData("blockCustomStickers", chatId))
    .row()
    .text(label("blockLongMessage", "屏蔽超长消息", "Block long messages"), toggleData("blockLongMessage", chatId))
    .row()
    .text(label("blockLongNickname", "屏蔽超长昵称", "Block long nicknames"), toggleData("blockLongNickname", chatId))
    .row()
    .text(locale === "zh-CN" ? "🚷惩罚" : "🚷Punishment", `anti_spam:p:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "☀️白名单" : "☀️Whitelist", `anti_spam:wl:${chatId}`)
    .text(noticeButtonLabel(settings.noticeDeleteSeconds, locale), `anti_spam:nd:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "🔙返回" : "🔙Back", `menu:chat:group:${chatId}`);
}

function antiSpamPunishmentText(settings: AntiSpamSettings, locale: Locale) {
  return locale === "zh-CN"
    ? ["📨 <b>反垃圾</b>", "", `惩罚：${punishmentSummary(settings, locale)}`].join("\n")
    : ["📨 <b>Anti-spam</b>", "", `Punishment: ${punishmentSummary(settings, locale)}`].join("\n");
}

function antiSpamPunishmentKeyboard(chatId: string, settings: AntiSpamSettings, locale: Locale) {
  const selected = (active: boolean, label: string) => active ? `✅${label}` : label;
  const labels = locale === "zh-CN"
    ? {
        warn: "警告",
        mute: "禁言",
        kick: "踢出",
        ban: "踢出+封禁",
        deleteOnly: "仅删除",
        warningLimit: "警告次数",
        warnAfter: `警告${settings.warningLimit}次后⬇️`,
        duration: "🔇🕘设置禁言时长",
        back: "🔙返回"
      }
    : {
        warn: "Warn",
        mute: "Mute",
        kick: "Kick",
        ban: "Kick+ban",
        deleteOnly: "Delete only",
        warningLimit: "Warning count",
        warnAfter: `After ${settings.warningLimit} warnings⬇️`,
        duration: "🔇🕘Set mute duration",
        back: "🔙Back"
      };

  return new InlineKeyboard()
    .text(selected(settings.punishment === "warn", labels.warn), `anti_spam:ps:warn:${chatId}`)
    .text(selected(settings.punishment === "mute", labels.mute), `anti_spam:ps:mute:${chatId}`)
    .text(selected(settings.punishment === "kick", labels.kick), `anti_spam:ps:kick:${chatId}`)
    .row()
    .text(selected(settings.punishment === "ban", labels.ban), `anti_spam:ps:ban:${chatId}`)
    .text(selected(settings.punishment === "delete_only", labels.deleteOnly), `anti_spam:ps:delete_only:${chatId}`)
    .row()
    .text(labels.warningLimit, `anti_spam:p:${chatId}`)
    .row()
    .text(selected(settings.warningLimit === 1, "1"), `anti_spam:wc:1:${chatId}`)
    .text(selected(settings.warningLimit === 2, "2"), `anti_spam:wc:2:${chatId}`)
    .text(selected(settings.warningLimit === 3, "3"), `anti_spam:wc:3:${chatId}`)
    .text(selected(settings.warningLimit === 4, "4"), `anti_spam:wc:4:${chatId}`)
    .text(selected(settings.warningLimit === 5, "5"), `anti_spam:wc:5:${chatId}`)
    .row()
    .text(labels.warnAfter, `anti_spam:p:${chatId}`)
    .row()
    .text(selected(settings.warningPunishment === "mute", labels.mute), `anti_spam:wa:mute:${chatId}`)
    .text(selected(settings.warningPunishment === "kick", labels.kick), `anti_spam:wa:kick:${chatId}`)
    .text(selected(settings.warningPunishment === "ban", labels.ban), `anti_spam:wa:ban:${chatId}`)
    .row()
    .text(labels.duration, `anti_spam:mp:${chatId}`)
    .row()
    .text(labels.back, `anti_spam:b:${chatId}`);
}

function antiSpamWhitelistText(settings: AntiSpamSettings, locale: Locale) {
  const count = settings.whitelistUserIds.length;
  const totalPages = Math.ceil(count / 10);
  return locale === "zh-CN"
    ? [
        "<strong>📨 反垃圾    🔅白名单</strong>:",
        "",
        `1/${totalPages},总数${count}`
      ].join("\n")
    : [
        "<strong>📨 Anti-spam    🔅Whitelist</strong>:",
        "",
        `1/${totalPages}, total ${count}`
      ].join("\n");
}

function antiSpamWhitelistKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "➕添加白名单" : "➕Add whitelist", `anti_spam:wl_add:${chatId}`)
    .text(locale === "zh-CN" ? "🔙返回" : "🔙Back", `anti_spam:b:${chatId}`);
}

function antiSpamBackKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "🔙返回" : "🔙Back", `anti_spam:b:${chatId}`);
}

function toggleData(key: AntiSpamToggleKey, chatId: string) {
  return `anti_spam:t:${antiSpamToggleTokens[key]}:${chatId}`;
}

function homeKeyboard(locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "🏠 首页" : "🏠 Home", "menu:home");
}

function noticeButtonLabel(seconds: number, locale: Locale) {
  if (locale === "zh-CN") {
    return seconds < 0 ? "♻️删除提醒" : "♻️删除提醒";
  }

  return "♻️Notice deletion";
}

function antiSpamMaxLengthPromptText(settings: AntiSpamSettings, field: Extract<AntiSpamInputField, "maxMessageLength" | "maxNicknameLength">, locale: Locale) {
  if (field === "maxMessageLength") {
    return locale === "zh-CN"
      ? [
          "📨 反垃圾",
          "",
          "检测到消息内容长度大于设定数时，将会判定为超长消息，并作出相应处罚",
          "",
          `当前设置最大长度: <strong>${settings.maxMessageLength}</strong>`,
          "",
          "👉 输入允许的消息最大长度（例如:100）:"
        ].join("\n")
      : [
          "📨 Anti-spam",
          "",
          "Messages longer than this limit are treated as long-message spam.",
          "",
          `Current max length: <strong>${settings.maxMessageLength}</strong>`,
          "",
          "👉 Send the allowed maximum message length, for example <strong>100</strong>:"
        ].join("\n");
  }

  return locale === "zh-CN"
    ? [
        "📨 反垃圾",
        "",
        "检测到用户昵称长度大于设定数时，并作出相应处罚",
        "",
        `当前设置最大长度: <strong>${settings.maxNicknameLength}</strong>`,
        "",
        "👉 输入允许的昵称最大长度（例如:30）:"
      ].join("\n")
    : [
        "📨 Anti-spam",
        "",
        "Nicknames longer than this limit trigger the configured punishment.",
        "",
        `Current max length: <strong>${settings.maxNicknameLength}</strong>`,
        "",
        "👉 Send the allowed maximum nickname length, for example <strong>30</strong>:"
      ].join("\n");
}

function antiSpamMuteDurationPromptText(settings: AntiSpamSettings, locale: Locale) {
  return locale === "zh-CN"
    ? [
        "📨 反垃圾",
        "",
        `当前设置: 禁言 ${formatDuration(settings.muteMinutes, locale)}`,
        "",
        "👉 输入处罚禁言的时长 如 <strong>60</strong> 单位/分钟:"
      ].join("\n")
    : [
        "📨 Anti-spam",
        "",
        `Current setting: mute ${formatDuration(settings.muteMinutes, locale)}`,
        "",
        "👉 Send the mute duration in minutes, for example <strong>60</strong>:"
      ].join("\n");
}

function antiSpamNoticeDeleteText(locale: Locale) {
  return locale === "zh-CN"
    ? [
        "📨 反垃圾",
        "",
        "群成员触发反垃圾时，机器人发出的提醒消息在多久时间后自动删除"
      ].join("\n")
    : [
        "📨 Anti-spam",
        "",
        "Choose how long bot warning notices stay after a member triggers anti-spam."
      ].join("\n");
}

function antiSpamNoticeKeyboard(chatId: string, settings: AntiSpamSettings, locale: Locale) {
  const selected = (active: boolean, label: string) => active ? `✅${label}` : label;
  const option = (seconds: number, label: string) => selected(settings.noticeDeleteSeconds === seconds, label);
  return new InlineKeyboard()
    .text(option(10, locale === "zh-CN" ? "10秒" : "10s"), `anti_spam:ns:10:${chatId}`)
    .text(option(30, locale === "zh-CN" ? "30秒" : "30s"), `anti_spam:ns:30:${chatId}`)
    .text(option(60, locale === "zh-CN" ? "60秒" : "60s"), `anti_spam:ns:60:${chatId}`)
    .row()
    .text(option(300, locale === "zh-CN" ? "5分钟" : "5m"), `anti_spam:ns:300:${chatId}`)
    .text(option(600, locale === "zh-CN" ? "10分钟" : "10m"), `anti_spam:ns:600:${chatId}`)
    .text(option(1800, locale === "zh-CN" ? "30分钟" : "30m"), `anti_spam:ns:1800:${chatId}`)
    .row()
    .text(option(3600, locale === "zh-CN" ? "1小时" : "1h"), `anti_spam:ns:3600:${chatId}`)
    .text(option(21600, locale === "zh-CN" ? "6小时" : "6h"), `anti_spam:ns:21600:${chatId}`)
    .text(option(43200, locale === "zh-CN" ? "12小时" : "12h"), `anti_spam:ns:43200:${chatId}`)
    .row()
    .text(selected(settings.noticeDeleteSeconds === 0, locale === "zh-CN" ? "不删除" : "Do not delete"), `anti_spam:ns:0:${chatId}`)
    .text(selected(settings.noticeDeleteSeconds < 0, locale === "zh-CN" ? "不提醒" : "Do not notify"), `anti_spam:ns:-1:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "🔙返回" : "🔙Back", `anti_spam:b:${chatId}`);
}

function antiSpamWhitelistAddPromptText(locale: Locale) {
  return locale === "zh-CN"
    ? [
        "📨 反垃圾    🔅白名单",
        "",
        "👉 请输入要添加到白名单的 Telegram 用户 ID，多个 ID 可用换行或逗号分隔。"
      ].join("\n")
    : [
        "📨 Anti-spam    🔅Whitelist",
        "",
        "👉 Send Telegram user IDs to add. Multiple IDs can be separated by new lines or commas."
      ].join("\n");
}

function antiSpamSavedText(locale: Locale) {
  return locale === "zh-CN" ? "✅ 设置成功，点击按钮返回。" : "✅ Saved. Tap the button to return.";
}

function antiSpamInputNumberLimit(field: Exclude<AntiSpamInputField, "whitelist">) {
  if (field === "maxMessageLength") return { min: 1, max: 10000 };
  if (field === "maxNicknameLength") return { min: 1, max: 128 };
  return { min: 0, max: 525600 };
}

function antiSpamInvalidNumberText(field: Exclude<AntiSpamInputField, "whitelist">, settings: AntiSpamSettings, locale: Locale) {
  if (field === "maxMessageLength") return antiSpamMaxLengthPromptText(settings, "maxMessageLength", locale);
  if (field === "maxNicknameLength") return antiSpamMaxLengthPromptText(settings, "maxNicknameLength", locale);
  return antiSpamMuteDurationPromptText(settings, locale);
}

function punishmentSummary(settings: AntiSpamSettings, locale: Locale) {
  const final = punishmentLabel(settings.warningPunishment, settings, locale);
  if (settings.punishment === "warn") {
    return locale === "zh-CN"
      ? `警告${settings.warningLimit}次后${final}`
      : `Warn ${settings.warningLimit} times, then ${final}`;
  }
  return punishmentLabel(settings.punishment, settings, locale);
}

function punishmentLabel(punishment: AntiSpamPunishment | AntiSpamFinalPunishment, settings: AntiSpamSettings, locale: Locale) {
  if (locale === "zh-CN") {
    if (punishment === "mute") return `禁言 ${formatDuration(settings.muteMinutes, locale)}`;
    if (punishment === "kick") return "踢出";
    if (punishment === "ban") return "踢出+封禁";
    if (punishment === "delete_only") return "仅删除";
    return "警告";
  }

  if (punishment === "mute") return `mute ${formatDuration(settings.muteMinutes, locale)}`;
  if (punishment === "kick") return "kick";
  if (punishment === "ban") return "ban";
  if (punishment === "delete_only") return "delete only";
  return "warn";
}

function antiSpamNoticeText(
  user: User | undefined,
  reason: string,
  punishment: AntiSpamPunishment | AntiSpamFinalPunishment,
  settings: AntiSpamSettings,
  locale: Locale
) {
  const name = user ? displayName(user) : (locale === "zh-CN" ? "匿名消息" : "Anonymous message");
  return locale === "zh-CN"
    ? `${name} 触发反垃圾规则：<b>${escapeHtml(reason)}</b>，已${punishmentLabel(punishment, settings, locale)}。`
    : `${name} triggered anti-spam: <b>${escapeHtml(reason)}</b>, ${punishmentLabel(punishment, settings, locale)} applied.`;
}

function antiSpamWarningNoticeText(user: User, reason: string, count: number, settings: AntiSpamSettings, locale: Locale) {
  const name = displayName(user);
  return locale === "zh-CN"
    ? `${name} 触发反垃圾规则：<b>${escapeHtml(reason)}</b>，警告 ${count}/${settings.warningLimit}。`
    : `${name} triggered anti-spam: <b>${escapeHtml(reason)}</b>. Warning ${count}/${settings.warningLimit}.`;
}

function antiSpamWarningLimitNoticeText(user: User, reason: string, settings: AntiSpamSettings, locale: Locale) {
  const name = displayName(user);
  return locale === "zh-CN"
    ? `${name} 触发反垃圾规则：<b>${escapeHtml(reason)}</b>，警告已达 ${settings.warningLimit} 次，已${punishmentLabel(settings.warningPunishment, settings, locale)}。`
    : `${name} triggered anti-spam: <b>${escapeHtml(reason)}</b>. Warning limit reached, ${punishmentLabel(settings.warningPunishment, settings, locale)} applied.`;
}

async function getAntiSpamSettings(chatId: string): Promise<AntiSpamSettings> {
  const raw = await getSettingRecord(chatId, "anti_spam");
  const settings = { ...defaultAntiSpamSettings };
  for (const key of antiSpamToggleKeys) {
    settings[key] = typeof raw[key] === "boolean" ? raw[key] : defaultAntiSpamSettings[key];
  }
  settings.punishment = isAntiSpamPunishment(raw.punishment) ? raw.punishment : defaultAntiSpamSettings.punishment;
  settings.warningPunishment = isAntiSpamFinalPunishment(raw.warningPunishment)
    ? raw.warningPunishment
    : defaultAntiSpamSettings.warningPunishment;
  settings.warningLimit = clampNumber(Number(raw.warningLimit ?? defaultAntiSpamSettings.warningLimit), 1, 5);
  settings.muteMinutes = clampNumber(Number(raw.muteMinutes ?? defaultAntiSpamSettings.muteMinutes), 0, 525600);
  settings.noticeDeleteSeconds = clampNumber(Number(raw.noticeDeleteSeconds ?? defaultAntiSpamSettings.noticeDeleteSeconds), -1, 43200);
  settings.maxMessageLength = clampNumber(Number(raw.maxMessageLength ?? defaultAntiSpamSettings.maxMessageLength), 1, 10000);
  settings.maxNicknameLength = clampNumber(Number(raw.maxNicknameLength ?? defaultAntiSpamSettings.maxNicknameLength), 1, 128);
  settings.whitelistUserIds = Array.isArray(raw.whitelistUserIds)
    ? raw.whitelistUserIds.map(Number).filter((item) => Number.isSafeInteger(item) && item > 0)
    : [];
  return settings;
}

async function saveAntiSpamSettings(chatId: string, settings: AntiSpamSettings) {
  await prisma.setting.upsert({
    where: { chatId_key: { chatId, key: "anti_spam" } },
    create: { chatId, key: "anti_spam", value: settingsToJson(settings) },
    update: { value: settingsToJson(settings) }
  });
}

async function getSettingRecord(chatId: string, key: string) {
  const setting = await prisma.setting.findUnique({ where: { chatId_key: { chatId, key } } });
  return isRecord(setting?.value) ? setting.value : {};
}

async function getActiveChatByTelegramId(telegramChatId: number) {
  return prisma.chat.findFirst({
    where: {
      telegramChatId: BigInt(telegramChatId),
      status: ChatStatus.ACTIVE
    }
  });
}

async function ensureAccess(ctx: Context, chat: PrismaChat, locale: Locale) {
  const allowed = await canConfigureChat(ctx, chat, ctx.from?.id ?? 0).catch(() => false);
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

function settingsToJson(value: Record<string, unknown>): Prisma.InputJsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Prisma.InputJsonObject;
}

function hasEnabledRule(settings: AntiSpamSettings) {
  return antiSpamToggleKeys.some((key) => settings[key]);
}

function getMessageText(message: Message | undefined) {
  if (!message) return "";
  const text = "text" in message ? message.text : undefined;
  const caption = "caption" in message ? message.caption : undefined;
  return text ?? caption ?? "";
}

function getMessageEntities(message: Message): MessageEntity[] {
  const entities = "entities" in message ? message.entities : undefined;
  const captionEntities = "caption_entities" in message ? message.caption_entities : undefined;
  return [...(entities ?? []), ...(captionEntities ?? [])];
}

function isChannelMasquerade(chat: PrismaChat, message: Message) {
  const senderChat = "sender_chat" in message ? message.sender_chat : undefined;
  if (!senderChat) return false;
  if (senderChat.id === Number(chat.telegramChatId)) return false;
  return senderChat.type === "channel" || senderChat.type === "supergroup" || senderChat.type === "group";
}

function isChannelForward(message: Message) {
  const source = message as Message & {
    forward_origin?: { type?: string; chat?: Chat };
    forward_from_chat?: Chat;
  };
  return source.forward_origin?.type === "channel"
    || source.forward_origin?.type === "chat"
    || source.forward_origin?.chat?.type === "channel"
    || source.forward_from_chat?.type === "channel";
}

function isUserForward(message: Message) {
  const source = message as Message & {
    forward_origin?: { type?: string };
    forward_from?: User;
    forward_sender_name?: string;
  };
  return source.forward_origin?.type === "user"
    || source.forward_origin?.type === "hidden_user"
    || Boolean(source.forward_from)
    || Boolean(source.forward_sender_name);
}

function hasExternalReply(message: Message) {
  return "external_reply" in message && Boolean(message.external_reply);
}

function hasCommand(message: Message, entities: MessageEntity[]) {
  const text = getMessageText(message).trimStart();
  return text.startsWith("/") || entities.some((entity) => entity.type === "bot_command");
}

function hasCustomSticker(message: Message) {
  const sticker = "sticker" in message ? message.sticker : undefined;
  return Boolean(sticker && ("custom_emoji_id" in sticker || sticker.type === "custom_emoji"));
}

function hasLink(text: string, entities: MessageEntity[]) {
  return entities.some((entity) => entity.type === "url" || entity.type === "text_link" || entity.type === "email")
    || /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/|[\w.-]+\.(?:com|net|org|io|xyz|top|shop|vip|cc|cn)\b)/i.test(text);
}

function hasMention(text: string, entities: MessageEntity[]) {
  return entities.some((entity) => entity.type === "mention" || entity.type === "text_mention")
    || /(^|[\s(])@[a-zA-Z0-9_]{4,32}\b/.test(text);
}

function hasRichText(entities: MessageEntity[]) {
  return entities.some((entity) => [
    "bold",
    "italic",
    "underline",
    "strikethrough",
    "spoiler",
    "blockquote",
    "expandable_blockquote",
    "code",
    "pre",
    "text_link",
    "text_mention",
    "custom_emoji"
  ].includes(entity.type));
}

function isLikelySpam(text: string, entities: MessageEntity[]) {
  const normalized = text.toLocaleLowerCase();
  if (!normalized) return false;

  let score = 0;
  if (hasLink(text, entities)) score += 2;
  if (hasMention(text, entities)) score += 1;
  if ((normalized.match(/(?:usdt|trx|eth|btc|空投|返利|投资|赚钱|兼职|引流|推广|代发|私聊|加群|开奖|เครดิตฟรี|airdrop|bonus|promo|pump|casino|loan)/g) ?? []).length) score += 2;
  if ((normalized.match(/(?:https?:\/\/|t\.me\/|@\w+)/g) ?? []).length >= 2) score += 2;
  if (/(.)\1{8,}/u.test(normalized)) score += 1;
  if (normalized.length > 240 && hasLink(text, entities)) score += 1;
  return score >= 3;
}

function parseWhitelistUserIds(text: string, message: Message | undefined) {
  const ids = new Set<number>();
  for (const match of text.matchAll(/\b\d{5,16}\b/g)) {
    const value = Number(match[0]);
    if (Number.isSafeInteger(value) && value > 0) ids.add(value);
  }

  const forwarded = message as Message & {
    forward_from?: User;
    forward_origin?: { type?: string; sender_user?: User };
  } | undefined;
  const forwardUserId = forwarded?.forward_from?.id ?? forwarded?.forward_origin?.sender_user?.id;
  if (Number.isSafeInteger(forwardUserId) && forwardUserId && forwardUserId > 0) ids.add(forwardUserId);

  return [...ids];
}

function rememberMessageMediaState(chatId: number, message: Message) {
  antiSpamMessageMediaState.set(messageStateKey(chatId, message.message_id), hasMedia(message));
  if (antiSpamMessageMediaState.size > 2000) {
    const firstKey = antiSpamMessageMediaState.keys().next().value;
    if (firstKey) antiSpamMessageMediaState.delete(firstKey);
  }
}

function wasEditedToMedia(message: Message) {
  if (!hasMedia(message)) return false;
  const before = antiSpamMessageMediaState.get(messageStateKey(message.chat.id, message.message_id));
  return before === false || before === undefined;
}

function hasMedia(message: Message) {
  return "photo" in message
    || "video" in message
    || "animation" in message
    || "document" in message
    || "audio" in message
    || "voice" in message
    || "video_note" in message
    || "sticker" in message;
}

function messageStateKey(chatId: number, messageId: number) {
  return `${chatId}:${messageId}`;
}

function incrementWarning(chatId: string, userId: number) {
  const key = `${chatId}:${userId}`;
  const now = Date.now();
  const existing = antiSpamWarnings.get(key);
  if (!existing || existing.expiresAt <= now) {
    antiSpamWarnings.set(key, { count: 1, expiresAt: now + 24 * 60 * 60 * 1000 });
    return 1;
  }
  const count = existing.count + 1;
  antiSpamWarnings.set(key, { count, expiresAt: existing.expiresAt });
  return count;
}

function clearWarning(chatId: string, userId: number) {
  antiSpamWarnings.delete(`${chatId}:${userId}`);
}

function noChatPermissions() {
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

function displayName(user: User) {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return escapeHtml(fullName || user.username || String(user.id));
}

function displayNameLength(user: User) {
  return [...[user.first_name, user.last_name].filter(Boolean).join("")].length;
}

function formatDuration(minutes: number, locale: Locale) {
  if (minutes <= 0) return locale === "zh-CN" ? "永久" : "permanently";
  if (minutes < 60) return locale === "zh-CN" ? `${Math.round(minutes)} 分钟` : `${Math.round(minutes)}m`;
  if (minutes % 1440 === 0) return locale === "zh-CN" ? `${minutes / 1440} 天` : `${minutes / 1440}d`;
  if (minutes % 60 === 0) return locale === "zh-CN" ? `${minutes / 60} 小时` : `${minutes / 60}h`;
  return locale === "zh-CN" ? `${Math.round(minutes)} 分钟` : `${Math.round(minutes)}m`;
}

async function editOrReply(ctx: Context, text: string, keyboard: InlineKeyboard) {
  if (ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: keyboard
    }).catch(async () => {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    });
    return;
  }

  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
}

async function getLocale(ctx: Context): Promise<Locale> {
  const code = ctx.from?.language_code ?? "";
  return code.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function isAntiSpamPunishment(value: unknown): value is AntiSpamPunishment {
  return value === "warn" || value === "mute" || value === "kick" || value === "ban" || value === "delete_only";
}

function isAntiSpamFinalPunishment(value: unknown): value is AntiSpamFinalPunishment {
  return value === "mute" || value === "kick" || value === "ban";
}

function isGroupLike(chat: Chat) {
  return chat.type === "group" || chat.type === "supergroup";
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
