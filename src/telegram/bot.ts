import { Bot, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { Chat, ChatInviteLink, ChatJoinRequest, InlineKeyboardMarkup, InlineQueryResult, Message, User } from "grammy/types";
import {
  ChatStatsEventType,
  ChatStatus,
  GiveawayStatus,
  PointTransactionType,
  Prisma,
  ScheduledMessageStatus,
  type Chat as PrismaChat,
  type User as PrismaUser
} from "@prisma/client";
import { find as findTimeZones } from "geo-tz";
import type { AppConfig } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";
import {
  getTelegramUserLanguageCode,
  updateUserLanguage,
  updateUserTimezone,
  upsertTelegramUser
} from "../users/user.service.js";
import {
  bindTelegramChat,
  deactivateTelegramChat,
  listManagedChats
} from "../chats/chat.service.js";
import { getBotPermissionReport, isUserChatAdmin } from "./permissions.js";
import {
  cancelScheduledMessageJob,
  clampIntervalMinutes,
  defaultScheduledContent,
  defaultScheduledRepeatRule,
  enqueueScheduledMessage,
  hasScheduledMessageContent,
  isValidCronExpression,
  nextScheduledRun,
  parseScheduledContent,
  parseScheduledRepeatRule,
  scheduledContentToJson,
  scheduledRepeatRuleToJson,
  type ScheduledMessageContent,
  type ScheduledRepeatRule
} from "../scheduled-messages/scheduled-message.service.js";
import {
  cancelGiveawayDrawJob,
  enqueueGiveawayDraw
} from "../giveaways/giveaway.service.js";
import {
  handleAdultCheckAction,
  handleAdultCheckMessage,
  openAdultCheckMenu,
  rememberSelectedAdultCheckChat
} from "./adult-check.js";
import {
  handleNewMemberLimitAction,
  handleNewMemberLimitNewChatMembers,
  handleNewMemberLimitPrivateMessage,
  openNewMemberLimitMenu,
  rememberSelectedNewMemberLimitChat
} from "./new-member-limit.js";
import {
  handleOpenCloseAction,
  handleOpenCloseGroupMessage,
  handleOpenClosePrivateMessage,
  openOpenCloseMenu,
  rememberSelectedOpenCloseChat
} from "./open-close.js";

type Locale = "zh-CN" | "en";

type SettingRecord = Record<string, unknown>;

type WelcomeSettings = {
  enabled: boolean;
  text: string;
  deleteAfterMinutes: number;
};

type JoinVerifySettings = {
  enabled: boolean;
  adminApproval: boolean;
  durationMinutes: number;
  punishment: "kick" | "ban" | "mute";
};

type BlocklistSettings = {
  blockBots: boolean;
  banAfterLeave: boolean;
  blockFlashJoinLeave: boolean;
  blockFollowerRaid: boolean;
  flashWindowSeconds: number;
  raidWindowSeconds: number;
  raidJoinThreshold: number;
};

type AutoDeleteSettings = {
  enabled: boolean;
  seconds: number;
};

type AutoReplyMediaKind = "photo" | "video" | "animation" | "sticker" | "document" | "audio" | "voice";

type AutoReplyButton = {
  text: string;
  url: string;
};

type AutoReplyRule = {
  id: string;
  keyword: string;
  matchType: "exact" | "contains";
  response: string;
  mediaKind?: AutoReplyMediaKind;
  mediaFileId?: string;
  buttons?: AutoReplyButton[][];
};

type AutoReplySettings = {
  enabled: boolean;
  deleteAfterMinutes: number;
  deletePreviousMessage: boolean;
  rules: AutoReplyRule[];
};

type PendingVerification = {
  chatId: number;
  userId: number;
  messageId: number;
  timeout: NodeJS.Timeout;
};

type PublishMediaKind = "photo" | "video" | "animation" | "sticker";

type PublishDraft = {
  name: string;
  text: string;
  buttonText: string;
  buttonUrl: string;
  mediaKind: PublishMediaKind | undefined;
  mediaFileId: string | undefined;
  waitingFor: "name" | "text" | "media" | "button" | undefined;
};

type ScheduledInputField = "name" | "text" | "media" | "button" | "interval" | "cron" | "time_window" | "start" | "end";

type ScheduledInputDraft = {
  scheduledMessageId: string;
  field: ScheduledInputField;
};

type AutoReplyInputStage = "keyword" | "response" | "buttons";

type AutoReplyInputDraft = {
  chatId: string;
  stage: AutoReplyInputStage;
  keyword?: string;
  matchType?: "exact" | "contains";
  response?: string;
  mediaKind?: AutoReplyMediaKind;
  mediaFileId?: string;
};

type ScheduledMessageListItem = {
  id: string;
  content: Prisma.JsonValue;
  buttons: Prisma.JsonValue | null;
  repeatRule: Prisma.JsonValue | null;
  status: ScheduledMessageStatus;
};

type ScheduledBulkEnableResult = {
  enabled: number;
  skipped: number;
};

const botCommands = [
  { command: "start", description: "开始菜单" },
  { command: "help", description: "帮助" },
  { command: "html", description: "HTML 格式提示" },
  { command: "info", description: "查看信息" },
  { command: "link", description: "生成邀请链接并查看统计" },
  { command: "sign_in", description: "群组签到" },
  { command: "lottery", description: "群组中正在进行的抽奖" },
  { command: "points_rank", description: "积分排名" },
  { command: "points", description: "增减积分" },
  { command: "stat", description: "今日活跃统计" },
  { command: "stat_week", description: "周活跃统计" },
  { command: "stats", description: "自定义查询活跃统计" },
  { command: "bind", description: "绑定当前群组或频道" },
  { command: "permissions", description: "检查 Bot 权限" }
] as const;

const defaultWelcomeSettings: WelcomeSettings = {
  enabled: false,
  text: "欢迎 {name} 加入 {chat}！",
  deleteAfterMinutes: 0
};

const defaultJoinVerifySettings: JoinVerifySettings = {
  enabled: false,
  adminApproval: false,
  durationMinutes: 5,
  punishment: "kick"
};

const defaultBlocklistSettings: BlocklistSettings = {
  blockBots: false,
  banAfterLeave: false,
  blockFlashJoinLeave: false,
  blockFollowerRaid: false,
  flashWindowSeconds: 120,
  raidWindowSeconds: 60,
  raidJoinThreshold: 10
};

const defaultAutoDeleteSettings: AutoDeleteSettings = {
  enabled: false,
  seconds: 0
};

const defaultAutoReplySettings: AutoReplySettings = {
  enabled: true,
  deleteAfterMinutes: 0,
  deletePreviousMessage: true,
  rules: []
};

const pendingVerifications = new Map<string, PendingVerification>();
const recentJoins = new Map<string, number>();
const raidJoinEvents = new Map<string, number[]>();
const timezoneInputUsers = new Set<number>();
const publishDrafts = new Map<number, PublishDraft>();
const scheduledInputDrafts = new Map<number, ScheduledInputDraft>();
const autoReplyInputDrafts = new Map<number, AutoReplyInputDraft>();

function rememberSelectedChatForModules(userId: number | undefined, chatId: string) {
  if (typeof userId !== "number") return;
  rememberSelectedNewMemberLimitChat(userId, chatId);
  rememberSelectedOpenCloseChat(userId, chatId);
  rememberSelectedAdultCheckChat(userId, chatId);
}

export function createBot(config: AppConfig) {
  const bot = new Bot(config.botToken);

  bot.catch((error) => {
    console.error("Telegram bot error", {
      message: error.message,
      updateId: error.ctx.update.update_id,
      cause: error.error instanceof Error ? error.error.message : String(error.error),
      stack: error.error instanceof Error ? error.error.stack : undefined,
      updateType: error.ctx.update ? Object.keys(error.ctx.update).find((key) => key !== "update_id") ?? "unknown" : "unknown",
      callbackData: error.ctx.callbackQuery?.data,
      messageText: error.ctx.message && "text" in error.ctx.message ? error.ctx.message.text : undefined
    });
  });

  bot.use(async (ctx, next) => {
    if (ctx.from) {
      await upsertTelegramUser(ctx.from, config.defaultTimezone).catch((error) => {
        console.error("Failed to upsert Telegram user", error);
      });
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    await handleStartCommand(ctx, config);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(botCommands.map((item) => `/${item.command} - ${item.description}`).join("\n"));
  });

  bot.command("html", async (ctx) => {
    await ctx.reply(
      [
        "<b>粗体</b>、<i>斜体</i>、<code>代码</code> 可以用于欢迎语和发布内容。",
        "可用变量：<code>{name}</code>、<code>{username}</code>、<code>{chat}</code>。"
      ].join("\n"),
      { parse_mode: "HTML" }
    );
  });

  bot.command("info", async (ctx) => {
    await handleInfoCommand(ctx, config);
  });

  bot.command("bind", async (ctx) => {
    await handleBindCommand(ctx, config);
  });

  bot.command("permissions", async (ctx) => {
    await handlePermissionsCommand(ctx);
  });

  bot.command("link", async (ctx) => {
    await handleInviteLinkCommand(ctx, config);
  });

  bot.command("sign_in", async (ctx) => {
    await handleSignInCommand(ctx, config);
  });

  bot.command("points_rank", async (ctx) => {
    await handlePointsRankCommand(ctx);
  });

  bot.command("points", async (ctx) => {
    await handlePointsCommand(ctx, config);
  });

  bot.command("stat", async (ctx) => {
    await handleStatsCommand(ctx, config, 1);
  });

  bot.command("stat_week", async (ctx) => {
    await handleStatsCommand(ctx, config, 7);
  });

  bot.command("stats", async (ctx) => {
    await handleStatsCommand(ctx, config, 30);
  });

  bot.command("lottery", async (ctx) => {
    await handleLotteryCommand(ctx);
  });

  bot.callbackQuery(/^menu:/, async (ctx) => {
    await handleMenuCallback(ctx, config);
  });

  bot.callbackQuery(/^publish:/, async (ctx) => {
    await handlePublishCallback(ctx, config);
  });

  bot.callbackQuery(/^scheduled:/, async (ctx) => {
    await handleScheduledCallback(ctx);
  });

  bot.callbackQuery(/^membership:/, async (ctx) => {
    await handleMembershipCallback(ctx);
  });

  bot.callbackQuery(/^chat_feature:/, async (ctx) => {
    await handleChatFeatureCallback(ctx, config);
  });

  bot.callbackQuery(/^blocklist:/, async (ctx) => {
    await handleBlocklistCallback(ctx);
  });

  bot.callbackQuery(/^welcome:/, async (ctx) => {
    await handleWelcomeCallback(ctx);
  });

  bot.callbackQuery(/^join_verify:/, async (ctx) => {
    await handleJoinVerifyCallback(ctx);
  });

  bot.callbackQuery(/^auto_delete:/, async (ctx) => {
    await handleAutoDeleteCallback(ctx);
  });

  bot.callbackQuery(/^auto_reply:/, async (ctx) => {
    await handleAutoReplyCallback(ctx);
  });

  bot.callbackQuery(/^new_member_limit:/, async (ctx) => {
    await handleNewMemberLimitCallback(ctx, config);
  });

  bot.callbackQuery(/^open_close:/, async (ctx) => {
    await handleOpenCloseCallback(ctx, config);
  });

  bot.callbackQuery(/^adult_check:/, async (ctx) => {
    await handleAdultCheckCallback(ctx);
  });

  bot.callbackQuery(/^verify:/, async (ctx) => {
    await handleVerificationCallback(ctx);
  });

  bot.callbackQuery(/^giveaway:join:/, async (ctx) => {
    await handleGiveawayJoinCallback(ctx, config);
  });

  bot.inlineQuery(/.*/, async (ctx) => {
    await handlePublishInlineQuery(ctx);
  });

  bot.on("chat_join_request", async (ctx) => {
    await handleChatJoinRequest(ctx, config);
  });

  bot.on("message", async (ctx) => {
    const locale = await getLocale(ctx);
    if (await handleAutoReplyInputMessage(ctx, locale)) return;
    if (await handleTimezoneInputMessage(ctx, config, locale)) return;
    if (await handleScheduledInputMessage(ctx, locale)) return;
    if (await handlePublishInputMessage(ctx, locale)) return;
    if (await handleNewMemberLimitPrivateMessage(ctx, config, locale)) return;
    if (await handleOpenClosePrivateMessage(ctx, config, locale)) return;
    if (await handleOpenCloseGroupMessage(ctx)) return;
    if (await handleAdultCheckMessage(ctx, locale)) return;
    await handleNewMemberLimitNewChatMembers(ctx);
    await handleIncomingMessage(ctx, config);
  });

  bot.on("my_chat_member", async (ctx) => {
    const chatId = ctx.myChatMember.chat.id;
    const oldStatus = ctx.myChatMember.old_chat_member.status;
    const status = ctx.myChatMember.new_chat_member.status;
    if (status === "left" || status === "kicked") {
      await deactivateTelegramChat(chatId).catch(() => undefined);
      return;
    }

    const wasJustAdded = isInactiveChatMemberStatus(oldStatus) && isActiveChatMemberStatus(status);
    const wasJustPromoted = status === "administrator" && oldStatus !== "administrator" && oldStatus !== "creator";
    if (wasJustAdded || wasJustPromoted) {
      await handleBotAddedToChat(ctx, config);
    }
  });

  return bot;
}

export async function registerBotCommands(bot: Bot) {
  await bot.api.setMyCommands(botCommands.map(({ command, description }) => ({ command, description }))).catch((error) => {
    console.error("Failed to register bot commands", error);
  });
}

async function handleStartCommand(ctx: Context, config: AppConfig) {
  const locale = await getLocale(ctx);
  if (ctx.from) clearUserInputState(ctx.from.id);
  const payload = extractStartPayload(ctx);
  const targetTelegramChatId = payload ? parseStartChatPayload(payload) : null;

  if (targetTelegramChatId && ctx.from) {
    const opened = await openChatPanelFromStartPayload(ctx, config, locale, targetTelegramChatId);
    if (opened) return;
  }

  await ctx.reply(mainMenuText(locale, ctx.from?.first_name, config.botUsername), {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboard(locale)
  });
}

async function openChatPanelFromStartPayload(
  ctx: Context,
  config: AppConfig,
  locale: Locale,
  telegramChatId: bigint
) {
  if (!ctx.from) return false;

  const chat = await prisma.chat.findFirst({
    where: {
      telegramChatId,
      status: ChatStatus.ACTIVE
    }
  });

  if (!chat) {
    await ctx.reply(locale === "zh-CN" ? "未找到这个群组/频道，请先重新添加机器人或在群里发送 /bind。" : "Managed chat not found. Add the bot again or send /bind in the chat.");
    return true;
  }

  const isAdmin = await isUserChatAdmin(ctx, Number(chat.telegramChatId), ctx.from.id).catch(() => false);
  if (!isAdmin) {
    await ctx.reply(locale === "zh-CN" ? "只有该群组/频道管理员可以进入管理菜单。" : "Only admins of this chat can open the management menu.");
    return true;
  }

  const user = await upsertTelegramUser(ctx.from, config.defaultTimezone);
  await prisma.chatAdmin.upsert({
    where: {
      chatId_userId: {
        chatId: chat.id,
        userId: user.id
      }
    },
    create: {
      chatId: chat.id,
      userId: user.id,
      role: "administrator",
      permissions: {}
    },
    update: {
      role: "administrator"
    }
  });

  const scope = chat.type === "CHANNEL" ? "channel" : "group";
  rememberSelectedChatForModules(ctx.from.id, chat.id);
  await ctx.reply(chatPanelText(chat, locale), {
    parse_mode: "HTML",
    reply_markup: chatPanelKeyboard(chat.id, scope, locale)
  });
  return true;
}

function clearUserInputState(userId: number) {
  timezoneInputUsers.delete(userId);
  scheduledInputDrafts.delete(userId);
  autoReplyInputDrafts.delete(userId);
  const publishDraft = publishDrafts.get(userId);
  if (publishDraft) publishDraft.waitingFor = undefined;
}
function extractStartPayload(ctx: Context) {
  const match = "match" in ctx ? ctx.match : undefined;
  if (typeof match === "string") return match.trim();

  const message = ctx.message;
  if (!message || !("text" in message) || !message.text) return "";
  const [, payload = ""] = message.text.trim().split(/\s+/, 2);
  return payload.trim();
}

function parseStartChatPayload(payload: string) {
  const decoded = decodeURIComponent(payload.trim());
  const match = decoded.match(/^(-?\d+)_home$/);
  return match?.[1] ? BigInt(match[1]) : null;
}

async function handleBotAddedToChat(ctx: Context, config: AppConfig) {
  if (!ctx.from || !ctx.myChatMember?.chat) return;

  const chat = ctx.myChatMember.chat;
  const locale = await getLocale(ctx);
  const ownerUser = await upsertTelegramUser(ctx.from, config.defaultTimezone).catch(() => null);
  const isInstallerAdmin = await isUserChatAdmin(ctx, chat.id, ctx.from.id).catch(() => false);
  const botUsername = config.botUsername.replace(/^@/, "");

  await bindTelegramChat(chat, isInstallerAdmin && ownerUser ? ownerUser.id : undefined, config.defaultTimezone).catch((error) => {
    console.error("Failed to bind chat after bot was added", error);
  });

  const permissionReport = await getBotPermissionReport(ctx, chat.id).catch((error) => ({
    canManageBaseFeatures: false,
    missingPermissions: [error instanceof Error ? error.message : String(error)]
  }));

  const addMenuUrl = `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(`${chat.id}_home`)}`;
  const keyboard = new InlineKeyboard().url(locale === "zh-CN" ? "进入管理菜单" : "Open menu", addMenuUrl);
  const lines = buildBotAddedMessage(locale, botUsername, chat, permissionReport.missingPermissions);

  await ctx.api.sendMessage(Number(chat.id), lines, {
    parse_mode: "HTML",
    reply_markup: keyboard
  }).catch((error) => {
    console.error("Failed to send bot-added welcome message", error);
  });
}

function buildBotAddedMessage(
  locale: Locale,
  botUsername: string,
  chat: Chat,
  missingPermissions: string[]
) {
  const title = escapeHtml(chat.title ?? chat.username ?? String(chat.id));
  const username = escapeHtml(botUsername.replace(/^@/, ""));
  const permissionLines = [
    locale === "zh-CN" ? "请至少赋予以下权限:" : "Please grant at least these permissions:",
    locale === "zh-CN" ? "- 删除消息" : "- Delete messages",
    locale === "zh-CN" ? "- 发送消息" : "- Send messages",
    locale === "zh-CN" ? "- 封禁成员" : "- Ban members",
    locale === "zh-CN" ? "- 置顶消息" : "- Pin messages"
  ];

  const missingLines = missingPermissions.length
    ? [
        "",
        locale === "zh-CN" ? "当前缺少权限:" : "Missing permissions:",
        ...missingPermissions.map((item) => `- ${escapeHtml(item)}`)
      ]
    : [];

  return locale === "zh-CN"
    ? [
        `🎉 欢迎使用: ${username}`,
        "",
        "1. 请将我设置为管理员，否则无法正常工作",
        "",
        ...permissionLines,
        ...missingLines,
        "",
        "1) 点击下面按钮选择设置(仅限管理员)",
        "2) 然后点击机器人对话框底部[开始]按钮",
        "",
        `群组: <b>${title}</b>`
      ].join("\n")
    : [
        `🎉 Welcome: ${username}`,
        "",
        "1. Please make me an administrator, otherwise I cannot work properly",
        "",
        ...permissionLines,
        ...missingLines,
        "",
        "1) Click the button below to open settings (admins only)",
        "2) Then tap the [Start] button in the bot chat",
        "",
        `Chat: <b>${title}</b>`
      ].join("\n");
}

function isActiveChatMemberStatus(status: string): boolean {
  return status === "member" || status === "administrator" || status === "creator";
}

function isInactiveChatMemberStatus(status: string): boolean {
  return status === "left" || status === "kicked";
}

function resolveLocaleCode(languageCode: string | null | undefined): Locale {
  if (!languageCode) return "en";
  return languageCode.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

async function getLocale(ctx: Context): Promise<Locale> {
  if (!ctx.from) return "en";
  const stored = await getTelegramUserLanguageCode(ctx.from.id);
  return resolveLocaleCode(stored ?? ctx.from.language_code);
}

const languageOptions = [
  { label: "🇬🇧 English", code: "en" },
  { label: "🇷🇺 Русский language", code: "ru" },
  { label: "🇮🇹 Italiano", code: "it" },
  { label: "🇪🇸 Español", code: "es" },
  { label: "🇵🇹 Português", code: "pt" },
  { label: "🇩🇪 Deutsch", code: "de" },
  { label: "🇫🇷 Français", code: "fr" },
  { label: "🇮🇩 Indonesia", code: "id" },
  { label: "🇹🇷 Türkçe", code: "tr" },
  { label: "🇺🇦 українська", code: "uk" },
  { label: "🇺🇿 oʻzbekcha", code: "uz" },
  { label: "🇸🇦 عربي", code: "ar" },
  { label: "🇮🇷 فارسی", code: "fa" },
  { label: "🇦🇿 Azərbaycanca", code: "az" },
  { label: "🇲🇾 Melayu", code: "ms" },
  { label: "🇲🇲 မြန်မာဘာသာ", code: "my" },
  { label: "🇮🇳 हिन्दी或हिंदी", code: "hi" },
  { label: "🇰🇿 қазақ", code: "kk" },
  { label: "🇨🇳 简体中文", code: "zh-CN" },
  { label: "🇨🇳 繁体中文", code: "zh-TW" },
  { label: "🇯🇵 にほんご", code: "ja" },
  { label: "🇰🇷 한국어", code: "ko" },
  { label: "🇻🇳 Tiếng Việt", code: "vi" },
  { label: "🇹🇭 ภาษาไทย", code: "th" }
] as const;

function mainMenuText(locale: Locale, firstName?: string, botUsername = "DarvisXBot") {
  const name = escapeHtml(firstName?.trim() || (locale === "zh-CN" ? "管理员" : "admin"));
  const username = escapeHtml(botUsername.replace(/^@/, ""));
  const botLink = `https://t.me/${encodeURIComponent(username)}`;
  return locale === "zh-CN"
    ? [
        `👋 嗨，<b>${name}</b>！`,
        `<a href="${botLink}">@${username}</a> 能帮你便捷安全地<b>管理频道和群组</b>，是TG上领先的管理的机器人之一！`,
        "",
        "➡️ 请赋予我频道/群组<b>管理员权限！</b>"
      ].join("\n")
    : [
        `👋 Hi, <b>${name}</b>!`,
        `<a href="${botLink}">@${username}</a> helps you safely manage <b>channels and groups</b>.`,
        "",
        "➡️ Please grant me <b>admin permissions</b> in your channel or group."
      ].join("\n");
}

function mainMenuKeyboard(locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "📢 设置频道" : "📢 Channels", "menu:channels")
    .text(locale === "zh-CN" ? "👥 设置群组" : "👥 Groups", "menu:groups")
    .row()
    .text(locale === "zh-CN" ? "📝 快捷发布" : "📝 Publish", "menu:publish")
    .text(locale === "zh-CN" ? "💎 订阅会员" : "💎 Memberships", "menu:memberships")
    .row()
    .text(locale === "zh-CN" ? "🌍 设置时区" : "🌍 Timezone", "menu:timezone")
    .text("🇨🇳 Languages", "menu:languages");
}

function homeKeyboard(locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "🏠 首页" : "🏠 Home", "menu:home");
}

function languageKeyboard(locale: Locale) {
  const keyboard = new InlineKeyboard();
  languageOptions.forEach((language, index) => {
    if (index > 0 && index % 2 === 0) keyboard.row();
    keyboard.text(language.label, `menu:lang:${language.code}`);
  });
  return keyboard
    .row()
    .text(locale === "zh-CN" ? "🌍 设置时区" : "🌍 Timezone", "menu:timezone")
    .text(locale === "zh-CN" ? "🏠 首页" : "🏠 Home", "menu:home");
}

function managedChatKeyboard(chats: PrismaChat[], scope: "group" | "channel", locale: Locale, botUsername: string) {
  const keyboard = new InlineKeyboard();
  for (const chat of chats) {
    const title = chat.title ?? chat.username ?? String(chat.telegramChatId);
    keyboard.text(title.slice(0, 64), `menu:chat:${scope}:${chat.id}`).row();
  }
  const addLabel = scope === "group"
    ? (locale === "zh-CN" ? "➕ 添加群组" : "➕ Add group")
    : (locale === "zh-CN" ? "➕ 添加频道" : "➕ Add channel");
  const addUrl = scope === "group" ? buildAddGroupUrl(botUsername) : buildAddChannelUrl(botUsername);
  return keyboard
    .url(addLabel, addUrl)
    .row()
    .text(locale === "zh-CN" ? "🏠 首页" : "🏠 Home", "menu:home");
}

function buildBotMention(botUsername: string) {
  const username = escapeHtml(botUsername.replace(/^@/, ""));
  return `<a href="https://t.me/${encodeURIComponent(username)}">@${username}</a>`;
}

function buildGroupGuideText(locale: Locale, botUsername: string) {
  const mention = buildBotMention(botUsername);
  return locale === "zh-CN"
    ? [
        "ℹ️ <b>指南</b>",
        `想要在群组中使用 ${mention} 的功能，只需把这个机器人添加到您的群组并授予<b>管理消息</b>等权限。`,
        "",
        "⚠️ <b>注意</b>： 如果把这个Bot添加到群组后没有来自这个机器人任何通知，您可以在群组中发送 /reload 尝试。"
      ].join("\n")
    : [
        "ℹ️ <b>Guide</b>",
        `To use ${mention} in a group, add this bot to your group and grant <b>manage messages</b> and related permissions.`,
        "",
        "⚠️ <b>Note</b>: If no notification appears after adding the bot, try sending /reload in the group."
      ].join("\n");
}

function buildChannelGuideText(locale: Locale, botUsername: string) {
  const mention = buildBotMention(botUsername);
  return locale === "zh-CN"
    ? [
        "ℹ️ <b>指南</b>",
        `想要在频道中使用 ${mention} 的功能，只需把这个机器人添加到您的频道并授予<b>管理消息</b>等权限。`,
        "",
        "⚠️ <b>注意</b>： 如果把这个Bot添加到频道后没有来自这个机器人任何通知，您需要删除并重新添加Bot。"
      ].join("\n")
    : [
        "ℹ️ <b>Guide</b>",
        `To use ${mention} in a channel, add this bot to your channel and grant <b>manage messages</b> and related permissions.`,
        "",
        "⚠️ <b>Note</b>: If no notification appears after adding the bot, remove it and add it again."
      ].join("\n");
}

function buildAddGroupUrl(botUsername: string) {
  const username = encodeURIComponent(botUsername.replace(/^@/, ""));
  const admin = [
    "change_info",
    "post_messages",
    "edit_messages",
    "delete_messages",
    "restrict_members",
    "invite_users",
    "pin_messages",
    "promote_members",
    "anonymous",
    "manage_chat"
  ].join("+");
  return `https://t.me/${username}?startgroup&admin=${admin}`;
}

function buildAddChannelUrl(botUsername: string) {
  const username = encodeURIComponent(botUsername.replace(/^@/, ""));
  const admin = [
    "change_info",
    "post_messages",
    "edit_messages",
    "delete_messages",
    "restrict_members",
    "invite_users",
    "pin_messages",
    "manage_topics",
    "promote_members",
    "manage_video_chats",
    "anonymous",
    "manage_chat",
    "post_stories",
    "edit_stories",
    "delete_stories"
  ].join("+");
  return `https://t.me/${username}?startchannel&admin=${admin}`;
}

function timezoneSummaryKeyboard(locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "🔧 设置" : "🔧 Set", "menu:timezone:settings")
    .row()
    .text(locale === "zh-CN" ? "🏠 首页" : "🏠 Home", "menu:home");
}

function timezonePromptKeyboard(locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "❌ 取消" : "❌ Cancel", "menu:timezone:cancel");
}

function timezoneSavedKeyboard(locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "🔙返回" : "🔙Back", "menu:timezone");
}

function timezoneSavedText(locale: Locale) {
  return locale === "zh-CN" ? "✅ 设置成功，点击按钮返回。" : "✅ Saved. Tap the button to return.";
}
function timezoneSummaryText(timezone: string, locale: Locale) {
  return locale === "zh-CN"
    ? `<b>您的默认时区</b>: ${escapeHtml(timezone)}\n<b>当前时间</b>: ${formatTimezoneNow(timezone)}`
    : `<b>Your default timezone</b>: ${escapeHtml(timezone)}\n<b>Current time</b>: ${formatTimezoneNow(timezone)}`;
}

function timezonePromptText(locale: Locale) {
  return locale === "zh-CN"
    ? [
        "🌎时区",
        "",
        "<b>方式1</b>. 输入 <b>城市</b> 名称，系统会自动转换为对应的时区",
        "",
        "<b>方式2</b>. 点击 📎 附件 - 位置，拖动地图发送您设置的位置",
        "",
        "你的位置不会被保存，我们只会保存检测到的时区信息。",
        "",
        "<b>请输入：</b>"
      ].join("\n")
    : [
        "🌎 Timezone",
        "",
        "<b>Option 1</b>. Enter a <b>city</b> name and the bot will convert it to a timezone.",
        "",
        "<b>Option 2</b>. Send your location from the attachment menu.",
        "",
        "Your location is not stored. Only the detected timezone is saved.",
        "",
        "<b>Enter:</b>"
      ].join("\n");
}

function publishHomeText(locale: Locale) {
  return locale === "zh-CN"
    ? ["✏️ <b>快捷发布</b>", "设置帖子文字、媒体、按钮等参数"].join("\n")
    : ["✏️ <b>Quick Publish</b>", "Set post text, media, buttons and other parameters."].join("\n");
}

function publishHomeKeyboard(locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "➕ 添加" : "➕ Add", "publish:add")
    .row()
    .text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", "menu:home");
}

function publishSummaryText(locale: Locale, draft: PublishDraft, botUsername: string, userId: number) {
  const username = escapeHtml(botUsername.replace(/^@/, ""));
  const inlineCode = `@${username} ${publishInlineQuery(userId)}`;
  const hasMedia = Boolean(draft.mediaFileId);
  const hasButton = Boolean(draft.buttonText && draft.buttonUrl);
  const hasText = Boolean(draft.text.trim());
  return locale === "zh-CN"
    ? [
        "✏️ <b>快捷发布</b>",
        "设置帖子文字、媒体、按钮等参数",
        `<b>消息</b>1 名称:${escapeHtml(draft.name || "-")}`,
        `├<b>媒体图片</b>: ${hasMedia ? "✅" : "❌"}`,
        `├<b>链接按钮</b>: ${hasButton ? "✅" : "❌"}`,
        `├<b>文本内容</b>: ${hasText ? "✅" : "❌"}`,
        `└<b>内联分享</b>: <code>${inlineCode}</code>`
      ].join("\n")
    : [
        "✏️ <b>Quick Publish</b>",
        "Set post text, media, buttons and other parameters.",
        `<b>Message</b>1 name:${escapeHtml(draft.name || "-")}`,
        `├<b>Media</b>: ${hasMedia ? "✅" : "❌"}`,
        `├<b>Link button</b>: ${hasButton ? "✅" : "❌"}`,
        `├<b>Text content</b>: ${hasText ? "✅" : "❌"}`,
        `└<b>Inline share</b>: <code>${inlineCode}</code>`
      ].join("\n");
}

function publishSummaryKeyboard(locale: Locale, userId: number) {
  const inlineQuery = publishInlineQuery(userId);
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "💬 消息1" : "💬 Message1", "publish:message:1")
    .text(locale === "zh-CN" ? "🔧 设置" : "🔧 Settings", "publish:settings")
    .text(locale === "zh-CN" ? "删除🗑️" : "Delete🗑️", "publish:delete")
    .switchInlineCurrent(locale === "zh-CN" ? "分享" : "Share", inlineQuery)
    .row()
    .text(locale === "zh-CN" ? "➕ 添加" : "➕ Add", "publish:add")
    .row()
    .text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", "menu:publish");
}

function publishSettingsText(locale: Locale, draft: PublishDraft) {
  const hasMedia = Boolean(draft.mediaFileId);
  const hasButton = Boolean(draft.buttonText && draft.buttonUrl);
  const hasText = Boolean(draft.text.trim());
  return locale === "zh-CN"
    ? [
        "✏️ <b>快捷发布</b>",
        "",
        "通过此菜单,你可以配置消息的发送参数",
        "",
        `<b>消息名称</b>:<b>${escapeHtml(draft.name || "-")}</b>`,
        "",
        `🖼 <b>媒体图片</b>: ${hasMedia ? "✅" : "❌"}`,
        `🔗 <b>链接按钮</b>: ${hasButton ? "✅" : "❌"}`,
        `📃 <b>文本内容</b>: ${hasText ? "✅" : "❌"}`
      ].join("\n")
    : [
        "✏️ <b>Quick Publish</b>",
        "",
        "Use this menu to configure message sending parameters.",
        "",
        `<b>Message name</b>:<b>${escapeHtml(draft.name || "-")}</b>`,
        "",
        `🖼 <b>Media</b>: ${hasMedia ? "✅" : "❌"}`,
        `🔗 <b>Link button</b>: ${hasButton ? "✅" : "❌"}`,
        `📃 <b>Text content</b>: ${hasText ? "✅" : "❌"}`
      ].join("\n");
}

function publishSettingsKeyboard(locale: Locale, userId: number) {
  const inlineQuery = publishInlineQuery(userId);
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "✍️ 编辑消息名称" : "✍️ Edit name", "publish:edit_name")
    .row()
    .text(locale === "zh-CN" ? "📃 修改文本" : "📃 Edit text", "publish:edit_text")
    .text(locale === "zh-CN" ? "📷 修改媒体" : "📷 Edit media", "publish:edit_media")
    .row()
    .text(locale === "zh-CN" ? "🔠 修改按钮" : "🔠 Edit button", "publish:edit_button")
    .text(locale === "zh-CN" ? "👀 预览消息" : "👀 Preview", "publish:preview")
    .row()
    .text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", "publish:list")
    .switchInlineCurrent(locale === "zh-CN" ? "分享" : "Share", inlineQuery);
}

function publishTextInputKeyboard(locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "🚫 清空消息文本" : "🚫 Clear text", "publish:clear_text")
    .text(locale === "zh-CN" ? "❌取消" : "❌ Cancel", "publish:cancel");
}

function publishMediaInputKeyboard(locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "🚫 清空媒体" : "🚫 Clear media", "publish:clear_media")
    .text(locale === "zh-CN" ? "❌取消" : "❌ Cancel", "publish:cancel");
}

function publishButtonInputKeyboard(locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "🚫 清空按钮" : "🚫 Clear button", "publish:clear_button")
    .text(locale === "zh-CN" ? "❌取消" : "❌ Cancel", "publish:cancel");
}

function publishCancelKeyboard(locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "❌取消" : "❌ Cancel", "publish:cancel");
}

function publishSuccessText(locale: Locale) {
  return locale === "zh-CN"
    ? "✅ 设置成功，点击按钮返回。"
    : "✅ Saved. Tap the button to return.";
}

function publishSuccessKeyboard(locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", "publish:settings");
}

function publishNamePromptText(draft: PublishDraft, locale: Locale) {
  return locale === "zh-CN"
    ? [
        "当前已设置的消息名称（点击复制）:",
        "",
        escapeHtml(draft.name),
        "",
        "➡️ 现在输入文本设置你的消息名称"
      ].join("\n")
    : [
        "Current message name:",
        "",
        escapeHtml(draft.name),
        "",
        "➡️ Send text to set the message name."
      ].join("\n");
}

function publishTextPromptText(draft: PublishDraft, locale: Locale) {
  return locale === "zh-CN"
    ? [
        "当前已设置的备注内容（点击复制）:",
        "",
        escapeHtml(draft.text),
        "",
        "➡️ 现在输入文本设置你的备注内容"
      ].join("\n")
    : [
        "Current text content:",
        "",
        escapeHtml(draft.text),
        "",
        "➡️ Send text to set the message content."
      ].join("\n");
}

function publishButtonPromptText(draft: PublishDraft, locale: Locale) {
  const current = draft.buttonText && draft.buttonUrl ? `${draft.buttonText} | ${draft.buttonUrl}` : "";
  return locale === "zh-CN"
    ? [
        "当前已设置的按钮（点击复制）:",
        "",
        escapeHtml(current),
        "",
        "➡️ 现在输入按钮，格式：",
        "<code>按钮文字 | https://example.com</code>"
      ].join("\n")
    : [
        "Current button:",
        "",
        escapeHtml(current),
        "",
        "➡️ Send a button in this format:",
        "<code>Button text | https://example.com</code>"
      ].join("\n");
}

function publishMediaPromptText(locale: Locale) {
  return locale === "zh-CN"
    ? "请回复图片、视频、gif 、贴纸进行设置"
    : "Reply with a photo, video, GIF, or sticker to set media.";
}

function membershipPanelText(locale: Locale) {
  return locale === "zh-CN"
    ? [
        "💎 <b>订阅会员</b>",
        "这里用于管理会员套餐、有效期和到期提醒。",
        "",
        "请选择一个套餐查看详情："
      ].join("\n")
    : [
        "💎 <b>Memberships</b>",
        "Manage membership plans, expiration and reminders here.",
        "",
        "Choose a plan to view details:"
      ].join("\n");
}

function membershipPanelKeyboard(locale: Locale) {
  return new InlineKeyboard()
    .text("10U 1个月", "membership:plan:1m")
    .text("29U 3个月", "membership:plan:3m")
    .row()
    .text("55U 6个月", "membership:plan:6m")
    .text("100U 1年", "membership:plan:12m")
    .row()
    .text(locale === "zh-CN" ? "🏠 首页" : "🏠 Home", "menu:home");
}

function chatPanelKeyboard(chatId: string, scope: "group" | "channel", locale: Locale) {
  const keyboard = new InlineKeyboard();

  if (scope === "group") {
    keyboard
      .text(locale === "zh-CN" ? "⏰ 定时消息" : "⏰ Scheduled", `chat_feature:scheduled:${chatId}`)
      .text(locale === "zh-CN" ? "💬 自动回复" : "💬 Auto reply", `chat_feature:auto_reply:${chatId}`)
      .row()
      .text(locale === "zh-CN" ? "🤖 进群验证" : "🤖 Join verify", `chat_feature:join_verify:${chatId}`)
      .text(locale === "zh-CN" ? "🎉 进群欢迎" : "🎉 Welcome", `chat_feature:welcome:${chatId}`)
      .row()
      .text(locale === "zh-CN" ? "⚙️ 控制权限" : "⚙️ Permissions", `chat_feature:permissions:${chatId}`)
      .text(locale === "zh-CN" ? "🔗 邀请链接" : "🔗 Invite links", `chat_feature:invite:${chatId}`)
      .row()
      .text(locale === "zh-CN" ? "📊 群组统计" : "📊 Group stats", `chat_feature:stats:${chatId}`)
      .text(locale === "zh-CN" ? "📈 人数统计" : "📈 Member stats", `chat_feature:member_stats:${chatId}`)
      .row()
      .text(locale === "zh-CN" ? "🌙 夜间模式" : "🌙 Night mode", `chat_feature:night_mode:${chatId}`)
      .text(locale === "zh-CN" ? "💻 群组命令" : "💻 Commands", `chat_feature:commands:${chatId}`)
      .row()
      .text(locale === "zh-CN" ? "🧹 自动删除" : "🧹 Auto delete", `chat_feature:auto_delete:${chatId}`)
      .text(locale === "zh-CN" ? "🔦 发言检查" : "🔦 Speech check", `chat_feature:speech_check:${chatId}`)
      .row()
      .text(locale === "zh-CN" ? "🔇 违禁词" : "🔇 Banned words", `chat_feature:banned_words:${chatId}`)
      .text(locale === "zh-CN" ? "📨 反垃圾" : "📨 Anti-spam", `chat_feature:anti_spam:${chatId}`)
      .row()
      .text(locale === "zh-CN" ? "🎁 抽奖" : "🎁 Giveaway", `chat_feature:giveaway:${chatId}`)
      .text(locale === "zh-CN" ? "Ⓜ️ 积分" : "Ⓜ️ Points", `chat_feature:points:${chatId}`)
      .row()
      .text(locale === "zh-CN" ? "🚫 屏蔽" : "🚫 Block", `chat_feature:block:${chatId}`)
      .text(locale === "zh-CN" ? "📋 导入配置" : "📋 Import config", `chat_feature:import:${chatId}`)
      .row()
      .text(locale === "zh-CN" ? "👥 群组&成员" : "👥 Members", `chat_feature:members:${chatId}`)
      .text(locale === "zh-CN" ? "🔒 新成员限制" : "🔒 New member limits", `chat_feature:new_member_limit:${chatId}`)
      .row()
      .text(locale === "zh-CN" ? "🔐 开关群" : "🔐 Open/close", `chat_feature:open_close:${chatId}`)
      .text(locale === "zh-CN" ? "🔞 色情检测" : "🔞 Adult check", `chat_feature:adult_check:${chatId}`)
      .row();
  } else {
    keyboard
      .text(locale === "zh-CN" ? "⏰ 定时消息" : "⏰ Scheduled", `chat_feature:scheduled:${chatId}`)
      .text(locale === "zh-CN" ? "🔊 频道同步" : "🔊 Channel sync", `chat_feature:sync:${chatId}`)
      .row()
      .text(locale === "zh-CN" ? "➕ 自动按钮" : "➕ Auto button", `chat_feature:auto_button:${chatId}`)
      .text(locale === "zh-CN" ? "🔠 修改按钮" : "🔠 Edit buttons", `chat_feature:edit_button:${chatId}`)
      .row()
      .text(locale === "zh-CN" ? "🧹 自动删除" : "🧹 Auto delete", `chat_feature:auto_delete:${chatId}`)
      .text(locale === "zh-CN" ? "⚙️ 控制权限" : "⚙️ Permissions", `chat_feature:permissions:${chatId}`)
      .row()
      .text(locale === "zh-CN" ? "🚫 屏蔽" : "🚫 Block", `chat_feature:block:${chatId}`)
      .text(locale === "zh-CN" ? "📋 导入配置" : "📋 Import config", `chat_feature:import:${chatId}`)
      .row()
      .text(locale === "zh-CN" ? "📈 人数统计" : "📈 Member stats", `chat_feature:member_stats:${chatId}`)
      .text(locale === "zh-CN" ? "🛋️ 评论沙发" : "🛋️ Comment sofa", `chat_feature:comment_sofa:${chatId}`)
      .row();
  }

  const switchLabel = scope === "channel"
    ? (locale === "zh-CN" ? "🔄 切换频道" : "🔄 Switch channel")
    : (locale === "zh-CN" ? "🔄 切换群" : "🔄 Switch group");

  return keyboard
    .text(switchLabel, `menu:${scope}s`)
    .text("🇨🇳 Languages", "menu:languages");
}

function blocklistKeyboard(chatId: string, settings: BlocklistSettings, locale: Locale) {
  const mark = (enabled: boolean, text: string) => `${enabled ? "✅" : "⬜"} ${text}`;
  return new InlineKeyboard()
    .text(mark(settings.blockBots, locale === "zh-CN" ? "🤖 屏蔽机器人" : "🤖 Block bots"), `blocklist:toggle:blockBots:${chatId}`)
    .text(mark(settings.banAfterLeave, locale === "zh-CN" ? "🚪 退群封禁" : "🚪 Ban leavers"), `blocklist:toggle:banAfterLeave:${chatId}`)
    .row()
    .text(mark(settings.blockFlashJoinLeave, locale === "zh-CN" ? "🏃 屏蔽闪进闪退" : "🏃 Block flash join/leave"), `blocklist:toggle:blockFlashJoinLeave:${chatId}`)
    .row()
    .text(mark(settings.blockFollowerRaid, locale === "zh-CN" ? "👨‍👩‍👧‍👦 屏蔽刷粉攻击" : "👨‍👩‍👧‍👦 Block join raids"), `blocklist:toggle:blockFollowerRaid:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "🏠 返回首页" : "🏠 Home", "menu:home")
    .text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `menu:chat:group:${chatId}`);
}

function welcomeKeyboard(chatId: string, settings: WelcomeSettings, locale: Locale) {
  return new InlineKeyboard()
    .text(settings.enabled ? "✅ On" : "⬜ Off", `welcome:toggle:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `menu:chat:group:${chatId}`);
}

function joinVerifyKeyboard(chatId: string, settings: JoinVerifySettings, locale: Locale) {
  return new InlineKeyboard()
    .text(settings.enabled ? "✅ On" : "⬜ Off", `join_verify:toggle:${chatId}`)
    .text(settings.adminApproval ? "✅ Admin approval" : "⬜ Admin approval", `join_verify:approval:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `menu:chat:group:${chatId}`);
}

function autoDeleteKeyboard(chatId: string, settings: AutoDeleteSettings, locale: Locale) {
  return new InlineKeyboard()
    .text(settings.enabled ? "✅ On" : "⬜ Off", `auto_delete:toggle:${chatId}`)
    .row()
    .text(`${settings.seconds || 0}s`, "auto_delete:noop")
    .text("30s", `auto_delete:seconds:30:${chatId}`)
    .text("60s", `auto_delete:seconds:60:${chatId}`)
    .text("300s", `auto_delete:seconds:300:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `menu:chat:group:${chatId}`);
}

function autoReplyKeyboard(chatId: string, settings: AutoReplySettings, locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "状态:" : "Status:", `auto_reply:noop:${chatId}`)
    .text(settings.enabled ? "✅开启" : "开启", `auto_reply:toggle:${chatId}:on`)
    .text(!settings.enabled ? "✅关闭" : "关闭", `auto_reply:toggle:${chatId}:off`)
    .row()
    .text(locale === "zh-CN" ? "删除消息(分钟)⬇️" : "Delete reply (minutes) ⬇️", `auto_reply:noop:${chatId}`)
    .row()
    .text(settings.deleteAfterMinutes === 0 ? "✅否" : "否", `auto_reply:delete_after:${chatId}:0`)
    .text(settings.deleteAfterMinutes === 1 ? "✅1" : "1", `auto_reply:delete_after:${chatId}:1`)
    .text(settings.deleteAfterMinutes === 5 ? "✅5" : "5", `auto_reply:delete_after:${chatId}:5`)
    .text(settings.deleteAfterMinutes === 10 ? "✅10" : "10", `auto_reply:delete_after:${chatId}:10`)
    .row()
    .text(
      settings.deletePreviousMessage
        ? (locale === "zh-CN" ? "✅删除上一条" : "✅Delete previous")
        : (locale === "zh-CN" ? "删除上一条" : "Delete previous"),
      `auto_reply:delete_previous:${chatId}:${settings.deletePreviousMessage ? "off" : "on"}`
    )
    .row()
    .text(locale === "zh-CN" ? "📌关键词列表" : "📌Keyword list", `auto_reply:delete:${chatId}`)
    .text(locale === "zh-CN" ? "✍ 添加" : "✍ Add", `auto_reply:add:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `menu:chat:group:${chatId}`);
}

function autoReplyDeleteKeyboard(chatId: string, settings: AutoReplySettings, locale: Locale) {
  const keyboard = new InlineKeyboard();
  settings.rules.forEach((rule, index) => {
    const prefix = rule.matchType === "exact" ? "-" : "*";
    keyboard.text(`${index + 1}. ${prefix}${rule.keyword}`.slice(0, 64), `auto_reply:delete_rule:${chatId}:${rule.id}`).row();
  });
  return keyboard.text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `chat_feature:auto_reply:${chatId}`);
}

function autoReplyCancelKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `auto_reply:cancel:${chatId}`);
}

function autoReplyButtonsKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard().text(
    locale === "zh-CN" ? "♻️ 不设置，跳过" : "♻️ Skip buttons",
    `auto_reply:skip_buttons:${chatId}`
  );
}

async function handleMenuCallback(ctx: Context, config: AppConfig) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const locale = await getLocale(ctx);
  const parts = data.split(":");
  const action = parts[1];

  if (action === "home") {
    await editOrReply(ctx, mainMenuText(locale, ctx.from?.first_name, config.botUsername), mainMenuKeyboard(locale));
    return;
  }

  if (action === "languages") {
    await editOrReply(ctx, "Select your Language", languageKeyboard(locale));
    return;
  }

  if (action === "lang" && parts[2] && ctx.from) {
    const languageCode = parts[2];
    const languageName = languageOptions.find((item) => item.code === languageCode)?.label ?? languageCode;
    await updateUserLanguage(ctx.from.id, languageCode);
    await editOrReply(
      ctx,
      resolveLocaleCode(languageCode) === "zh-CN"
        ? `语言已设置为：${languageName}`
        : `Language set to: ${languageName}`,
      mainMenuKeyboard(resolveLocaleCode(languageCode))
    );
    return;
  }

  if (action === "timezone") {
    if (parts[2] === "settings") {
      if (ctx.from) {
        clearUserInputState(ctx.from.id);
        timezoneInputUsers.add(ctx.from.id);
      }
      await editOrReply(ctx, timezonePromptText(locale), timezonePromptKeyboard(locale));
      return;
    }
    if (parts[2] === "cancel") {
      if (ctx.from) timezoneInputUsers.delete(ctx.from.id);
      const timezone = await getUserTimezone(ctx, config.defaultTimezone);
      await editOrReply(ctx, timezoneSummaryText(timezone, locale), timezoneSummaryKeyboard(locale));
      return;
    }

    const timezone = await getUserTimezone(ctx, config.defaultTimezone);
    await editOrReply(ctx, timezoneSummaryText(timezone, locale), timezoneSummaryKeyboard(locale));
    return;
  }

  if (action === "publish") {
    await renderPublishHome(ctx, locale);
    return;
  }

  if (action === "memberships") {
    await editOrReply(ctx, membershipPanelText(locale), membershipPanelKeyboard(locale));
    return;
  }

  if (action === "groups" || action === "channels") {
    await showManagedChats(ctx, action === "groups" ? "group" : "channel", locale, config.botUsername);
    return;
  }

  if (action === "chat" && parts[2] && parts[3]) {
    const scope = parts[2] === "channel" ? "channel" : "group";
    const chat = await prisma.chat.findUnique({ where: { id: parts[3] } });
    if (!chat) {
      await editOrReply(ctx, locale === "zh-CN" ? "找不到该管理对象。" : "Managed chat not found.", homeKeyboard(locale));
      return;
    }
    rememberSelectedChatForModules(ctx.from?.id, chat.id);
    await editOrReply(ctx, chatPanelText(chat, locale), chatPanelKeyboard(chat.id, scope, locale));
    return;
  }

  await editOrReply(ctx, locale === "zh-CN" ? "该功能正在开发中。" : "This feature is under development.", homeKeyboard(locale));
}

async function handlePublishCallback(ctx: Context, config: AppConfig) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  if (!ctx.from) return;
  const locale = await getLocale(ctx);
  const action = ctx.callbackQuery?.data?.replace("publish:", "") ?? "";

  if (action === "add") {
    getPublishDraft(ctx.from.id);
    await renderPublishSummary(ctx, locale, config.botUsername);
    return;
  }

  if (action === "list") {
    await renderPublishSummary(ctx, locale, config.botUsername);
    return;
  }

  if (action === "message:1" || action === "settings") {
    getPublishDraft(ctx.from.id);
    await renderPublishSettings(ctx, locale);
    return;
  }

  const draft = getPublishDraft(ctx.from.id);

  if (action === "edit_name") {
    draft.waitingFor = "name";
    await editOrReply(ctx, publishNamePromptText(draft, locale), publishCancelKeyboard(locale));
    return;
  }

  if (action === "edit_text") {
    draft.waitingFor = "text";
    await editOrReply(ctx, publishTextPromptText(draft, locale), publishTextInputKeyboard(locale));
    return;
  }

  if (action === "edit_media") {
    draft.waitingFor = "media";
    await editOrReply(ctx, publishMediaPromptText(locale), publishMediaInputKeyboard(locale));
    return;
  }

  if (action === "edit_button") {
    draft.waitingFor = "button";
    await editOrReply(ctx, publishButtonPromptText(draft, locale), publishButtonInputKeyboard(locale));
    return;
  }

  if (action === "clear_text") {
    draft.text = "";
    draft.waitingFor = undefined;
    await editOrReply(ctx, publishSuccessText(locale), publishSuccessKeyboard(locale));
    return;
  }

  if (action === "clear_media") {
    draft.mediaKind = undefined;
    draft.mediaFileId = undefined;
    draft.waitingFor = undefined;
    await editOrReply(ctx, publishSuccessText(locale), publishSuccessKeyboard(locale));
    return;
  }

  if (action === "clear_button") {
    draft.buttonText = "";
    draft.buttonUrl = "";
    draft.waitingFor = undefined;
    await editOrReply(ctx, publishSuccessText(locale), publishSuccessKeyboard(locale));
    return;
  }

  if (action === "delete") {
    publishDrafts.delete(ctx.from.id);
    await renderPublishHome(ctx, locale);
    return;
  }

  if (action === "cancel") {
    draft.waitingFor = undefined;
    await renderPublishSettings(ctx, locale);
    return;
  }

  if (action === "preview") {
    draft.waitingFor = undefined;
    await sendPublishPreview(ctx, draft, locale);
    return;
  }

  await renderPublishHome(ctx, locale);
}

async function handleMembershipCallback(ctx: Context) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const locale = await getLocale(ctx);
  const plan = ctx.callbackQuery?.data?.split(":")[2] ?? "";
  const labels: Record<string, string> = {
    "1m": "10U 1个月",
    "3m": "29U 3个月",
    "6m": "55U 6个月",
    "12m": "100U 1年"
  };
  const label = labels[plan] ?? (locale === "zh-CN" ? "会员套餐" : "Membership plan");
  await editOrReply(
    ctx,
    locale === "zh-CN"
      ? `💎 <b>${escapeHtml(label)}</b>\n\n该套餐按钮已接入菜单，支付和自动开通流程后续可继续配置。`
      : `💎 <b>${escapeHtml(label)}</b>\n\nThis plan button is wired. Payment and auto-activation can be configured next.`,
    membershipPanelKeyboard(locale)
  );
}

async function handleScheduledCallback(ctx: Context) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const locale = await getLocale(ctx);
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const [, action, id, value] = data.split(":");
  if (!action || !id) return;

  if (action === "list_message") {
    const scheduled = await prisma.scheduledMessage.findUnique({
      where: { id },
      include: { chat: true }
    });
    if (!scheduled) return;
    await openScheduledMessagePanel(ctx, locale, scheduled.chat);
    return;
  }

  if (action === "list" || action === "back") {
    const chat = await prisma.chat.findUnique({ where: { id } });
    if (!chat) return;
    await openScheduledMessagePanel(ctx, locale, chat);
    return;
  }

  if (action === "add") {
    const chat = await prisma.chat.findUnique({ where: { id } });
    if (!chat) return;
    const repeatRule = defaultScheduledRepeatRule();
    const sendAt = nextScheduledRun(repeatRule, new Date()) ?? new Date(Date.now() + repeatRule.intervalMinutes * 60_000);
    const scheduled = await prisma.scheduledMessage.create({
      data: {
        chatId: chat.id,
        contentType: "text",
        content: scheduledContentToJson(defaultScheduledContent()),
        buttons: [],
        repeatRule: scheduledRepeatRuleToJson(repeatRule),
        sendAt,
        status: ScheduledMessageStatus.DRAFT
      }
    });
    await renderScheduledMessageSettings(ctx, locale, scheduled.id);
    return;
  }

  if (action === "open") {
    await renderScheduledMessageSettings(ctx, locale, id);
    return;
  }

  if (action === "interval") {
    await openScheduledIntervalPanel(ctx, locale, id);
    return;
  }

  if (action === "set_interval") {
    const minutes = Number(value);
    if (!Number.isSafeInteger(minutes) || minutes <= 0) return;
    const scheduled = await prisma.scheduledMessage.findUnique({ where: { id } });
    if (!scheduled) return;
    const repeatRule = parseScheduledRepeatRule(scheduled.repeatRule);
    delete repeatRule.cron;
    await saveScheduledRepeatRule(id, { ...repeatRule, intervalMinutes: minutes });
    await renderScheduledMessageSettings(ctx, locale, id);
    return;
  }

  if (action === "cron") {
    const scheduled = await prisma.scheduledMessage.findUnique({ where: { id } });
    if (!scheduled || !ctx.from) return;
    clearUserInputState(ctx.from.id);
    scheduledInputDrafts.set(ctx.from.id, { scheduledMessageId: id, field: "cron" });
    await editOrReply(ctx, scheduledCronPromptText(parseScheduledRepeatRule(scheduled.repeatRule), locale), scheduledInputKeyboard("cron", id, locale));
    return;
  }

  if (action === "bulk") {
    const chat = await prisma.chat.findUnique({ where: { id } });
    if (!chat) return;
    await openScheduledBulkPanel(ctx, locale, chat);
    return;
  }

  if (action === "bulk_on") {
    const chat = await prisma.chat.findUnique({ where: { id } });
    if (!chat) return;
    const result = await bulkEnableScheduledMessages(chat.id);
    await openScheduledBulkPanel(ctx, locale, chat, scheduledBulkResultText(result, locale));
    return;
  }

  if (action === "bulk_off") {
    const chat = await prisma.chat.findUnique({ where: { id } });
    if (!chat) return;
    const count = await bulkDisableScheduledMessages(chat.id);
    await openScheduledBulkPanel(ctx, locale, chat, scheduledBulkDisabledText(count, locale));
    return;
  }

  if (action === "bulk_delete_confirm") {
    const chat = await prisma.chat.findUnique({ where: { id } });
    if (!chat) return;
    await editOrReply(ctx, scheduledBulkDeleteConfirmText(chat, locale), scheduledBulkDeleteConfirmKeyboard(chat.id, locale));
    return;
  }

  if (action === "bulk_delete") {
    const chat = await prisma.chat.findUnique({ where: { id } });
    if (!chat) return;
    const count = await bulkDeleteScheduledMessages(chat.id);
    await openScheduledBulkPanel(ctx, locale, chat, scheduledBulkDeletedText(count, locale));
    return;
  }

  if (action === "example") {
    await ctx.answerCallbackQuery({
      text: value === "2"
        ? "链接名称1-https://t.me/xxx && 链接名称2-https://t.me/xxx"
        : "链接名称-https://t.me/xxx",
      show_alert: true
    }).catch(() => undefined);
    return;
  }

  const scheduled = await prisma.scheduledMessage.findUnique({ where: { id }, include: { chat: true } });
  if (!scheduled) {
    await editOrReply(ctx, locale === "zh-CN" ? "找不到这条定时消息。" : "Scheduled message not found.", homeKeyboard(locale));
    return;
  }

  if (action === "noop") return;

  if (action === "list_toggle") {
    if (value === "on") {
      const content = parseScheduledContent(scheduled.content);
      if (!hasScheduledMessageContent(content)) {
        await openScheduledMessagePanel(ctx, locale, scheduled.chat);
        return;
      }
      const repeatRule = parseScheduledRepeatRule(scheduled.repeatRule);
      const sendAt = nextScheduledRun(repeatRule, new Date()) ?? new Date(Date.now() + repeatRule.intervalMinutes * 60_000);
      await prisma.scheduledMessage.update({
        where: { id: scheduled.id },
        data: { status: ScheduledMessageStatus.PENDING, sendAt }
      });
      await enqueueScheduledMessage(scheduled.id, sendAt);
    } else {
      await cancelScheduledMessageJob(scheduled.id);
      await prisma.scheduledMessage.update({
        where: { id: scheduled.id },
        data: { status: ScheduledMessageStatus.DRAFT }
      });
    }
    await openScheduledMessagePanel(ctx, locale, scheduled.chat);
    return;
  }

  if (action === "delete") {
    await cancelScheduledMessageJob(scheduled.id);
    await prisma.scheduledMessage.delete({ where: { id: scheduled.id } });
    await openScheduledMessagePanel(ctx, locale, scheduled.chat);
    return;
  }

  if (action === "toggle") {
    if (value === "on") {
      const content = parseScheduledContent(scheduled.content);
      if (!hasScheduledMessageContent(content)) {
        await editOrReply(
          ctx,
          locale === "zh-CN" ? "请先设置文本内容或媒体图片，再开启定时消息。" : "Set text or media before enabling this scheduled message.",
          scheduledMessageSettingsKeyboard(scheduled.id, scheduled.chatId, content, parseScheduledRepeatRule(scheduled.repeatRule), scheduled.status, scheduled.buttons, locale)
        );
        return;
      }
      const repeatRule = parseScheduledRepeatRule(scheduled.repeatRule);
      const sendAt = nextScheduledRun(repeatRule, new Date()) ?? new Date(Date.now() + repeatRule.intervalMinutes * 60_000);
      await prisma.scheduledMessage.update({
        where: { id: scheduled.id },
        data: { status: ScheduledMessageStatus.PENDING, sendAt }
      });
      await enqueueScheduledMessage(scheduled.id, sendAt);
    } else {
      await cancelScheduledMessageJob(scheduled.id);
      await prisma.scheduledMessage.update({
        where: { id: scheduled.id },
        data: { status: ScheduledMessageStatus.DRAFT }
      });
    }
    await renderScheduledMessageSettings(ctx, locale, scheduled.id);
    return;
  }

  if (action === "delete_previous" || action === "pin") {
    const content = parseScheduledContent(scheduled.content);
    const nextContent = {
      ...content,
      [action === "delete_previous" ? "deletePrevious" : "pin"]: value === "true"
    };
    await prisma.scheduledMessage.update({
      where: { id: scheduled.id },
      data: { content: scheduledContentToJson(nextContent) }
    });
    await renderScheduledMessageSettings(ctx, locale, scheduled.id);
    return;
  }

  if (action === "edit" && value && isScheduledInputField(value)) {
    if (!ctx.from) return;
    clearUserInputState(ctx.from.id);
    scheduledInputDrafts.set(ctx.from.id, { scheduledMessageId: scheduled.id, field: value });
    await editOrReply(ctx, scheduledInputPromptText(value, locale, scheduled), scheduledInputKeyboard(value, scheduled.id, locale));
    return;
  }

  if (action === "clear") {
    await clearScheduledField(scheduled.id, value);
    if (ctx.from) scheduledInputDrafts.delete(ctx.from.id);
    const refreshed = await prisma.scheduledMessage.findUnique({ where: { id: scheduled.id } });
    if (refreshed && value && isScheduledInputField(value)) {
      await editOrReply(ctx, scheduledInputPromptText(value, locale, refreshed), scheduledInputKeyboard(value, scheduled.id, locale));
      return;
    }
    await renderScheduledMessageSettings(ctx, locale, scheduled.id);
    return;
  }

  if (action === "preview") {
    await sendScheduledPreview(ctx, scheduled.id, locale);
    return;
  }

}

async function openScheduledMessagePanel(ctx: Context, locale: Locale, chat: PrismaChat) {
  const messages = await prisma.scheduledMessage.findMany({
    where: { chatId: chat.id },
    orderBy: { createdAt: "asc" },
    take: 10
  });

  await editOrReply(
    ctx,
    scheduledMessageListText(chat, messages, locale),
    scheduledMessageListKeyboard(chat.id, messages, chat.type === "CHANNEL" ? "channel" : "group", locale)
  );
}

function scheduledMessageListText(chat: PrismaChat, messages: ScheduledMessageListItem[], locale: Locale) {
  const title = escapeHtml(chat.title ?? chat.username ?? String(chat.telegramChatId));
  const header = locale === "zh-CN"
    ? [`⏰ <b>定时消息</b>`, "", `设置 <b>${title}</b> 每隔几分钟/小时重复发送的消息`]
    : [`⏰ <b>Scheduled messages</b>`, "", `Configure messages repeated every few minutes or hours for <b>${title}</b>.`];

  if (!messages.length) return header.join("\n");

  const details = messages.map((message, index) => scheduledMessageListItemText(message, index + 1, locale));
  return [...header, "", "", ...details].join("\n");
}

function scheduledMessageListItemText(message: ScheduledMessageListItem, index: number, locale: Locale) {
  const content = parseScheduledContent(message.content);
  const repeatRule = parseScheduledRepeatRule(message.repeatRule);
  const enabled = message.status === ScheduledMessageStatus.PENDING;
  const hasMedia = Boolean(content.mediaFileId || content.photoFileId);
  const hasButtons = scheduledButtonsEnabled(message.buttons);
  const hasText = Boolean(content.text?.trim());
  const name = escapeHtml(content.name || "-");
  const interval = repeatRule.cron ? `Cron ${escapeHtml(repeatRule.cron)}` : formatDurationZh(repeatRule.intervalMinutes);

  if (locale !== "zh-CN") {
    return [
      `<b>Message</b>${index} name:${name}`,
      `  ├Status: <b>${enabled ? "✅On" : "❌Off"}</b>`,
      `  ├ <code>${interval}</code> once`,
      `  ├Media photo: ${hasMedia ? "✅" : "❌"}`,
      `  ├Link button: ${hasButtons ? "✅" : "❌"}`,
      `  └Text content: ${hasText ? "✅" : "❌"}`
    ].join("\n");
  }

  return [
    `<b>消息</b>${index} 名称:${name}`,
    `  ├状态: <b>${enabled ? "✅开启" : "❌关闭"}</b>`,
    `  ├ <code>${interval}</code> 发送一次`,
    `  ├媒体图片: ${hasMedia ? "✅" : "❌"}`,
    `  ├链接按钮: ${hasButtons ? "✅" : "❌"}`,
    `  └文本内容: ${hasText ? "✅" : "❌"}`
  ].join("\n");
}

function scheduledMessageListKeyboard(
  chatId: string,
  messages: ScheduledMessageListItem[],
  scope: "group" | "channel",
  locale: Locale
) {
  const keyboard = new InlineKeyboard();
  messages.forEach((message, index) => {
    const enabled = message.status === ScheduledMessageStatus.PENDING;
    keyboard
      .text(locale === "zh-CN" ? `💬消息${index + 1}` : `💬Message${index + 1}`, `scheduled:open:${message.id}`)
      .text(
        locale === "zh-CN" ? (enabled ? "✅开启" : "❌关闭") : (enabled ? "✅On" : "❌Off"),
        `scheduled:list_toggle:${message.id}:${enabled ? "off" : "on"}`
      )
      .text(locale === "zh-CN" ? "🔧设置" : "🔧Settings", `scheduled:open:${message.id}`)
      .text(locale === "zh-CN" ? "删除🗑" : "Delete🗑", `scheduled:delete:${message.id}`)
      .row();
  });

  return keyboard
    .text(locale === "zh-CN" ? "➕添加" : "➕Add", `scheduled:add:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "🔙返回" : "🔙Back", `menu:chat:${scope}:${chatId}`);
}

async function openScheduledBulkPanel(ctx: Context, locale: Locale, chat: PrismaChat, notice?: string) {
  await editOrReply(ctx, scheduledBulkPanelText(chat, locale, notice), scheduledBulkKeyboard(chat.id, locale));
}

function scheduledBulkPanelText(chat: PrismaChat, locale: Locale, notice?: string) {
  const title = escapeHtml(chat.title ?? chat.username ?? String(chat.telegramChatId));
  const lines = locale === "zh-CN"
    ? [
        "🧰 <b>批量操作</b>",
        "",
        `当前对象: <b>${title}</b>`,
        "",
        "可以批量开启、关闭或删除当前频道/群组下的全部定时消息。"
      ]
    : [
        "🧰 <b>Bulk actions</b>",
        "",
        `Target: <b>${title}</b>`,
        "",
        "Enable, disable, or delete all scheduled messages in this chat."
      ];
  return notice ? [...lines, "", notice].join("\n") : lines.join("\n");
}

function scheduledBulkKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "✅ 批量开启" : "✅ Enable all", `scheduled:bulk_on:${chatId}`)
    .text(locale === "zh-CN" ? "❌ 批量关闭" : "❌ Disable all", `scheduled:bulk_off:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "🗑 批量删除" : "🗑 Delete all", `scheduled:bulk_delete_confirm:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `scheduled:back:${chatId}`);
}

function scheduledBulkDeleteConfirmText(chat: PrismaChat, locale: Locale) {
  const title = escapeHtml(chat.title ?? chat.username ?? String(chat.telegramChatId));
  return locale === "zh-CN"
    ? [
        "⚠️ <b>确认批量删除</b>",
        "",
        `将删除 <b>${title}</b> 下的全部定时消息。`,
        "此操作不能撤销。"
      ].join("\n")
    : [
        "⚠️ <b>Confirm bulk delete</b>",
        "",
        `All scheduled messages in <b>${title}</b> will be deleted.`,
        "This cannot be undone."
      ].join("\n");
}

function scheduledBulkDeleteConfirmKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "确认删除全部" : "Confirm delete all", `scheduled:bulk_delete:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `scheduled:bulk:${chatId}`);
}

function scheduledBulkResultText(result: ScheduledBulkEnableResult, locale: Locale) {
  if (locale !== "zh-CN") {
    return `✅ Enabled ${result.enabled} scheduled messages. Skipped ${result.skipped} empty messages.`;
  }
  return `✅ 已开启 ${result.enabled} 条定时消息，跳过 ${result.skipped} 条空内容消息。`;
}

function scheduledBulkDisabledText(count: number, locale: Locale) {
  return locale === "zh-CN" ? `❌ 已关闭 ${count} 条定时消息。` : `❌ Disabled ${count} scheduled messages.`;
}

function scheduledBulkDeletedText(count: number, locale: Locale) {
  return locale === "zh-CN" ? `🗑 已删除 ${count} 条定时消息。` : `🗑 Deleted ${count} scheduled messages.`;
}

async function bulkEnableScheduledMessages(chatId: string): Promise<ScheduledBulkEnableResult> {
  const messages = await prisma.scheduledMessage.findMany({ where: { chatId } });
  let enabled = 0;
  let skipped = 0;

  for (const message of messages) {
    const content = parseScheduledContent(message.content);
    if (!hasScheduledMessageContent(content)) {
      skipped += 1;
      continue;
    }
    const repeatRule = parseScheduledRepeatRule(message.repeatRule);
    const sendAt = nextScheduledRun(repeatRule, new Date()) ?? new Date(Date.now() + repeatRule.intervalMinutes * 60_000);
    await prisma.scheduledMessage.update({
      where: { id: message.id },
      data: { status: ScheduledMessageStatus.PENDING, sendAt }
    });
    await enqueueScheduledMessage(message.id, sendAt);
    enabled += 1;
  }

  return { enabled, skipped };
}

async function bulkDisableScheduledMessages(chatId: string) {
  const messages = await prisma.scheduledMessage.findMany({
    where: { chatId },
    select: { id: true }
  });
  for (const message of messages) {
    await cancelScheduledMessageJob(message.id);
  }
  const result = await prisma.scheduledMessage.updateMany({
    where: { chatId },
    data: { status: ScheduledMessageStatus.DRAFT }
  });
  return result.count;
}

async function bulkDeleteScheduledMessages(chatId: string) {
  const messages = await prisma.scheduledMessage.findMany({
    where: { chatId },
    select: { id: true }
  });
  for (const message of messages) {
    await cancelScheduledMessageJob(message.id);
  }
  const result = await prisma.scheduledMessage.deleteMany({ where: { chatId } });
  return result.count;
}

async function openScheduledIntervalPanel(ctx: Context, locale: Locale, id: string) {
  const scheduled = await prisma.scheduledMessage.findUnique({ where: { id } });
  if (!scheduled) return;
  const repeatRule = parseScheduledRepeatRule(scheduled.repeatRule);
  await editOrReply(ctx, scheduledIntervalText(locale), scheduledIntervalKeyboard(id, repeatRule, locale));
}

function scheduledIntervalText(locale: Locale) {
  return locale === "zh-CN"
    ? [
        "⏰ <b>定时消息</b>",
        "",
        "勾选数字是间隔多久发送一次，不保证准时发送，如果想准时准点发，请勾选 <b>自定义Cron表达式</b>",
        "",
        "➡️ 选择该消息间隔多久发送一次:"
      ].join("\n")
    : [
        "⏰ <b>Scheduled messages</b>",
        "",
        "The selected number controls the repeat interval. Exact delivery time is not guaranteed. For exact timing, use <b>Custom Cron expression</b>.",
        "",
        "➡️ Choose the repeat interval:"
      ].join("\n");
}

function scheduledIntervalKeyboard(id: string, rule: ScheduledRepeatRule, locale: Locale) {
  const keyboard = new InlineKeyboard()
    .text(locale === "zh-CN" ? "·按小时·" : "·Hours·", `scheduled:noop:${id}`)
    .row();

  for (let hour = 1; hour <= 24; hour += 1) {
    keyboard.text(rule.cron ? String(hour) : rule.intervalMinutes === hour * 60 ? `✅${hour}` : String(hour), `scheduled:set_interval:${id}:${hour * 60}`);
    if (hour % 8 === 0) keyboard.row();
  }

  keyboard.text(locale === "zh-CN" ? "·按分钟·" : "·Minutes·", `scheduled:noop:${id}`).row();
  for (let minute = 10; minute <= 59; minute += 1) {
    keyboard.text(!rule.cron && rule.intervalMinutes === minute ? `✅${minute}` : String(minute), `scheduled:set_interval:${id}:${minute}`);
    if ((minute - 9) % 8 === 0) keyboard.row();
  }

  return keyboard
    .row()
    .text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `scheduled:open:${id}`)
    .text(locale === "zh-CN" ? "自定义Cron表达式" : "Custom Cron expression", `scheduled:cron:${id}`);
}

function scheduledCronPromptText(rule: ScheduledRepeatRule, locale: Locale) {
  const current = rule.cron ? escapeHtml(rule.cron) : "None";
  return locale === "zh-CN"
    ? [
        "🕒 请输入 Cron 表达式，用于设置定时发送时间。",
        "",
        `现有设置: <code>${current}</code>`,
        "",
        "📌 Cron 表达式格式为：",
        "",
        "<code>分钟 小时 日 月 星期</code>",
        "",
        "🧭 示例：",
        "",
        "<code>0 8 * * *</code> → 每天 8 点",
        "<code>0 */2 * * *</code> → 每 2 小时执行一次",
        "<code>*/10 * * * *</code> → 每 10 分钟执行一次",
        "<code>30 21 * * 1-5</code> → 周一至周五 21:30",
        "",
        "🛠 可用范围：",
        "- 分钟：<code>0-59</code>",
        "- 小时：<code>0-23</code>",
        "- 日：<code>1-31</code>",
        "- 月：<code>1-12</code>",
        "- 星期：<code>0-6</code>（0 = 星期日）",
        "",
        "✏️ <b>请直接发送 Cron 表达式，我将为你验证并保存设置</b>"
      ].join("\n")
    : [
        "🕒 Send a Cron expression to set the schedule.",
        "",
        `Current setting: <code>${current}</code>`,
        "",
        "📌 Format:",
        "<code>minute hour day month weekday</code>",
        "",
        "Examples:",
        "<code>0 8 * * *</code> → Every day at 08:00",
        "<code>0 */2 * * *</code> → Every 2 hours",
        "<code>*/10 * * * *</code> → Every 10 minutes",
        "<code>30 21 * * 1-5</code> → Weekdays at 21:30",
        "",
        "✏️ <b>Send the Cron expression directly to validate and save it.</b>"
      ].join("\n");
}

async function renderScheduledMessageSettings(ctx: Context, locale: Locale, scheduledMessageId: string) {
  const scheduled = await prisma.scheduledMessage.findUnique({
    where: { id: scheduledMessageId },
    include: { chat: true }
  });
  if (!scheduled) return;

  const content = parseScheduledContent(scheduled.content);
  const repeatRule = parseScheduledRepeatRule(scheduled.repeatRule);
  await editOrReply(
    ctx,
    scheduledMessageSettingsText(scheduled, content, repeatRule, locale),
    scheduledMessageSettingsKeyboard(scheduled.id, scheduled.chatId, content, repeatRule, scheduled.status, scheduled.buttons, locale)
  );
}

function scheduledMessageSettingsText(
  scheduled: {
    status: ScheduledMessageStatus;
    sendAt: Date;
    buttons: Prisma.JsonValue | null;
  },
  content: ScheduledMessageContent,
  repeatRule: ScheduledRepeatRule,
  locale: Locale
) {
  const enabled = scheduled.status === ScheduledMessageStatus.PENDING;
  const buttonEnabled = scheduledButtonsEnabled(scheduled.buttons);
  const hasText = Boolean(content.text?.trim());
  const hasMedia = Boolean(content.mediaFileId || content.photoFileId);
  const timeWindow = repeatRule.timeStart && repeatRule.timeEnd ? `${repeatRule.timeStart}-${repeatRule.timeEnd}` : "-";
  const nextRun = enabled ? formatDateTimeForDisplay(scheduled.sendAt) : "-";
  const startAt = repeatRule.startAt ? formatDateTimeForDisplay(new Date(repeatRule.startAt)) : "-";
  const endAt = repeatRule.endAt ? formatDateTimeForDisplay(new Date(repeatRule.endAt)) : "-";

  if (locale !== "zh-CN") {
    return [
      "⏰ <b>Scheduled messages</b>",
      "",
      "Use this menu to configure message sending parameters.",
      "",
      `<b>Name</b>: <code>${escapeHtml(content.name || "-")}</code>`,
      `<b>Status</b>: ${enabled ? "✅ On" : "❌ Off"}`,
      `<b>Repeat interval</b>: <code>${repeatRule.cron ? `Cron ${escapeHtml(repeatRule.cron)}` : formatDurationZh(repeatRule.intervalMinutes)}</code>`,
      `<b>Time window</b>: ${timeWindow}`,
      `<b>Next run</b>: ${nextRun}`,
      `<b>Start date</b>: ${startAt}`,
      `<b>End date</b>: ${endAt}`,
      "",
      `<b>Media photo</b>: ${hasMedia ? "✅" : "❌"}`,
      `<b>Link button</b>: ${buttonEnabled ? "✅" : "❌"}`,
      `<b>Text content</b>: ${hasText ? "✅" : "❌"}`
    ].join("\n");
  }

  return [
    "⏰ <b>定时消息</b>",
    "",
    "通过此菜单,你可以配置消息的发送参数",
    "",
    `<b>消息名称</b>: <code>${escapeHtml(content.name || "-")}</code>`,
    `<b>状态</b>: ${enabled ? "✅开启" : "❌关闭"}`,
    `<b>重复间隔</b>: <code>${repeatRule.cron ? `Cron ${escapeHtml(repeatRule.cron)}` : formatDurationZh(repeatRule.intervalMinutes)}</code>`,
    `<b>时段</b>: ${timeWindow}`,
    `<b>下次运行</b>: ${nextRun}`,
    `<b>开始日期</b>: ${startAt}`,
    `<b>结束日期</b>: ${endAt}`,
    "",
    `<b>媒体图片</b>: ${hasMedia ? "✅" : "❌"}`,
    `<b>链接按钮</b>: ${buttonEnabled ? "✅" : "❌"}`,
    `<b>文本内容</b>: ${hasText ? "✅" : "❌"}`
  ].join("\n");
}

function scheduledMessageSettingsKeyboard(
  id: string,
  chatId: string,
  content: ScheduledMessageContent,
  repeatRule: ScheduledRepeatRule,
  status: ScheduledMessageStatus,
  buttons: Prisma.JsonValue | null,
  locale: Locale
) {
  void repeatRule;
  void buttons;
  const enabled = status === ScheduledMessageStatus.PENDING;
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "✍️ 编辑消息名称" : "✍️ Edit name", `scheduled:edit:${id}:name`)
    .row()
    .text("状态:", `scheduled:noop:${id}`)
    .text(enabled ? "✅开启" : "开启", `scheduled:toggle:${id}:on`)
    .text(!enabled ? "✅关闭" : "关闭", `scheduled:toggle:${id}:off`)
    .row()
    .text("删除上一条", `scheduled:noop:${id}`)
    .text(content.deletePrevious ? "✅是" : "是", `scheduled:delete_previous:${id}:true`)
    .text(!content.deletePrevious ? "✅否" : "否", `scheduled:delete_previous:${id}:false`)
    .row()
    .text("📌 置顶:", `scheduled:noop:${id}`)
    .text(content.pin ? "✅是" : "是", `scheduled:pin:${id}:true`)
    .text(!content.pin ? "✅否" : "否", `scheduled:pin:${id}:false`)
    .row()
    .text(locale === "zh-CN" ? "📃 修改文本" : "📃 Edit text", `scheduled:edit:${id}:text`)
    .text(locale === "zh-CN" ? "📷 修改媒体" : "📷 Edit media", `scheduled:edit:${id}:media`)
    .row()
    .text(locale === "zh-CN" ? "🔠 修改按钮" : "🔠 Edit button", `scheduled:edit:${id}:button`)
    .text(locale === "zh-CN" ? "👀 预览消息" : "👀 Preview", `scheduled:preview:${id}`)
    .row()
    .text(locale === "zh-CN" ? "🔁 间隔时间" : "🔁 Interval", `scheduled:interval:${id}`)
    .text(locale === "zh-CN" ? "⏰ 设置时段" : "⏰ Time window", `scheduled:edit:${id}:time_window`)
    .row()
    .text(locale === "zh-CN" ? "📅 开始日期" : "📅 Start date", `scheduled:edit:${id}:start`)
    .text(locale === "zh-CN" ? "📅 结束日期" : "📅 End date", `scheduled:edit:${id}:end`)
    .row()
    .text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `scheduled:list_message:${id}`)
    .text(locale === "zh-CN" ? "批量操作" : "Bulk actions", `scheduled:bulk:${chatId}`);
}

async function handleScheduledInputMessage(ctx: Context, locale: Locale) {
  if (!ctx.from) return false;
  const draft = scheduledInputDrafts.get(ctx.from.id);
  if (!draft) return false;

  const scheduled = await prisma.scheduledMessage.findUnique({ where: { id: draft.scheduledMessageId } });
  if (!scheduled) {
    scheduledInputDrafts.delete(ctx.from.id);
    return false;
  }

  if (draft.field === "media") {
    const media = extractPublishMedia(ctx.message);
    if (!media) {
      await ctx.reply(scheduledInputPromptText("media", locale, scheduled), {
        parse_mode: "HTML",
        reply_markup: scheduledInputKeyboard("media", scheduled.id, locale)
      });
      return true;
    }
    const content = parseScheduledContent(scheduled.content);
    const nextContent = { ...content, mediaKind: media.kind, mediaFileId: media.fileId };
    if (media.kind !== "photo") delete nextContent.photoFileId;
    if (media.kind === "photo") nextContent.photoFileId = media.fileId;
    await prisma.scheduledMessage.update({
      where: { id: scheduled.id },
      data: { content: scheduledContentToJson(nextContent) }
    });
    scheduledInputDrafts.delete(ctx.from.id);
    await ctx.reply(scheduledInputSavedText(locale), { parse_mode: "HTML", reply_markup: scheduledSavedKeyboard(scheduled.id, locale) });
    return true;
  }

  const text = getMessageText(ctx.message);
  if (!text) {
    await ctx.reply(scheduledInputPromptText(draft.field, locale, scheduled), {
      parse_mode: "HTML",
      reply_markup: scheduledInputKeyboard(draft.field, scheduled.id, locale)
    });
    return true;
  }

  const content = parseScheduledContent(scheduled.content);
  const repeatRule = parseScheduledRepeatRule(scheduled.repeatRule);
  const patch = await applyScheduledInput(scheduled.id, draft.field, text, content, repeatRule, locale);
  if (!patch.ok) {
    const retryText = draft.field === "cron"
      ? `${patch.message}\n\n${scheduledCronPromptText(repeatRule, locale)}`
      : patch.message;
    await ctx.reply(retryText, { parse_mode: "HTML", reply_markup: scheduledInputKeyboard(draft.field, scheduled.id, locale) });
    return true;
  }

  scheduledInputDrafts.delete(ctx.from.id);
  await ctx.reply(scheduledInputSavedText(locale), { parse_mode: "HTML", reply_markup: scheduledSavedKeyboard(scheduled.id, locale) });
  return true;
}

async function applyScheduledInput(
  id: string,
  field: ScheduledInputField,
  text: string,
  content: ScheduledMessageContent,
  repeatRule: ScheduledRepeatRule,
  locale: Locale
) {
  if (field === "name") {
    await prisma.scheduledMessage.update({
      where: { id },
      data: { content: scheduledContentToJson({ ...content, name: text.slice(0, 80) }) }
    });
    return { ok: true as const };
  }

  if (field === "text") {
    await prisma.scheduledMessage.update({
      where: { id },
      data: { content: scheduledContentToJson({ ...content, text }) }
    });
    return { ok: true as const };
  }

  if (field === "button") {
    const parsed = parseScheduledButtonLayout(text);
    if (!parsed.length) {
      return {
        ok: false as const,
        message: locale === "zh-CN" ? "格式不正确，请发送：<code>按钮文字-https://example.com</code>" : "Invalid format. Send: <code>Button text-https://example.com</code>"
      };
    }
    await prisma.scheduledMessage.update({
      where: { id },
      data: { buttons: parsed }
    });
    return { ok: true as const };
  }

  if (field === "interval") {
    const intervalMinutes = parseScheduleDurationMinutes(text);
    if (!intervalMinutes) {
      return {
        ok: false as const,
        message: locale === "zh-CN" ? "间隔格式不正确，请发送 10分钟、2小时、1d 或 30m。" : "Invalid interval. Send 10m, 2h, 1d, or 30 minutes."
      };
    }
    const nextRule = { ...repeatRule, intervalMinutes };
    delete nextRule.cron;
    await saveScheduledRepeatRule(id, nextRule);
    return { ok: true as const };
  }

  if (field === "cron") {
    if (!isValidCronExpression(text)) {
      return {
        ok: false as const,
        message: locale === "zh-CN"
          ? "Cron 表达式格式不正确，请发送 5 段格式，例如：<code>*/10 * * * *</code>"
          : "Invalid Cron expression. Use five fields, for example: <code>*/10 * * * *</code>"
      };
    }
    await saveScheduledRepeatRule(id, { ...repeatRule, cron: text.trim() });
    return { ok: true as const };
  }

  if (field === "time_window") {
    const window = parseScheduleTimeWindow(text);
    if (!window) {
      return {
        ok: false as const,
        message: locale === "zh-CN" ? "时段格式不正确，请发送：<code>09:00-18:00</code>" : "Invalid time window. Send: <code>09:00-18:00</code>"
      };
    }
    await saveScheduledRepeatRule(id, { ...repeatRule, timeStart: window.timeStart, timeEnd: window.timeEnd });
    return { ok: true as const };
  }

  if (field === "start" || field === "end") {
    const date = parseScheduleDateTime(text);
    if (!date) {
      return {
        ok: false as const,
        message: locale === "zh-CN"
          ? "日期格式不正确，请发送：<code>2026-08-02 08:59:41</code>"
          : "Invalid date. Send: <code>2026-08-02 08:59:41</code>"
      };
    }
    await saveScheduledRepeatRule(id, {
      ...repeatRule,
      [field === "start" ? "startAt" : "endAt"]: date.toISOString()
    });
    return { ok: true as const };
  }

  return { ok: false as const, message: "Unsupported field." };
}

function isScheduledInputField(value: string): value is ScheduledInputField {
  return value === "name"
    || value === "text"
    || value === "media"
    || value === "button"
    || value === "interval"
    || value === "cron"
    || value === "time_window"
    || value === "start"
    || value === "end";
}

function scheduledInputPrompt(field: ScheduledInputField, locale: Locale) {
  if (locale !== "zh-CN") {
    const prompts: Record<ScheduledInputField, string> = {
      name: "Send the scheduled message name.",
      text: [
        "Now send the text to set your message content.",
        "",
        "HTML (/html) and Telegram text formatting are supported."
      ].join("\n"),
      media: "Reply with a photo, video, sticker, or animation to set the media.",
      button: scheduledButtonPromptText("en"),
      interval: "Send the repeat interval, for example: <code>10m</code>, <code>2h</code>, or <code>1d</code>.",
      cron: "Send a five-field Cron expression, for example: <code>*/10 * * * *</code>.",
      time_window: "Send the active time window, for example: <code>09:00-18:00</code>.",
      start: "Send the start date, for example: <code>2026-08-01 10:00</code>.",
      end: "Send the end date, for example: <code>2026-08-31 23:59</code>."
    };
    return prompts[field];
  }

  const prompts: Record<ScheduledInputField, string> = {
    name: "请发送定时消息名称。",
    text: [
      "现在输入文本设置你的消息内容",
      "",
      '支持 HTML ( <a href="tg://bot_command?command=html">/html</a> ) 和文字字体格式(加粗、链接、剧透、引用等字体):'
    ].join("\n"),
    media: "请回复图片、视频、贴图、动画表情进行设置",
    button: scheduledButtonPromptText("zh-CN"),
    interval: "请发送重复间隔，例如：<code>10分钟</code>、<code>2小时</code>、<code>30m</code>、<code>1d</code>。",
    cron: "请发送 5 段 Cron 表达式，例如：<code>*/10 * * * *</code>。",
    time_window: "请发送发送时段，例如：<code>09:00-18:00</code>。",
    start: "请发送开始日期，例如：<code>2026-08-01 10:00</code>。",
    end: "请发送结束日期，例如：<code>2026-08-31 23:59</code>。"
  };
  return prompts[field];
}

function scheduledInputPromptText(
  field: ScheduledInputField,
  locale: Locale,
  scheduled?: { repeatRule: Prisma.JsonValue | null }
) {
  const repeatRule = scheduled ? parseScheduledRepeatRule(scheduled.repeatRule) : null;
  const currentStart = repeatRule?.startAt ? formatDateTimeForDisplay(new Date(repeatRule.startAt)) : "None";
  const currentEnd = repeatRule?.endAt ? formatDateTimeForDisplay(new Date(repeatRule.endAt)) : "None";

  if (locale !== "zh-CN") {
    const prompts: Record<ScheduledInputField, string> = {
      name: "Send the scheduled message name.",
      text: [
        "Now send the text to set your message content.",
        "",
        "HTML (/html) and Telegram text formatting are supported."
      ].join("\n"),
      media: "Reply with a photo, video, sticker, or animation to set the media.",
      button: scheduledButtonPromptText("en"),
      interval: "Send the repeat interval, for example: <code>10m</code>, <code>2h</code>, or <code>1d</code>.",
      cron: "Send a five-field Cron expression, for example: <code>*/10 * * * *</code>.",
      time_window: [
        "⏰ Scheduled messages",
        "",
        "Set a time window so messages are only sent inside that range.",
        "Template 1: <code>8:00-18:00</code>",
        "Template 2: <code>8-18</code>"
      ].join("\n"),
      start: [
        "⏰ Scheduled messages",
        "",
        "When enabled, messages will only be sent after the start time you set.",
        "",
        "Format: year-month-day hour:minute:second",
        "",
        "Example: <code>2026-08-01 08:59:41</code>",
        "",
        `Current start time: ${escapeHtml(currentStart)}`
      ].join("\n"),
      end: [
        "⏰ Scheduled messages",
        "",
        "When enabled, messages will stop sending after the end time you set.",
        "",
        "Format: year-month-day hour:minute:second",
        "",
        "Example: <code>2026-08-01 09:58:09</code>",
        "",
        `Current end time: ${escapeHtml(currentEnd)}`
      ].join("\n")
    };
    return prompts[field];
  }

  const prompts: Record<ScheduledInputField, string> = {
    name: "请发送定时消息名称。",
    text: [
      "现在输入文本设置你的消息内容",
      "",
      '支持 HTML ( <a href="tg://bot_command?command=html">/html</a> ) 和文字字体格式(加粗、链接、剧透、引用等字体):'
    ].join("\n"),
    media: "请回复图片、视频、贴图、动画表情进行设置",
    button: scheduledButtonPromptText("zh-CN"),
    interval: "请发送重复间隔，例如：<code>10分钟</code>、<code>2小时</code>、<code>30m</code>、<code>1d</code>。",
    cron: "请发送 5 段 Cron 表达式，例如：<code>*/10 * * * *</code>。",
    time_window: [
      "⏰ 定时消息",
      "",
      "设置一个时段，仅在这个时段内发送,点击复制模板⬇️",
      "模板1: <code>8:00-18:00</code>",
      "模板2: <code>8-18</code>"
    ].join("\n"),
    start: [
      "⏰ 定时消息",
      "",
      "在开启状态下，到达设定时间才会发送消息，请回复开始时间：",
      "",
      "格式:年-月-日 时:分:秒",
      "",
      "例如:<code>2026-08-01 08:59:41</code>",
      "",
      `当前设置的开始时间: ${escapeHtml(currentStart)}`
    ].join("\n"),
    end: [
      "⏰ 定时消息",
      "",
      "在开启状态下，到达设定时间终止发送消息，请回复终止时间：",
      "",
      "格式:年-月-日 时:分:秒",
      "",
      "例如:<code>2026-08-01 09:58:09</code>",
      "",
      `当前设置的终止时间: ${escapeHtml(currentEnd)}`
    ].join("\n")
  };
  return prompts[field];
}

function scheduledButtonPromptText(locale: Locale) {
  if (locale !== "zh-CN") {
    return [
      "<b>Set buttons</b>",
      "",
      "<b>Tips</b>:",
      "<blockquote>1. Text is on the left of the dash, URL is on the right\n2. && splits multiple buttons in one row\n3. New lines create new rows</blockquote>",
      "",
      "<b>Examples</b>:",
      "",
      "<b>One button per row:</b>",
      "<pre>Link name-https://t.me/xxx</pre>",
      "<b>Two buttons in one row:</b>",
      "<pre>Link 1-https://t.me/xxx && Link 2-https://t.me/xxx</pre>",
      "<b>Two rows:</b>",
      "<pre>#p Row 1 link 1-https://t.me/xxx && #r Row 1 link 2-https://t.me/xxx\n#g Row 2 link 1-https://t.me/xxx && Row 2 link 2-https://t.me/xxx</pre>",
      "",
      "⚠️ #p/#r/#g color prefixes are accepted and ignored by Telegram inline buttons."
    ].join("\n");
  }

  return [
    "<b>设置按钮</b>",
    "",
    "<b>提示</b>：",
    "<blockquote>1. - 减号左边是按钮名称，右边是链接\n2. && 用来分割一行的多个按钮\n3. 换行可以让按钮另起一行</blockquote>",
    "",
    "<b>示例</b>：",
    "",
    "<b>一、消息按钮：</b>",
    "• 插入<b>一行一个按钮</b>：",
    "<pre>链接名称-https://t.me/xxx</pre>",
    "• 在<b>一行两个按钮</b>：",
    "<pre>链接名称1-https://t.me/xxx && 链接名称2-https://t.me/xxx</pre>",
    "• 插入<b>两行四个按钮</b>：",
    "<pre>#p第1行链接名称1-https://t.me/xxx && #r第1行链接名称2-https://t.me/xxx\n#g第2行链接名称1-https://t.me/xxx && 第2行链接名称2-https://t.me/xxx</pre>",
    "",
    "⚠️ #p-蓝色背景 #r-红色背景 #g-绿色背景，Telegram 消息按钮会忽略颜色前缀。"
  ].join("\n");
}

function scheduledInputKeyboard(field: ScheduledInputField, id: string, locale: Locale) {
  if (field === "button") {
    return new InlineKeyboard()
      .text("Copy1", `scheduled:example:${id}:1`)
      .text("Copy2", `scheduled:example:${id}:2`)
      .row()
      .text(locale === "zh-CN" ? "🚫 清空消息按钮" : "🚫 Clear buttons", `scheduled:clear:${id}:button`)
      .text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `scheduled:open:${id}`);
  }

  if (field === "time_window") {
    return new InlineKeyboard()
      .text(locale === "zh-CN" ? "🚫 清空已设置的时段" : "🚫 Clear time window", `scheduled:clear:${id}:time_window`)
      .text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `scheduled:open:${id}`);
  }

  if (field === "start") {
    return new InlineKeyboard()
      .text(locale === "zh-CN" ? "🚫 移除已设置的开始时间" : "🚫 Remove start time", `scheduled:clear:${id}:start`)
      .row()
      .text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `scheduled:open:${id}`);
  }

  if (field === "end") {
    return new InlineKeyboard()
      .text(locale === "zh-CN" ? "🚫 移除已设置的终止时间" : "🚫 Remove end time", `scheduled:clear:${id}:end`)
      .row()
      .text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `scheduled:open:${id}`);
  }

  return scheduledInputCancelKeyboard(id, locale);
}

function scheduledInputCancelKeyboard(id: string, locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `scheduled:open:${id}`);
}

function scheduledSavedKeyboard(id: string, locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "返回设置" : "Back to settings", `scheduled:open:${id}`);
}

function scheduledInputSavedText(locale: Locale) {
  return locale === "zh-CN" ? "✅ 设置成功，点击按钮返回。" : "✅ Saved. Tap the button to return.";
}

async function clearScheduledField(id: string, field: string | undefined) {
  const scheduled = await prisma.scheduledMessage.findUnique({ where: { id } });
  if (!scheduled) return;
  const content = parseScheduledContent(scheduled.content);
  const repeatRule = parseScheduledRepeatRule(scheduled.repeatRule);

  if (field === "media") {
    const nextContent = { ...content };
    delete nextContent.photoFileId;
    delete nextContent.mediaKind;
    delete nextContent.mediaFileId;
    delete nextContent.lastMessageId;
    delete nextContent.lastMessageIds;
    await prisma.scheduledMessage.update({
      where: { id },
      data: { content: scheduledContentToJson(nextContent) }
    });
    return;
  }

  if (field === "button") {
    await prisma.scheduledMessage.update({ where: { id }, data: { buttons: [] } });
    return;
  }

  if (field === "time_window") {
    const nextRule = { ...repeatRule };
    delete nextRule.timeStart;
    delete nextRule.timeEnd;
    await saveScheduledRepeatRule(id, nextRule);
    return;
  }

  if (field === "start") {
    const nextRule = { ...repeatRule };
    delete nextRule.startAt;
    await saveScheduledRepeatRule(id, nextRule);
    return;
  }

  if (field === "end") {
    const nextRule = { ...repeatRule };
    delete nextRule.endAt;
    await saveScheduledRepeatRule(id, nextRule);
  }
}

async function sendScheduledPreview(ctx: Context, id: string, locale: Locale) {
  const scheduled = await prisma.scheduledMessage.findUnique({ where: { id } });
  if (!scheduled) return;
  const content = parseScheduledContent(scheduled.content);
  if (!hasScheduledMessageContent(content)) {
    await editOrReply(
      ctx,
      locale === "zh-CN" ? "请先设置文本内容或媒体图片，再预览。" : "Set text or media before previewing.",
      scheduledMessageSettingsKeyboard(scheduled.id, scheduled.chatId, content, parseScheduledRepeatRule(scheduled.repeatRule), scheduled.status, scheduled.buttons, locale)
    );
    return;
  }

  const replyMarkup = scheduledInlineKeyboard(scheduled.buttons);
  const mediaKind = content.mediaKind ?? (content.photoFileId ? "photo" : undefined);
  const mediaFileId = content.mediaFileId ?? content.photoFileId;

  if (mediaKind === "photo" && mediaFileId) {
    await ctx.replyWithPhoto(mediaFileId, {
      ...(content.text ? { caption: content.text } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });
    return;
  }

  if (mediaKind === "video" && mediaFileId) {
    await ctx.replyWithVideo(mediaFileId, {
      ...(content.text ? { caption: content.text } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });
    return;
  }

  if (mediaKind === "animation" && mediaFileId) {
    await ctx.replyWithAnimation(mediaFileId, {
      ...(content.text ? { caption: content.text } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });
    return;
  }

  if (mediaKind === "sticker" && mediaFileId) {
    await ctx.replyWithSticker(mediaFileId, {
      ...(!content.text && replyMarkup ? { reply_markup: replyMarkup } : {})
    });
    if (content.text) {
      await ctx.reply(content.text, {
        ...(replyMarkup ? { reply_markup: replyMarkup } : {})
      });
    }
    return;
  }

  await ctx.reply(content.text ?? "", {
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

function scheduledInlineKeyboard(value: Prisma.JsonValue | null) {
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

function scheduledButtonsEnabled(value: Prisma.JsonValue | null) {
  return Boolean(scheduledInlineKeyboard(value));
}

async function saveScheduledRepeatRule(id: string, rule: ScheduledRepeatRule) {
  const normalized = {
    ...rule,
    intervalMinutes: clampIntervalMinutes(rule.intervalMinutes)
  };
  const nextRun = nextScheduledRun(normalized, new Date());
  const scheduled = await prisma.scheduledMessage.update({
    where: { id },
    data: {
      repeatRule: scheduledRepeatRuleToJson(normalized),
      ...(nextRun ? { sendAt: nextRun } : {})
    }
  });

  if (scheduled.status === ScheduledMessageStatus.PENDING && nextRun) {
    await enqueueScheduledMessage(id, nextRun);
  }
}

function parseScheduleDurationMinutes(input: string) {
  const text = input.trim().toLowerCase().replace(/\s+/g, "");
  const match = text.match(/^(\d+)(分钟|分|m|min|minute|minutes|小时|时|h|hour|hours|天|日|d|day|days)$/);
  if (!match?.[1] || !match[2]) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const unit = match[2];
  const multiplier = unit === "天" || unit === "日" || unit === "d" || unit === "day" || unit === "days"
    ? 24 * 60
    : unit === "小时" || unit === "时" || unit === "h" || unit === "hour" || unit === "hours"
      ? 60
      : 1;
  return clampIntervalMinutes(amount * multiplier);
}

function parseScheduleTimeWindow(input: string) {
  const match = input.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(?:-|~|至|到)\s*(\d{1,2})(?::(\d{2}))?$/);
  if (!match?.[1] || !match[3]) return null;
  const timeStart = normalizeClockTime(`${match[1]}:${match[2] ?? "00"}`);
  const timeEnd = normalizeClockTime(`${match[3]}:${match[4] ?? "00"}`);
  return timeStart && timeEnd ? { timeStart, timeEnd } : null;
}

function normalizeClockTime(input: string) {
  const match = input.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match?.[1] || !match[2]) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function parseScheduleDateTime(input: string) {
  const normalized = input
    .trim()
    .replace(/[ＴT]/g, " ")
    .replace(/：/g, ":")
    .replace(/[／/]/g, "-")
    .replace(/\s+/g, " ");
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = match[4] ? Number(match[4]) : 0;
  const minutes = match[5] ? Number(match[5]) : 0;
  const seconds = match[6] ? Number(match[6]) : 0;
  if (
    month < 1
    || month > 12
    || day < 1
    || day > 31
    || hours < 0
    || hours > 23
    || minutes < 0
    || minutes > 59
    || seconds < 0
    || seconds > 59
  ) {
    return null;
  }
  const date = new Date(year, month - 1, day, hours, minutes, seconds);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hours
    || date.getMinutes() !== minutes
    || date.getSeconds() !== seconds
  ) {
    return null;
  }
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateTimeForDisplay(date: Date) {
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDurationZh(minutes: number) {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

function createPublishDraft(): PublishDraft {
  return {
    name: "",
    text: "",
    buttonText: "",
    buttonUrl: "",
    mediaKind: undefined,
    mediaFileId: undefined,
    waitingFor: undefined
  };
}

function getPublishDraft(userId: number) {
  const draft = publishDrafts.get(userId);
  if (draft) return draft;
  const nextDraft = createPublishDraft();
  publishDrafts.set(userId, nextDraft);
  return nextDraft;
}

async function renderPublishHome(ctx: Context, locale: Locale) {
  await editOrReply(ctx, publishHomeText(locale), publishHomeKeyboard(locale));
}

async function renderPublishSummary(ctx: Context, locale: Locale, botUsername: string) {
  if (!ctx.from) return;
  const draft = getPublishDraft(ctx.from.id);
  await editOrReply(ctx, publishSummaryText(locale, draft, botUsername, ctx.from.id), publishSummaryKeyboard(locale, ctx.from.id));
}

async function renderPublishSettings(ctx: Context, locale: Locale) {
  if (!ctx.from) return;
  const draft = getPublishDraft(ctx.from.id);
  await editOrReply(ctx, publishSettingsText(locale, draft), publishSettingsKeyboard(locale, ctx.from.id));
}

async function handlePublishInputMessage(ctx: Context, locale: Locale) {
  if (!ctx.from) return false;
  const draft = publishDrafts.get(ctx.from.id);
  if (!draft?.waitingFor) return false;

  if (draft.waitingFor === "name") {
    const text = getMessageText(ctx.message);
    if (!text) {
      await ctx.reply(locale === "zh-CN" ? "请发送文本作为消息名称。" : "Send text as the message name.", {
        parse_mode: "HTML",
        reply_markup: publishCancelKeyboard(locale)
      });
      return true;
    }
    draft.name = text.slice(0, 80);
    draft.waitingFor = undefined;
    await ctx.reply(publishSuccessText(locale), {
      parse_mode: "HTML",
      reply_markup: publishSuccessKeyboard(locale)
    });
    return true;
  }

  if (draft.waitingFor === "text") {
    const text = getMessageText(ctx.message);
    if (!text) {
      await ctx.reply(locale === "zh-CN" ? "请发送文本内容。" : "Send text content.", {
        parse_mode: "HTML",
        reply_markup: publishTextInputKeyboard(locale)
      });
      return true;
    }
    draft.text = text;
    draft.waitingFor = undefined;
    await ctx.reply(publishSuccessText(locale), {
      parse_mode: "HTML",
      reply_markup: publishSuccessKeyboard(locale)
    });
    return true;
  }

  if (draft.waitingFor === "button") {
    const text = getMessageText(ctx.message);
    const parsed = text ? parsePublishButton(text) : null;
    if (!parsed) {
      await ctx.reply(
        locale === "zh-CN"
          ? "格式不正确，请按这个格式发送：\n\n<code>按钮文字 | https://example.com</code>"
          : "Invalid format. Send:\n\n<code>Button text | https://example.com</code>",
        { parse_mode: "HTML", reply_markup: publishButtonInputKeyboard(locale) }
      );
      return true;
    }
    draft.buttonText = parsed.text;
    draft.buttonUrl = parsed.url;
    draft.waitingFor = undefined;
    await ctx.reply(publishSuccessText(locale), {
      parse_mode: "HTML",
      reply_markup: publishSuccessKeyboard(locale)
    });
    return true;
  }

  if (draft.waitingFor === "media") {
    const media = extractPublishMedia(ctx.message);
    if (!media) {
      await ctx.reply(publishMediaPromptText(locale), {
        parse_mode: "HTML",
        reply_markup: publishMediaInputKeyboard(locale)
      });
      return true;
    }
    draft.mediaKind = media.kind;
    draft.mediaFileId = media.fileId;
    draft.waitingFor = undefined;
    await ctx.reply(publishSuccessText(locale), {
      parse_mode: "HTML",
      reply_markup: publishSuccessKeyboard(locale)
    });
    return true;
  }

  return false;
}

async function handleAutoReplyInputMessage(ctx: Context, locale: Locale) {
  if (!ctx.from) return false;
  const draft = autoReplyInputDrafts.get(ctx.from.id);
  if (!draft) return false;
  if (draft.stage === "keyword") {
    const text = getMessageText(ctx.message);
    const parsed = text ? parseAutoReplyKeyword(text) : null;
    if (!parsed) {
      const settings = await getAutoReplySettings(draft.chatId);
      await ctx.reply(autoReplyKeywordPromptText(settings, locale), {
        parse_mode: "HTML",
        reply_markup: autoReplyCancelKeyboard(draft.chatId, locale)
      });
      return true;
    }

    draft.keyword = parsed.keyword;
    draft.matchType = parsed.matchType;
    draft.stage = "response";
    await ctx.reply(autoReplyResponsePromptText(parsed.keyword, locale), {
      parse_mode: "HTML",
      reply_markup: autoReplyCancelKeyboard(draft.chatId, locale)
    });
    return true;
  }

  if (draft.stage === "response") {
    const content = extractAutoReplyContent(ctx.message);
    if (!content) {
      await ctx.reply(autoReplyResponsePromptText(draft.keyword ?? "", locale), {
        parse_mode: "HTML",
        reply_markup: autoReplyCancelKeyboard(draft.chatId, locale)
      });
      return true;
    }

    draft.response = content.text;
    if (content.mediaKind && content.mediaFileId) {
      draft.mediaKind = content.mediaKind;
      draft.mediaFileId = content.mediaFileId;
    } else {
      delete draft.mediaKind;
      delete draft.mediaFileId;
    }
    draft.stage = "buttons";
    await ctx.reply(autoReplyButtonsPromptText(locale), {
      parse_mode: "HTML",
      reply_markup: autoReplyButtonsKeyboard(draft.chatId, locale)
    });
    return true;
  }

  const text = getMessageText(ctx.message);
  const buttons = text ? parseAutoReplyButtonLayout(text) : null;
  if (!buttons) {
    await ctx.reply(
      locale === "zh-CN"
        ? "按钮格式不正确，请按示例输入，或点击“不设置，跳过”。"
        : "Invalid button format. Use the example or tap Skip buttons.",
      { parse_mode: "HTML", reply_markup: autoReplyButtonsKeyboard(draft.chatId, locale) }
    );
    return true;
  }

  await finalizeAutoReplyRule(ctx, locale, draft, buttons);
  return true;
}

async function finalizeAutoReplyRule(
  ctx: Context,
  locale: Locale,
  draft: AutoReplyInputDraft,
  buttons?: AutoReplyButton[][]
) {
  if (!ctx.from || !draft.keyword || !draft.matchType || (!draft.response && !draft.mediaFileId)) return;

  const settings = await getAutoReplySettings(draft.chatId);
  const rule: AutoReplyRule = {
    id: createAutoReplyRuleId(),
    keyword: draft.keyword,
    matchType: draft.matchType,
    response: draft.response ?? ""
  };

  if (draft.mediaKind && draft.mediaFileId) {
    rule.mediaKind = draft.mediaKind;
    rule.mediaFileId = draft.mediaFileId;
  }
  if (buttons?.length) rule.buttons = buttons;

  settings.rules.push(rule);
  autoReplyInputDrafts.delete(ctx.from.id);
  await saveAutoReplySettings(draft.chatId, settings);
  await ctx.reply(locale === "zh-CN" ? "✅ 设置成功，点击按钮返回。" : "✅ Saved. Tap the button to return.", {
    parse_mode: "HTML",
    reply_markup: autoReplyCancelKeyboard(draft.chatId, locale)
  });
}

function parseAutoReplyKeyword(input: string) {
  const value = input.trim();
  if (!value) return null;

  const prefix = value[0];
  const matchType = prefix === "*" ? "contains" : "exact";
  const keyword = prefix === "-" || prefix === "*" ? value.slice(1).trim() : value;
  if (!keyword) return null;

  return {
    keyword: keyword.slice(0, 80),
    matchType
  } as const;
}

function extractAutoReplyContent(message: Message | undefined) {
  if (!message) return null;
  const text = getMessageText(message) ?? "";
  const media = extractAutoReplyMedia(message);
  if (!text && !media) return null;
  return {
    text: text.slice(0, 4000),
    mediaKind: media?.kind,
    mediaFileId: media?.fileId
  };
}

function extractAutoReplyMedia(message: Message | undefined): { kind: AutoReplyMediaKind; fileId: string } | null {
  if (!message) return null;
  if ("photo" in message && message.photo?.length) {
    const photo = message.photo[message.photo.length - 1];
    return photo ? { kind: "photo", fileId: photo.file_id } : null;
  }
  if ("video" in message && message.video) return { kind: "video", fileId: message.video.file_id };
  if ("animation" in message && message.animation) return { kind: "animation", fileId: message.animation.file_id };
  if ("sticker" in message && message.sticker) return { kind: "sticker", fileId: message.sticker.file_id };
  if ("document" in message && message.document) return { kind: "document", fileId: message.document.file_id };
  if ("audio" in message && message.audio) return { kind: "audio", fileId: message.audio.file_id };
  if ("voice" in message && message.voice) return { kind: "voice", fileId: message.voice.file_id };
  return null;
}

function parseAutoReplyButtonLayout(input: string): AutoReplyButton[][] | null {
  const rows = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("&&").map((item) => parseAutoReplyButton(item.trim())).filter((item): item is AutoReplyButton => Boolean(item)))
    .filter((row) => row.length > 0);

  if (!rows.length) return null;
  const sourceItems = input.split(/\r?\n/).flatMap((line) => line.split("&&").map((item) => item.trim()).filter(Boolean));
  const parsedItems = rows.flat();
  return parsedItems.length === sourceItems.length ? rows : null;
}

function parseAutoReplyButton(input: string): AutoReplyButton | null {
  const separatorIndex = input.indexOf(" - ");
  const compactIndex = separatorIndex >= 0 ? separatorIndex : input.indexOf("-");
  if (compactIndex <= 0) return null;

  const text = input.slice(0, compactIndex).trim();
  const rawUrl = input.slice(compactIndex + (separatorIndex >= 0 ? 3 : 1)).trim();
  if (!text || !rawUrl) return null;

  try {
    const url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { text: text.slice(0, 64), url: url.toString() };
  } catch {
    return null;
  }
}

function createAutoReplyRuleId() {
  return `ar${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function getMessageText(message: Message | undefined) {
  if (!message) return null;
  if ("text" in message && message.text) return message.text.trim();
  if ("caption" in message && message.caption) return message.caption.trim();
  return null;
}

function extractPublishMedia(message: Message | undefined): { kind: PublishMediaKind; fileId: string } | null {
  if (!message) return null;
  if ("photo" in message && message.photo?.length) {
    const photo = message.photo[message.photo.length - 1];
    return photo ? { kind: "photo", fileId: photo.file_id } : null;
  }
  if ("video" in message && message.video) return { kind: "video", fileId: message.video.file_id };
  if ("animation" in message && message.animation) return { kind: "animation", fileId: message.animation.file_id };
  if ("sticker" in message && message.sticker) return { kind: "sticker", fileId: message.sticker.file_id };
  return null;
}

function parsePublishButton(input: string) {
  const [rawText, rawUrl] = input.split("|").map((item) => item.trim());
  if (!rawText || !rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { text: rawText.slice(0, 64), url: url.toString() };
  } catch {
    return null;
  }
}

function parseScheduledButtonLayout(input: string) {
  const rows = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line
        .split("&&")
        .map((item) => parseScheduledButton(item.trim()))
        .filter((item): item is { text: string; url: string } => Boolean(item))
    )
    .filter((row) => row.length > 0);

  return rows;
}

function parseScheduledButton(input: string) {
  const cleaned = input.replace(/^#[prg]\s*/i, "").trim();
  const separatorIndex = cleaned.indexOf(" - ");
  const compactIndex = separatorIndex >= 0 ? separatorIndex : cleaned.indexOf("-");
  if (compactIndex <= 0) return null;

  const text = cleaned.slice(0, compactIndex).trim();
  const rawUrl = cleaned.slice(compactIndex + (separatorIndex >= 0 ? 3 : 1)).trim();
  if (!text || !rawUrl) return null;

  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { text: text.slice(0, 64), url: url.toString() };
  } catch {
    return null;
  }
}

function publishDraftKeyboard(draft: PublishDraft) {
  if (!draft.buttonText || !draft.buttonUrl) return undefined;
  return new InlineKeyboard().url(draft.buttonText, draft.buttonUrl);
}

function publishInlineQuery(userId: number) {
  return `inlineTQ4MD${Math.abs(userId).toString().slice(-6).padStart(6, "0")}`;
}

async function sendPublishPreview(ctx: Context, draft: PublishDraft, locale: Locale) {
  if (!draft.text.trim() && !draft.mediaFileId) {
    await ctx.reply(locale === "zh-CN" ? "请先设置文本或媒体后再预览。" : "Set text or media before previewing.", {
      reply_markup: ctx.from ? publishSettingsKeyboard(locale, ctx.from.id) : publishCancelKeyboard(locale)
    });
    return;
  }

  const replyMarkup = publishDraftKeyboard(draft);
  const caption = draft.text.trim() || undefined;

  if (draft.mediaFileId && draft.mediaKind === "photo") {
    await ctx.replyWithPhoto(draft.mediaFileId, {
      ...(caption ? { caption } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });
    return;
  }
  if (draft.mediaFileId && draft.mediaKind === "video") {
    await ctx.replyWithVideo(draft.mediaFileId, {
      ...(caption ? { caption } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });
    return;
  }
  if (draft.mediaFileId && draft.mediaKind === "animation") {
    await ctx.replyWithAnimation(draft.mediaFileId, {
      ...(caption ? { caption } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });
    return;
  }
  if (draft.mediaFileId && draft.mediaKind === "sticker") {
    await ctx.replyWithSticker(draft.mediaFileId, {
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });
    if (caption) await ctx.reply(caption);
    return;
  }

  await ctx.reply(draft.text, {
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

async function handlePublishInlineQuery(ctx: Context) {
  const query = ctx.inlineQuery;
  if (!query) return;
  const draft = getPublishDraft(query.from.id);
  const replyMarkup = publishDraftInlineMarkup(draft);
  const title = draft.name || "快捷发布";
  const description = draft.text || "点击发送快捷发布消息";
  const text = draft.text || title;
  const result = buildPublishInlineResult(draft, title, description, text, replyMarkup);
  await ctx.answerInlineQuery([result], {
    cache_time: 0,
    is_personal: true
  });
}

function buildPublishInlineResult(
  draft: PublishDraft,
  title: string,
  description: string,
  text: string,
  replyMarkup: InlineKeyboardMarkup | undefined
): InlineQueryResult {
  const baseId = `publish-${Date.now()}`;
  if (draft.mediaFileId && draft.mediaKind === "photo") {
    return {
      type: "photo",
      id: baseId,
      photo_file_id: draft.mediaFileId,
      title,
      description,
      ...(draft.text ? { caption: draft.text } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    };
  }
  if (draft.mediaFileId && draft.mediaKind === "video") {
    return {
      type: "video",
      id: baseId,
      video_file_id: draft.mediaFileId,
      title,
      description,
      ...(draft.text ? { caption: draft.text } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    };
  }
  if (draft.mediaFileId && draft.mediaKind === "animation") {
    return {
      type: "gif",
      id: baseId,
      gif_file_id: draft.mediaFileId,
      title,
      ...(draft.text ? { caption: draft.text } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    };
  }
  if (draft.mediaFileId && draft.mediaKind === "sticker") {
    return {
      type: "sticker",
      id: baseId,
      sticker_file_id: draft.mediaFileId,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    };
  }
  return {
    type: "article",
    id: baseId,
    title,
    description,
    input_message_content: {
      message_text: text
    },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  };
}

function publishDraftInlineMarkup(draft: PublishDraft): InlineKeyboardMarkup | undefined {
  if (!draft.buttonText || !draft.buttonUrl) return undefined;
  return {
    inline_keyboard: [[{ text: draft.buttonText, url: draft.buttonUrl }]]
  };
}

async function handleTimezoneInputMessage(ctx: Context, config: AppConfig, locale: Locale) {
  if (!ctx.from || !timezoneInputUsers.has(ctx.from.id)) return false;

  const timezone = await timezoneFromMessage(ctx);
  if (!timezone) {
    await ctx.reply(
      locale === "zh-CN"
        ? "没有识别到时区。请发送城市名、IANA 时区，例如 Asia/Shanghai，或者发送位置。"
        : "No timezone recognized. Send a city name, an IANA timezone such as Asia/Shanghai, or share a location.",
      { parse_mode: "HTML", reply_markup: timezonePromptKeyboard(locale) }
    );
    return true;
  }

  await updateUserTimezone(ctx.from.id, timezone);
  timezoneInputUsers.delete(ctx.from.id);
  await ctx.reply(timezoneSavedText(locale), {
    parse_mode: "HTML",
    reply_markup: timezoneSavedKeyboard(locale)
  });
  return true;
}

async function getUserTimezone(ctx: Context, fallback: string) {
  if (!ctx.from) return fallback;
  const user = await prisma.user.findUnique({
    where: { telegramUserId: BigInt(ctx.from.id) },
    select: { timezone: true }
  });
  return user?.timezone ?? fallback;
}

async function timezoneFromMessage(ctx: Context) {
  const message = ctx.message;
  if (!message) return null;

  if ("location" in message && message.location) {
    const zones = findTimeZones(message.location.latitude, message.location.longitude);
    return zones[0] ?? null;
  }

  if (!("text" in message) || !message.text) return null;
  return normalizeTimezoneInput(message.text);
}

function normalizeTimezoneInput(input: string) {
  const value = input.trim();
  if (!value) return null;
  const known = cityTimezoneMap.get(normalizeCityTimezoneKey(value));
  if (known) return known;
  return isValidTimeZone(value) ? value : null;
}

function normalizeCityTimezoneKey(value: string) {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/(?:城市|市)$/u, "")
    .trim();
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
  ["迪拜", "Asia/Dubai"],
  ["dubai", "Asia/Dubai"],
  ["伦敦", "Europe/London"],
  ["london", "Europe/London"],
  ["纽约", "America/New_York"],
  ["new york", "America/New_York"],
  ["洛杉矶", "America/Los_Angeles"],
  ["los angeles", "America/Los_Angeles"]
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
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offsetMinutes = Math.round((asUtc - date.getTime()) / 60000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `${sign}${hours}${minutes}`;
}

async function handleChatFeatureCallback(ctx: Context, config: AppConfig) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const [, feature, chatId] = data.split(":");
  if (!feature || !chatId) return;

  const locale = await getLocale(ctx);
  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!chat) {
    await editOrReply(ctx, locale === "zh-CN" ? "找不到该管理对象。" : "Managed chat not found.", homeKeyboard(locale));
    return;
  }

  rememberSelectedChatForModules(ctx.from?.id, chat.id);

  if (feature === "block") {
    const settings = await getBlocklistSettings(chatId);
    await editOrReply(ctx, blocklistText(settings, locale), blocklistKeyboard(chatId, settings, locale));
    return;
  }

  if (feature === "welcome") {
    const settings = await getWelcomeSettings(chatId);
    await editOrReply(ctx, welcomeText(settings, locale), welcomeKeyboard(chatId, settings, locale));
    return;
  }

  if (feature === "join_verify") {
    const settings = await getJoinVerifySettings(chatId);
    await editOrReply(ctx, joinVerifyText(settings, locale), joinVerifyKeyboard(chatId, settings, locale));
    return;
  }

  if (feature === "auto_delete") {
    const settings = await getAutoDeleteSettings(chatId);
    await editOrReply(ctx, autoDeleteText(settings, locale), autoDeleteKeyboard(chatId, settings, locale));
    return;
  }

  if (feature === "auto_reply") {
    const settings = await getAutoReplySettings(chatId);
    await editOrReply(ctx, autoReplyText(settings, locale), autoReplyKeyboard(chatId, settings, locale));
    return;
  }

  if (feature === "new_member_limit") {
    await openNewMemberLimitMenu(ctx, config, locale);
    return;
  }

  if (feature === "open_close") {
    await openOpenCloseMenu(ctx, config, locale);
    return;
  }

  if (feature === "adult_check") {
    await openAdultCheckMenu(ctx, locale);
    return;
  }

  if (feature === "scheduled") {
    await openScheduledMessagePanel(ctx, locale, chat);
    return;
  }

  if (feature === "stats") {
    const statDate = formatDate(new Date());
    const stats = await getStats(chat.id, statDate);
    await editOrReply(ctx, statsText(stats, 1, locale), chatPanelKeyboard(chat.id, chat.type === "CHANNEL" ? "channel" : "group", locale));
    return;
  }

  if (feature === "publish") {
    await renderPublishHome(ctx, locale);
    return;
  }

  if (feature === "permissions") {
    await openPermissionsPanel(ctx, locale, chat);
    return;
  }

  if (feature === "invite") {
    await openInviteLinkPanel(ctx, config, locale, chat);
    return;
  }

  if (feature === "giveaway") {
    await openGiveawayPanel(ctx, locale, chat);
    return;
  }

  if (feature === "points") {
    await openPointsPanel(ctx, locale, chat);
    return;
  }

  if (feature === "member_stats" || feature === "schedule" || feature === "night_mode" || feature === "commands" || feature === "speech_check" || feature === "banned_words" || feature === "anti_spam" || feature === "import" || feature === "members" || feature === "sync") {
    await editOrReply(
      ctx,
      locale === "zh-CN"
        ? "该功能暂未接入。"
        : "This feature is not wired up yet.",
      chatPanelKeyboard(chat.id, chat.type === "CHANNEL" ? "channel" : "group", locale)
    );
    return;
  }

  await editOrReply(ctx, locale === "zh-CN" ? "该功能正在开发中。" : "This feature is under development.", chatPanelKeyboard(chat.id, chat.type === "CHANNEL" ? "channel" : "group", locale));
}

async function handleNewMemberLimitCallback(ctx: Context, config: AppConfig) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const locale = await getLocale(ctx);
  const key = ctx.callbackQuery?.data?.replace("new_member_limit:", "");
  if (!key) return;
  await handleNewMemberLimitAction(ctx, config, locale, key);
}

async function handleOpenCloseCallback(ctx: Context, config: AppConfig) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const locale = await getLocale(ctx);
  const key = ctx.callbackQuery?.data?.replace("open_close:", "");
  if (!key) return;
  await handleOpenCloseAction(ctx, config, locale, key);
}

async function handleAdultCheckCallback(ctx: Context) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const locale = await getLocale(ctx);
  const key = ctx.callbackQuery?.data?.replace("adult_check:", "");
  if (!key) return;
  await handleAdultCheckAction(ctx, locale, key);
}

async function openPermissionsPanel(ctx: Context, locale: Locale, chat: PrismaChat) {
  const scope = chat.type === "CHANNEL" ? "channel" : "group";
  const report = await getBotPermissionReport(ctx, Number(chat.telegramChatId)).catch(() => null);
  const text = report
    ? [
        locale === "zh-CN" ? "<b>⚙️ 控制权限</b>" : "<b>⚙️ Permissions</b>",
        "",
        report.canManageBaseFeatures
          ? (locale === "zh-CN" ? "Bot 权限检查通过。" : "Bot permission check passed.")
          : `${locale === "zh-CN" ? "缺少权限：" : "Missing permissions:"}\n${report.missingPermissions.join("\n")}`
      ].join("\n")
    : (locale === "zh-CN" ? "无法读取 Bot 权限。" : "Could not read Bot permissions.");
  await editOrReply(ctx, text, chatPanelKeyboard(chat.id, scope, locale));
}

async function openInviteLinkPanel(ctx: Context, config: AppConfig, locale: Locale, chat: PrismaChat) {
  if (!ctx.from) return;
  const scope = chat.type === "CHANNEL" ? "channel" : "group";
  const user = await upsertTelegramUser(ctx.from, config.defaultTimezone);
  const invite = await ctx.api.createChatInviteLink(Number(chat.telegramChatId), {
    name: `xd-${ctx.from.id}-${Date.now()}`.slice(0, 32)
  }).catch(() => null);

  if (!invite) {
    await editOrReply(
      ctx,
      locale === "zh-CN" ? "无法创建邀请链接，请确认 Bot 拥有邀请用户权限。" : "Could not create an invite link. Check bot permissions.",
      chatPanelKeyboard(chat.id, scope, locale)
    );
    return;
  }

  await prisma.inviteLink.upsert({
    where: { inviteLink: invite.invite_link },
    create: {
      chatId: chat.id,
      creatorUserId: user.id,
      inviteLink: invite.invite_link,
      expireAt: invite.expire_date ? new Date(invite.expire_date * 1000) : null,
      memberLimit: invite.member_limit ?? null,
      createsJoinRequest: invite.creates_join_request,
      revokedAt: invite.is_revoked ? new Date() : null
    },
    update: {
      revokedAt: invite.is_revoked ? new Date() : null
    }
  }).catch(() => undefined);

  await editOrReply(
    ctx,
    [
      locale === "zh-CN" ? "<b>🔗 邀请链接</b>" : "<b>🔗 Invite links</b>",
      "",
      invite.invite_link
    ].join("\n"),
    chatPanelKeyboard(chat.id, scope, locale)
  );
}

async function openGiveawayPanel(ctx: Context, locale: Locale, chat: PrismaChat) {
  const scope = chat.type === "CHANNEL" ? "channel" : "group";
  const giveaways = await prisma.giveaway.findMany({
    where: { chatId: chat.id, status: GiveawayStatus.ACTIVE },
    orderBy: { drawAt: "asc" },
    take: 10
  });

  if (!giveaways.length) {
    await editOrReply(
      ctx,
      locale === "zh-CN" ? "当前没有进行中的抽奖。" : "No active giveaways.",
      chatPanelKeyboard(chat.id, scope, locale)
    );
    return;
  }

  const keyboard = new InlineKeyboard();
  const lines = giveaways.map((item, index) => {
    keyboard.text(locale === "zh-CN" ? `参与 ${index + 1}` : `Join ${index + 1}`, `giveaway:join:${item.id}`).row();
    return `${index + 1}. ${escapeHtml(item.title)} - ${escapeHtml(item.prize)}`;
  });

  await editOrReply(
    ctx,
    [
      locale === "zh-CN" ? "<b>🎁 抽奖</b>" : "<b>🎁 Giveaway</b>",
      "",
      ...lines
    ].join("\n"),
    keyboard
      .row()
      .text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `menu:chat:${scope}:${chat.id}`)
      .text(locale === "zh-CN" ? "🏠 首页" : "🏠 Home", "menu:home")
  );
}

async function openPointsPanel(ctx: Context, locale: Locale, chat: PrismaChat) {
  const scope = chat.type === "CHANNEL" ? "channel" : "group";
  const rows = await prisma.chatPointBalance.findMany({
    where: { chatId: chat.id },
    include: { user: true },
    orderBy: { balance: "desc" },
    take: 10
  });

  const lines = rows.length
    ? rows.map((row, index) => `${index + 1}. ${displayPrismaUser(row.user)} - ${row.balance}`)
    : [locale === "zh-CN" ? "暂无积分记录。" : "No points yet."];

  await editOrReply(
    ctx,
    [
      locale === "zh-CN" ? "<b>Ⓜ️ 积分</b>" : "<b>Ⓜ️ Points</b>",
      "",
      ...lines
    ].join("\n"),
    chatPanelKeyboard(chat.id, scope, locale)
  );
}

async function handleBlocklistCallback(ctx: Context) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const [, action, key, chatId] = data.split(":");
  if (action !== "toggle" || !key || !chatId) return;

  const settings = await getBlocklistSettings(chatId);
  if (key in settings && typeof settings[key as keyof BlocklistSettings] === "boolean") {
    const typedKey = key as keyof Pick<BlocklistSettings, "blockBots" | "banAfterLeave" | "blockFlashJoinLeave" | "blockFollowerRaid">;
    settings[typedKey] = !settings[typedKey];
    await saveSetting(chatId, "blocklist", settingsToJson(settings));
  }

  const locale = await getLocale(ctx);
  await editOrReply(ctx, blocklistText(settings, locale), blocklistKeyboard(chatId, settings, locale));
}

async function handleWelcomeCallback(ctx: Context) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const data = ctx.callbackQuery?.data;
  const chatId = data?.split(":")[2];
  if (!chatId) return;

  const settings = await getWelcomeSettings(chatId);
  settings.enabled = !settings.enabled;
  await saveSetting(chatId, "welcome", settingsToJson(settings));

  const locale = await getLocale(ctx);
  await editOrReply(ctx, welcomeText(settings, locale), welcomeKeyboard(chatId, settings, locale));
}

async function handleJoinVerifyCallback(ctx: Context) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const data = ctx.callbackQuery?.data;
  const parts = data?.split(":") ?? [];
  const action = parts[1];
  const chatId = parts[2];
  if (!action || !chatId) return;

  const settings = await getJoinVerifySettings(chatId);
  if (action === "toggle") settings.enabled = !settings.enabled;
  if (action === "approval") settings.adminApproval = !settings.adminApproval;
  await saveSetting(chatId, "join_verify", settingsToJson(settings));

  const locale = await getLocale(ctx);
  await editOrReply(ctx, joinVerifyText(settings, locale), joinVerifyKeyboard(chatId, settings, locale));
}

async function handleAutoDeleteCallback(ctx: Context) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const data = ctx.callbackQuery?.data;
  const parts = data?.split(":") ?? [];
  const action = parts[1];
  const value = parts[2];
  const chatId = parts[3] ?? parts[2];
  if (!action || !chatId || action === "noop") return;

  const settings = await getAutoDeleteSettings(chatId);
  if (action === "toggle") settings.enabled = !settings.enabled;
  if (action === "seconds" && value) settings.seconds = clampNumber(Number(value), 0, 86400);
  await saveSetting(chatId, "auto_delete", settingsToJson(settings));

  const locale = await getLocale(ctx);
  await editOrReply(ctx, autoDeleteText(settings, locale), autoDeleteKeyboard(chatId, settings, locale));
}

async function handleAutoReplyCallback(ctx: Context) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const [, action, chatId, value] = data.split(":");
  if (!action || !chatId) return;

  const locale = await getLocale(ctx);
  const settings = await getAutoReplySettings(chatId);

  if (action === "cancel") {
    if (ctx.from) autoReplyInputDrafts.delete(ctx.from.id);
    await editOrReply(ctx, autoReplyText(settings, locale), autoReplyKeyboard(chatId, settings, locale));
    return;
  }

  if (action === "noop") return;

  if (action === "toggle") {
    settings.enabled = value !== "off";
    await saveAutoReplySettings(chatId, settings);
    await editOrReply(ctx, autoReplyText(settings, locale), autoReplyKeyboard(chatId, settings, locale));
    return;
  }

  if (action === "delete_after") {
    settings.deleteAfterMinutes = clampNumber(Number(value ?? 0), 0, 1440);
    await saveAutoReplySettings(chatId, settings);
    await editOrReply(ctx, autoReplyText(settings, locale), autoReplyKeyboard(chatId, settings, locale));
    return;
  }

  if (action === "delete_previous") {
    settings.deletePreviousMessage = value === "on";
    await saveAutoReplySettings(chatId, settings);
    await editOrReply(ctx, autoReplyText(settings, locale), autoReplyKeyboard(chatId, settings, locale));
    return;
  }

  if (action === "skip_buttons") {
    if (!ctx.from) return;
    const draft = autoReplyInputDrafts.get(ctx.from.id);
    if (!draft || draft.chatId !== chatId || draft.stage !== "buttons") return;
    await finalizeAutoReplyRule(ctx, locale, draft);
    return;
  }

  if (action === "add") {
    if (!ctx.from) return;
    clearUserInputState(ctx.from.id);
    autoReplyInputDrafts.set(ctx.from.id, { chatId, stage: "keyword" });
    await editOrReply(ctx, autoReplyKeywordPromptText(settings, locale), autoReplyCancelKeyboard(chatId, locale));
    return;
  }

  if (action === "delete") {
    if (!settings.rules.length) {
      await ctx.answerCallbackQuery({
        text: locale === "zh-CN" ? "暂无可删除的关键词。" : "No keywords to delete."
      }).catch(() => undefined);
      return;
    }
    await editOrReply(ctx, autoReplyDeleteText(settings, locale), autoReplyDeleteKeyboard(chatId, settings, locale));
    return;
  }

  if (action === "delete_rule" && value) {
    settings.rules = settings.rules.filter((rule) => rule.id !== value);
    await saveAutoReplySettings(chatId, settings);
    await editOrReply(ctx, autoReplyText(settings, locale), autoReplyKeyboard(chatId, settings, locale));
  }
}

async function handleIncomingMessage(ctx: Context, config: AppConfig) {
  const message = ctx.message;
  if (!message || !ctx.chat) return;

  const chat = await getActiveChatByTelegramId(ctx.chat.id);
  if (chat && ctx.from && isGroupLike(ctx.chat)) {
    await recordMessageStat(chat.id, ctx.from, config.defaultTimezone);
  }

  if ("new_chat_members" in message && message.new_chat_members?.length) {
    await handleNewChatMembers(ctx, config, message.new_chat_members);
    return;
  }

  if ("left_chat_member" in message && message.left_chat_member) {
    await handleBlocklistLeftChatMember(ctx, message.left_chat_member);
    if (chat) await recordStatsEvent(chat.id, ChatStatsEventType.LEAVE, ctx.from, message.left_chat_member, config.defaultTimezone);
    return;
  }

  if (chat) {
    await maybeSendAutoReply(ctx, chat.id, message);
    await maybeAutoDelete(ctx, chat.id, message);
  }
}

async function handleNewChatMembers(ctx: Context, config: AppConfig, members: User[]) {
  if (!ctx.chat || !isGroupLike(ctx.chat)) return;

  const chat = await getActiveChatByTelegramId(ctx.chat.id);
  if (!chat) return;

  for (const member of members) {
    await upsertTelegramUser(member, config.defaultTimezone).catch(() => undefined);
    await recordStatsEvent(chat.id, ChatStatsEventType.JOIN, ctx.from, member, config.defaultTimezone);
    await recordInviteJoin(chat.id, member, ctx.message);

    const blocked = await handleBlocklistNewMember(ctx, chat, member);
    if (blocked) continue;

    const joinVerify = await getJoinVerifySettings(chat.id);
    if (joinVerify.enabled) {
      await startJoinVerification(ctx, chat, member, joinVerify);
      continue;
    }

    const welcome = await getWelcomeSettings(chat.id);
    if (welcome.enabled) await sendWelcome(ctx, chat, member, welcome);
  }
}

async function handleChatJoinRequest(ctx: Context, config: AppConfig) {
  const request = ctx.chatJoinRequest;
  if (!request) return;

  const chat = await upsertManagedChatFromTelegram(request.chat, config.defaultTimezone);
  await upsertTelegramUser(request.from, config.defaultTimezone).catch(() => undefined);

  const blocked = await handleBlocklistJoinRequest(ctx, chat, request);
  if (blocked) return;

  const settings = await getJoinVerifySettings(chat.id);
  if (settings.enabled && !settings.adminApproval) {
    await ctx.api.approveChatJoinRequest(request.chat.id, request.from.id).catch(() => undefined);
  }
}

async function handleBlocklistNewMember(ctx: Context, chat: PrismaChat, member: User) {
  const settings = await getBlocklistSettings(chat.id);
  const now = Date.now();
  recentJoins.set(userChatKey(chat.id, member.id), now);

  if (settings.blockBots && member.is_bot) {
    await banUser(ctx, Number(chat.telegramChatId), member.id);
    return true;
  }

  if (settings.blockFollowerRaid && isRaidJoin(chat.id, now, settings)) {
    await banUser(ctx, Number(chat.telegramChatId), member.id);
    return true;
  }

  return false;
}

async function handleBlocklistJoinRequest(ctx: Context, chat: PrismaChat, request: ChatJoinRequest) {
  const settings = await getBlocklistSettings(chat.id);
  const now = Date.now();

  if (settings.blockBots && request.from.is_bot) {
    await declineJoinRequest(ctx, request);
    return true;
  }

  if (settings.blockFollowerRaid && isRaidJoin(chat.id, now, settings)) {
    await declineJoinRequest(ctx, request);
    return true;
  }

  return false;
}

async function handleBlocklistLeftChatMember(ctx: Context, member: User) {
  if (!ctx.chat || !isGroupLike(ctx.chat)) return;
  const chat = await getActiveChatByTelegramId(ctx.chat.id);
  if (!chat) return;

  const settings = await getBlocklistSettings(chat.id);
  const joinedAt = recentJoins.get(userChatKey(chat.id, member.id));
  recentJoins.delete(userChatKey(chat.id, member.id));

  if (settings.banAfterLeave) {
    await banUser(ctx, ctx.chat.id, member.id);
    return;
  }

  if (
    settings.blockFlashJoinLeave &&
    joinedAt &&
    Date.now() - joinedAt <= settings.flashWindowSeconds * 1000
  ) {
    await banUser(ctx, ctx.chat.id, member.id);
  }
}

async function handleVerificationCallback(ctx: Context) {
  const data = ctx.callbackQuery?.data;
  const parts = data?.split(":") ?? [];
  const chatId = Number(parts[1]);
  const userId = Number(parts[2]);

  if (!ctx.from || ctx.from.id !== userId || !Number.isFinite(chatId)) {
    await ctx.answerCallbackQuery({ text: "This verification is not for you.", show_alert: true }).catch(() => undefined);
    return;
  }

  const key = verificationKey(chatId, userId);
  const pending = pendingVerifications.get(key);
  if (!pending) {
    await ctx.answerCallbackQuery({ text: "Verification expired.", show_alert: true }).catch(() => undefined);
    return;
  }

  clearTimeout(pending.timeout);
  pendingVerifications.delete(key);
  await ctx.api.restrictChatMember(chatId, userId, fullChatPermissions()).catch(() => undefined);
  await ctx.api.deleteMessage(chatId, pending.messageId).catch(() => undefined);
  await ctx.answerCallbackQuery({ text: "OK" }).catch(() => undefined);
}

async function startJoinVerification(ctx: Context, chat: PrismaChat, member: User, settings: JoinVerifySettings) {
  const telegramChatId = Number(chat.telegramChatId);
  await ctx.api.restrictChatMember(telegramChatId, member.id, noChatPermissions()).catch(() => undefined);

  const sent = await ctx.api.sendMessage(
    telegramChatId,
    `${displayName(member)}，请点击按钮完成进群验证。`,
    {
      reply_markup: new InlineKeyboard().text("✅ 我不是机器人", `verify:${telegramChatId}:${member.id}`)
    }
  );

  const key = verificationKey(telegramChatId, member.id);
  const existing = pendingVerifications.get(key);
  if (existing) clearTimeout(existing.timeout);

  const timeout = setTimeout(() => {
    pendingVerifications.delete(key);
    void punishUnverifiedMember(ctx, telegramChatId, member.id, settings.punishment);
    void ctx.api.deleteMessage(telegramChatId, sent.message_id).catch(() => undefined);
  }, settings.durationMinutes * 60 * 1000);

  pendingVerifications.set(key, {
    chatId: telegramChatId,
    userId: member.id,
    messageId: sent.message_id,
    timeout
  });
}

async function punishUnverifiedMember(ctx: Context, chatId: number, userId: number, punishment: JoinVerifySettings["punishment"]) {
  if (punishment === "mute") {
    await ctx.api.restrictChatMember(chatId, userId, noChatPermissions()).catch(() => undefined);
    return;
  }
  if (punishment === "ban") {
    await banUser(ctx, chatId, userId);
    return;
  }
  await ctx.api.banChatMember(chatId, userId).catch(() => undefined);
  await ctx.api.unbanChatMember(chatId, userId, { only_if_banned: true }).catch(() => undefined);
}

async function sendWelcome(ctx: Context, chat: PrismaChat, member: User, settings: WelcomeSettings) {
  const text = settings.text
    .replaceAll("{name}", displayName(member))
    .replaceAll("{username}", member.username ? `@${member.username}` : displayName(member))
    .replaceAll("{chat}", chat.title ?? "this group");

  const sent = await ctx.api.sendMessage(Number(chat.telegramChatId), text, { parse_mode: "HTML" }).catch(() => null);
  if (sent && settings.deleteAfterMinutes > 0) {
    setTimeout(() => {
      void ctx.api.deleteMessage(Number(chat.telegramChatId), sent.message_id).catch(() => undefined);
    }, settings.deleteAfterMinutes * 60 * 1000);
  }
}

async function handleInfoCommand(ctx: Context, config: AppConfig) {
  const locale = await getLocale(ctx);
  const user = ctx.from ? await upsertTelegramUser(ctx.from, config.defaultTimezone) : null;
  const lines = [
    locale === "zh-CN" ? "<b>当前信息</b>" : "<b>Current info</b>",
    ctx.from ? `User ID: <code>${ctx.from.id}</code>` : "User: -",
    user ? `DB User: <code>${user.id}</code>` : "DB User: -",
    ctx.chat ? `Chat ID: <code>${ctx.chat.id}</code>` : "Chat: -",
    ctx.chat && "title" in ctx.chat ? `Chat: ${escapeHtml(ctx.chat.title ?? "")}` : ""
  ].filter(Boolean);
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

async function handleBindCommand(ctx: Context, config: AppConfig) {
  const locale = await getLocale(ctx);
  if (!ctx.chat || !ctx.from || ctx.chat.type === "private") {
    await ctx.reply(locale === "zh-CN" ? "请在需要绑定的群组或频道中发送 /bind。" : "Send /bind in the group or channel you want to bind.");
    return;
  }

  const isAdmin = await isUserChatAdmin(ctx, ctx.chat.id, ctx.from.id).catch(() => false);
  if (!isAdmin) {
    await ctx.reply(locale === "zh-CN" ? "只有管理员可以绑定当前群组或频道。" : "Only admins can bind this chat.");
    return;
  }

  const report = await getBotPermissionReport(ctx, ctx.chat.id).catch((error) => ({
    canManageBaseFeatures: false,
    missingPermissions: [error instanceof Error ? error.message : String(error)]
  }));

  if (!report.canManageBaseFeatures) {
    await ctx.reply(`${locale === "zh-CN" ? "Bot 权限不足：" : "Bot is missing permissions:"}\n${report.missingPermissions.join("\n")}`);
    return;
  }

  const user = await upsertTelegramUser(ctx.from, config.defaultTimezone);
  const chat = await bindTelegramChat(ctx.chat, user.id, config.defaultTimezone);
  await ctx.reply(locale === "zh-CN" ? `已绑定：${chat.title ?? chat.username ?? chat.telegramChatId}` : `Bound: ${chat.title ?? chat.username ?? chat.telegramChatId}`);
}

async function handlePermissionsCommand(ctx: Context) {
  const locale = await getLocale(ctx);
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply(locale === "zh-CN" ? "请在群组或频道中使用该命令。" : "Use this command in a group or channel.");
    return;
  }

  const report = await getBotPermissionReport(ctx, ctx.chat.id);
  await ctx.reply(
    report.canManageBaseFeatures
      ? (locale === "zh-CN" ? "Bot 权限检查通过。" : "Bot permissions look good.")
      : `${locale === "zh-CN" ? "Bot 缺少权限：" : "Missing permissions:"}\n${report.missingPermissions.join("\n")}`
  );
}

async function handleInviteLinkCommand(ctx: Context, config: AppConfig) {
  const locale = await getLocale(ctx);
  if (!ctx.chat || !ctx.from || !isGroupLike(ctx.chat)) {
    await ctx.reply(locale === "zh-CN" ? "请在已绑定群组中使用 /link。" : "Use /link in a bound group.");
    return;
  }

  const chat = await getActiveChatByTelegramId(ctx.chat.id);
  if (!chat) {
    await ctx.reply(locale === "zh-CN" ? "请先使用 /bind 绑定该群组。" : "Bind this group first with /bind.");
    return;
  }

  const user = await upsertTelegramUser(ctx.from, config.defaultTimezone);
  const link = await ctx.api.createChatInviteLink(ctx.chat.id, {
    name: `xdoing-${ctx.from.id}-${Date.now()}`
  });

  await prisma.inviteLink.create({
    data: {
      chatId: chat.id,
      creatorUserId: user.id,
      inviteLink: link.invite_link,
      expireAt: link.expire_date ? new Date(link.expire_date * 1000) : null,
      memberLimit: link.member_limit ?? null,
      createsJoinRequest: link.creates_join_request ?? false
    }
  });

  await ctx.reply(`${locale === "zh-CN" ? "邀请链接：" : "Invite link:"}\n${link.invite_link}`);
}

async function handleSignInCommand(ctx: Context, config: AppConfig) {
  const locale = await getLocale(ctx);
  if (!ctx.chat || !ctx.from || !isGroupLike(ctx.chat)) {
    await ctx.reply(locale === "zh-CN" ? "请在群组中签到。" : "Sign in from a group.");
    return;
  }

  const chat = await getActiveChatByTelegramId(ctx.chat.id);
  if (!chat) {
    await ctx.reply(locale === "zh-CN" ? "请先绑定该群组。" : "Bind this group first.");
    return;
  }

  const user = await upsertTelegramUser(ctx.from, config.defaultTimezone);
  const statDate = formatDate(new Date());
  const referenceKey = `sign_in:${chat.id}:${user.id}:${statDate}`;
  const balance = await addPoints(chat.id, user.id, 1, PointTransactionType.SIGN_IN, referenceKey, null);
  await ctx.reply(locale === "zh-CN" ? `签到成功，当前积分：${balance}` : `Signed in. Current points: ${balance}`);
}

async function handlePointsRankCommand(ctx: Context) {
  const locale = await getLocale(ctx);
  if (!ctx.chat || !isGroupLike(ctx.chat)) return;
  const chat = await getActiveChatByTelegramId(ctx.chat.id);
  if (!chat) {
    await ctx.reply(locale === "zh-CN" ? "请先绑定该群组。" : "Bind this group first.");
    return;
  }

  const rows = await prisma.chatPointBalance.findMany({
    where: { chatId: chat.id },
    include: { user: true },
    orderBy: { balance: "desc" },
    take: 10
  });

  const lines = rows.map((row, index) => `${index + 1}. ${displayPrismaUser(row.user)} - ${row.balance}`);
  await ctx.reply(lines.length ? lines.join("\n") : (locale === "zh-CN" ? "暂无积分记录。" : "No points yet."));
}

async function handlePointsCommand(ctx: Context, config: AppConfig) {
  const locale = await getLocale(ctx);
  if (!ctx.chat || !ctx.from || !isGroupLike(ctx.chat)) return;
  const chat = await getActiveChatByTelegramId(ctx.chat.id);
  if (!chat) {
    await ctx.reply(locale === "zh-CN" ? "请先绑定该群组。" : "Bind this group first.");
    return;
  }

  const isAdmin = await isUserChatAdmin(ctx, ctx.chat.id, ctx.from.id).catch(() => false);
  if (!isAdmin) {
    await ctx.reply(locale === "zh-CN" ? "只有管理员可以增减积分。" : "Only admins can adjust points.");
    return;
  }

  const replyUser = "reply_to_message" in ctx.message! ? ctx.message!.reply_to_message?.from : undefined;
  const text = "text" in ctx.message! ? ctx.message!.text ?? "" : "";
  const delta = Number(text.split(/\s+/)[1]);
  if (!replyUser || !Number.isInteger(delta)) {
    await ctx.reply(locale === "zh-CN" ? "请回复用户消息并发送 /points 数字。" : "Reply to a user and send /points number.");
    return;
  }

  const user = await upsertTelegramUser(replyUser, config.defaultTimezone);
  const actor = await upsertTelegramUser(ctx.from, config.defaultTimezone);
  const balance = await addPoints(chat.id, user.id, delta, PointTransactionType.MANUAL, null, actor.id);
  await ctx.reply(locale === "zh-CN" ? `已调整，当前积分：${balance}` : `Adjusted. Current points: ${balance}`);
}

async function handleStatsCommand(ctx: Context, config: AppConfig, days: number) {
  const locale = await getLocale(ctx);
  if (!ctx.chat || !isGroupLike(ctx.chat)) return;
  const chat = await getActiveChatByTelegramId(ctx.chat.id);
  if (!chat) {
    await ctx.reply(locale === "zh-CN" ? "请先绑定该群组。" : "Bind this group first.");
    return;
  }

  const stats = await getStats(chat.id, formatDate(new Date()), days);
  await ctx.reply(statsText(stats, days, locale));
}

async function handleLotteryCommand(ctx: Context) {
  const locale = await getLocale(ctx);
  if (!ctx.chat || !isGroupLike(ctx.chat)) return;
  const chat = await getActiveChatByTelegramId(ctx.chat.id);
  if (!chat) {
    await ctx.reply(locale === "zh-CN" ? "请先绑定该群组。" : "Bind this group first.");
    return;
  }

  const giveaways = await prisma.giveaway.findMany({
    where: { chatId: chat.id, status: GiveawayStatus.ACTIVE },
    orderBy: { drawAt: "asc" },
    take: 10
  });

  if (!giveaways.length) {
    await ctx.reply(locale === "zh-CN" ? "当前没有进行中的抽奖。" : "No active giveaways.");
    return;
  }

  const keyboard = new InlineKeyboard();
  const lines = giveaways.map((item, index) => {
    keyboard.text(locale === "zh-CN" ? `参与 ${index + 1}` : `Join ${index + 1}`, `giveaway:join:${item.id}`).row();
    return `${index + 1}. ${item.title} - ${item.prize} (${item.winnersCount})`;
  });
  await ctx.reply(lines.join("\n"), { reply_markup: keyboard });
}

async function handleGiveawayJoinCallback(ctx: Context, config: AppConfig) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const id = ctx.callbackQuery?.data?.replace("giveaway:join:", "");
  if (!id || !ctx.from) return;

  const giveaway = await prisma.giveaway.findUnique({ where: { id } });
  if (!giveaway || giveaway.status !== GiveawayStatus.ACTIVE) {
    await ctx.answerCallbackQuery({ text: "抽奖不可参与", show_alert: true }).catch(() => undefined);
    return;
  }

  const user = await upsertTelegramUser(ctx.from, config.defaultTimezone);
  await prisma.giveawayEntry.upsert({
    where: { giveawayId_userId: { giveawayId: id, userId: user.id } },
    create: { giveawayId: id, userId: user.id },
    update: { isValid: true }
  });
  await ctx.answerCallbackQuery({ text: "已参与" }).catch(() => undefined);
}

async function showManagedChats(ctx: Context, scope: "group" | "channel", locale: Locale, botUsername: string) {
  if (!ctx.from) return;
  const user = await prisma.user.findUnique({ where: { telegramUserId: BigInt(ctx.from.id) } });
  if (!user) {
    await editOrReply(ctx, locale === "zh-CN" ? "请先发送 /start。" : "Send /start first.", homeKeyboard(locale));
    return;
  }

  const managed = await listManagedChats(user.id);
  const chats = managed.filter((chat) => scope === "channel" ? chat.type === "CHANNEL" : chat.type === "GROUP" || chat.type === "SUPERGROUP");
  await editOrReply(
    ctx,
    scope === "group" ? buildGroupGuideText(locale, botUsername) : buildChannelGuideText(locale, botUsername),
    managedChatKeyboard(chats, scope, locale, botUsername)
  );
}

async function getWelcomeSettings(chatId: string) {
  return {
    ...defaultWelcomeSettings,
    ...await getSettingRecord(chatId, "welcome")
  } as WelcomeSettings;
}

async function getJoinVerifySettings(chatId: string) {
  const raw = await getSettingRecord(chatId, "join_verify");
  return {
    ...defaultJoinVerifySettings,
    ...raw,
    punishment: raw.punishment === "ban" || raw.punishment === "mute" ? raw.punishment : defaultJoinVerifySettings.punishment
  } as JoinVerifySettings;
}

async function getBlocklistSettings(chatId: string) {
  const raw = await getSettingRecord(chatId, "blocklist");
  return {
    ...defaultBlocklistSettings,
    ...raw,
    flashWindowSeconds: clampNumber(Number(raw.flashWindowSeconds ?? defaultBlocklistSettings.flashWindowSeconds), 10, 3600),
    raidWindowSeconds: clampNumber(Number(raw.raidWindowSeconds ?? defaultBlocklistSettings.raidWindowSeconds), 10, 3600),
    raidJoinThreshold: clampNumber(Number(raw.raidJoinThreshold ?? defaultBlocklistSettings.raidJoinThreshold), 3, 100)
  } as BlocklistSettings;
}

async function getAutoDeleteSettings(chatId: string) {
  const raw = await getSettingRecord(chatId, "auto_delete");
  return {
    ...defaultAutoDeleteSettings,
    ...raw,
    seconds: clampNumber(Number(raw.seconds ?? defaultAutoDeleteSettings.seconds), 0, 86400)
  } as AutoDeleteSettings;
}

async function getAutoReplySettings(chatId: string) {
  const raw = await getSettingRecord(chatId, "auto_reply");
  const rules = Array.isArray(raw.rules)
    ? raw.rules.map(parseAutoReplyRule).filter((rule): rule is AutoReplyRule => Boolean(rule))
    : [];
  return {
    ...defaultAutoReplySettings,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : defaultAutoReplySettings.enabled,
    deleteAfterMinutes: clampNumber(Number(raw.deleteAfterMinutes ?? defaultAutoReplySettings.deleteAfterMinutes), 0, 1440),
    deletePreviousMessage: typeof raw.deletePreviousMessage === "boolean"
      ? raw.deletePreviousMessage
      : defaultAutoReplySettings.deletePreviousMessage,
    rules
  } as AutoReplySettings;
}

async function saveAutoReplySettings(chatId: string, settings: AutoReplySettings) {
  await saveSetting(chatId, "auto_reply", settingsToJson({
    enabled: settings.enabled,
    deleteAfterMinutes: settings.deleteAfterMinutes,
    deletePreviousMessage: settings.deletePreviousMessage,
    rules: settings.rules.map((rule) => ({
      id: rule.id,
      keyword: rule.keyword,
      matchType: rule.matchType,
      response: rule.response,
      ...(rule.mediaKind && rule.mediaFileId ? {
        mediaKind: rule.mediaKind,
        mediaFileId: rule.mediaFileId
      } : {}),
      ...(rule.buttons?.length ? { buttons: rule.buttons } : {})
    }))
  }));
}

function parseAutoReplyRule(value: unknown): AutoReplyRule | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : "";
  const keyword = typeof value.keyword === "string" ? value.keyword.trim() : "";
  const response = typeof value.response === "string" ? value.response.trim() : "";
  const matchType = value.matchType === "contains" ? "contains" : value.matchType === "exact" ? "exact" : null;
  const mediaKind = isAutoReplyMediaKind(value.mediaKind) ? value.mediaKind : undefined;
  const mediaFileId = typeof value.mediaFileId === "string" ? value.mediaFileId : undefined;
  const buttons = parseAutoReplyButtons(value.buttons);
  if (!id || !keyword || !matchType || (!response && !(mediaKind && mediaFileId))) return null;
  return {
    id,
    keyword,
    response,
    matchType,
    ...(mediaKind && mediaFileId ? { mediaKind, mediaFileId } : {}),
    ...(buttons ? { buttons } : {})
  };
}

function isAutoReplyMediaKind(value: unknown): value is AutoReplyMediaKind {
  return value === "photo"
    || value === "video"
    || value === "animation"
    || value === "sticker"
    || value === "document"
    || value === "audio"
    || value === "voice";
}

function parseAutoReplyButtons(value: unknown): AutoReplyButton[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value
    .map((row) => Array.isArray(row)
      ? row
        .map((item) => {
          if (!isRecord(item) || typeof item.text !== "string" || typeof item.url !== "string") return null;
          return { text: item.text.slice(0, 64), url: item.url } as AutoReplyButton;
        })
        .filter((item): item is AutoReplyButton => Boolean(item))
      : [])
    .filter((row) => row.length > 0);
  return rows.length ? rows : undefined;
}

async function getSettingRecord(chatId: string, key: string): Promise<SettingRecord> {
  const setting = await prisma.setting.findUnique({
    where: { chatId_key: { chatId, key } }
  });
  return isRecord(setting?.value) ? setting.value : {};
}

async function saveSetting(chatId: string, key: string, value: Prisma.InputJsonObject) {
  await prisma.setting.upsert({
    where: { chatId_key: { chatId, key } },
    create: { chatId, key, value },
    update: { value }
  });
}

function settingsToJson(value: Record<string, unknown>): Prisma.InputJsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Prisma.InputJsonObject;
}

async function getActiveChatByTelegramId(telegramChatId: number) {
  return prisma.chat.findFirst({
    where: {
      telegramChatId: BigInt(telegramChatId),
      status: ChatStatus.ACTIVE
    }
  });
}

async function upsertManagedChatFromTelegram(chat: Chat, defaultTimezone: string) {
  const existing = await getActiveChatByTelegramId(chat.id);
  if (existing) return existing;
  return bindTelegramChat(chat, undefined, defaultTimezone);
}

async function recordMessageStat(chatId: string, user: User, defaultTimezone: string) {
  if (user.is_bot) return;
  const savedUser = await upsertTelegramUser(user, defaultTimezone);
  await prisma.chatDailyMessageStat.upsert({
    where: {
      chatId_userId_statDate: {
        chatId,
        userId: savedUser.id,
        statDate: formatDate(new Date())
      }
    },
    create: {
      chatId,
      userId: savedUser.id,
      statDate: formatDate(new Date()),
      messageCount: 1
    },
    update: {
      messageCount: { increment: 1 }
    }
  });
}

async function recordStatsEvent(chatId: string, eventType: ChatStatsEventType, actor: User | undefined, target: User | undefined, defaultTimezone: string) {
  const actorUser = actor ? await upsertTelegramUser(actor, defaultTimezone).catch(() => null) : null;
  const targetUser = target ? await upsertTelegramUser(target, defaultTimezone).catch(() => null) : null;
  await prisma.chatStatsEvent.create({
    data: {
      chatId,
      eventType,
      actorUserId: actorUser?.id ?? null,
      targetUserId: targetUser?.id ?? null,
      statDate: formatDate(new Date())
    }
  });
}

async function recordInviteJoin(chatId: string, member: User, message: Message | undefined) {
  const inviteLink = extractInviteLink(message);
  const user = await prisma.user.findUnique({ where: { telegramUserId: BigInt(member.id) } });
  if (!user) return;

  const savedInviteLink = inviteLink
    ? await prisma.inviteLink.findUnique({ where: { inviteLink: inviteLink.invite_link } })
    : null;

  await prisma.inviteJoin.upsert({
    where: { chatId_userId: { chatId, userId: user.id } },
    create: {
      chatId,
      userId: user.id,
      inviteLinkId: savedInviteLink?.id ?? null
    },
    update: {
      joinedAt: new Date(),
      leftAt: null,
      inviteLinkId: savedInviteLink?.id ?? null
    }
  });
}

async function maybeAutoDelete(ctx: Context, chatId: string, message: Message) {
  const settings = await getAutoDeleteSettings(chatId);
  if (!settings.enabled || settings.seconds <= 0 || !ctx.chat) return;
  setTimeout(() => {
    void ctx.api.deleteMessage(ctx.chat!.id, message.message_id).catch(() => undefined);
  }, settings.seconds * 1000);
}

function autoReplyInlineKeyboard(buttons: AutoReplyButton[][] | undefined) {
  if (!buttons?.length) return undefined;
  const keyboard = new InlineKeyboard();
  buttons.forEach((row, rowIndex) => {
    row.forEach((button) => keyboard.url(button.text, button.url));
    if (rowIndex < buttons.length - 1) keyboard.row();
  });
  return keyboard;
}

async function sendAutoReplyResponse(ctx: Context, rule: AutoReplyRule, triggerMessageId: number): Promise<Message[]> {
  if (!ctx.chat) return [];

  const replyMarkup = autoReplyInlineKeyboard(rule.buttons);
  const baseOptions = {
    reply_to_message_id: triggerMessageId,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  };
  const captionOptions = rule.response
    ? { caption: rule.response, parse_mode: "HTML" as const }
    : {};

  try {
    if (!rule.mediaKind || !rule.mediaFileId) {
      const sent = await ctx.api.sendMessage(ctx.chat.id, rule.response, {
        ...baseOptions,
        parse_mode: "HTML"
      });
      return [sent];
    }

    if (rule.mediaKind === "photo") {
      return [await ctx.api.sendPhoto(ctx.chat.id, rule.mediaFileId, { ...baseOptions, ...captionOptions })];
    }
    if (rule.mediaKind === "video") {
      return [await ctx.api.sendVideo(ctx.chat.id, rule.mediaFileId, { ...baseOptions, ...captionOptions })];
    }
    if (rule.mediaKind === "animation") {
      return [await ctx.api.sendAnimation(ctx.chat.id, rule.mediaFileId, { ...baseOptions, ...captionOptions })];
    }
    if (rule.mediaKind === "document") {
      return [await ctx.api.sendDocument(ctx.chat.id, rule.mediaFileId, { ...baseOptions, ...captionOptions })];
    }
    if (rule.mediaKind === "audio") {
      return [await ctx.api.sendAudio(ctx.chat.id, rule.mediaFileId, { ...baseOptions, ...captionOptions })];
    }
    if (rule.mediaKind === "voice") {
      return [await ctx.api.sendVoice(ctx.chat.id, rule.mediaFileId, { ...baseOptions, ...captionOptions })];
    }

    const sticker = await ctx.api.sendSticker(ctx.chat.id, rule.mediaFileId, baseOptions);
    if (!rule.response) return [sticker];
    const text = await ctx.api.sendMessage(ctx.chat.id, rule.response, {
      ...baseOptions,
      parse_mode: "HTML"
    });
    return [sticker, text];
  } catch (error) {
    console.error("Failed to send auto reply", {
      chatId: ctx.chat.id,
      ruleId: rule.id,
      error
    });
    return [];
  }
}

async function maybeSendAutoReply(ctx: Context, chatId: string, message: Message) {
  if (!ctx.chat || ctx.from?.is_bot) return;
  const text = getMessageText(message);
  if (!text) return;

  const settings = await getAutoReplySettings(chatId);
  if (!settings.enabled || !settings.rules.length) return;

  const normalizedText = text.trim();
  const rule = settings.rules.find((item) =>
    item.matchType === "exact"
      ? normalizedText === item.keyword
      : normalizedText.includes(item.keyword)
  );
  if (!rule) return;

  const sentMessages = await sendAutoReplyResponse(ctx, rule, message.message_id);
  if (!sentMessages.length) return;
  if (settings.deletePreviousMessage) {
    await ctx.api.deleteMessage(ctx.chat.id, message.message_id).catch(() => undefined);
  }
  if (settings.deleteAfterMinutes > 0) {
    setTimeout(() => {
      for (const sent of sentMessages) {
        void ctx.api.deleteMessage(ctx.chat!.id, sent.message_id).catch(() => undefined);
      }
    }, settings.deleteAfterMinutes * 60 * 1000);
  }
}

async function addPoints(
  chatId: string,
  userId: string,
  delta: number,
  type: PointTransactionType,
  referenceKey: string | null,
  actorUserId: string | null
) {
  const result = await prisma.$transaction(async (tx) => {
    if (referenceKey) {
      const existing = await tx.chatPointTransaction.findUnique({ where: { referenceKey } });
      if (existing) {
        const current = await tx.chatPointBalance.findUnique({ where: { chatId_userId: { chatId, userId } } });
        return current?.balance ?? existing.balanceAfter ?? 0;
      }
    }

    const balance = await tx.chatPointBalance.upsert({
      where: { chatId_userId: { chatId, userId } },
      create: { chatId, userId, balance: delta, lastTransactionAt: new Date() },
      update: { balance: { increment: delta }, lastTransactionAt: new Date() }
    });

    await tx.chatPointTransaction.create({
      data: {
        chatId,
        userId,
        actorUserId,
        type,
        delta,
        balanceAfter: balance.balance,
        referenceKey,
        metadata: {}
      }
    });

    return balance.balance;
  });

  return result;
}

async function getStats(chatId: string, endDate: string, days = 1) {
  const start = new Date(`${endDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  const dates = new Set<string>();
  for (let i = 0; i < days; i++) {
    const item = new Date(start);
    item.setUTCDate(item.getUTCDate() + i);
    dates.add(formatDate(item));
  }

  const [messages, joins, leaves] = await Promise.all([
    prisma.chatDailyMessageStat.aggregate({
      where: { chatId, statDate: { in: [...dates] } },
      _sum: { messageCount: true },
      _count: { userId: true }
    }),
    prisma.chatStatsEvent.count({
      where: { chatId, statDate: { in: [...dates] }, eventType: ChatStatsEventType.JOIN }
    }),
    prisma.chatStatsEvent.count({
      where: { chatId, statDate: { in: [...dates] }, eventType: ChatStatsEventType.LEAVE }
    })
  ]);

  return {
    messageCount: messages._sum.messageCount ?? 0,
    activeUsers: messages._count.userId,
    joins,
    leaves
  };
}

function statsText(stats: Awaited<ReturnType<typeof getStats>>, days: number, locale: Locale) {
  const title = locale === "zh-CN" ? `近 ${days} 天统计` : `Stats for ${days} day(s)`;
  return [
    `<b>${title}</b>`,
    `${locale === "zh-CN" ? "消息数" : "Messages"}: ${stats.messageCount}`,
    `${locale === "zh-CN" ? "活跃用户" : "Active users"}: ${stats.activeUsers}`,
    `${locale === "zh-CN" ? "进群" : "Joins"}: ${stats.joins}`,
    `${locale === "zh-CN" ? "退群" : "Leaves"}: ${stats.leaves}`
  ].join("\n");
}

function chatPanelText(chat: PrismaChat, locale: Locale) {
  const title = escapeHtml(chat.title ?? chat.username ?? String(chat.telegramChatId));
  return locale === "zh-CN"
    ? `⏳ 正在设置 <b>${title}</b>，选择要更改的项目\n\n<b>ID</b>: <code>${chat.telegramChatId.toString()}</code>`
    : `⏳ Configuring <b>${title}</b>, choose what to change.\n\n<b>ID</b>: <code>${chat.telegramChatId.toString()}</code>`;
}

function blocklistText(settings: BlocklistSettings, locale: Locale) {
  if (locale !== "zh-CN") {
    return [
      "<b>🚫 Block</b>",
      `Bots: ${onOff(settings.blockBots)}`,
      `Ban after leave: ${onOff(settings.banAfterLeave)}`,
      `Flash join/leave: ${onOff(settings.blockFlashJoinLeave)} (${settings.flashWindowSeconds}s)`,
      `Join raid: ${onOff(settings.blockFollowerRaid)} (${settings.raidJoinThreshold}/${settings.raidWindowSeconds}s)`
    ].join("\n");
  }

  return [
    "<b>🚫 屏蔽</b>",
    `屏蔽机器人：${onOffZh(settings.blockBots)}`,
    `退群封禁：${onOffZh(settings.banAfterLeave)}`,
    `屏蔽闪进闪退：${onOffZh(settings.blockFlashJoinLeave)}（${settings.flashWindowSeconds} 秒内退群）`,
    `屏蔽刷粉攻击：${onOffZh(settings.blockFollowerRaid)}（${settings.raidWindowSeconds} 秒 ${settings.raidJoinThreshold} 人）`
  ].join("\n");
}

function welcomeText(settings: WelcomeSettings, locale: Locale) {
  return locale === "zh-CN"
    ? `<b>🎉 进群欢迎</b>\n状态：${onOffZh(settings.enabled)}\n欢迎语：${escapeHtml(settings.text)}`
    : `<b>🎉 Welcome</b>\nStatus: ${onOff(settings.enabled)}\nText: ${escapeHtml(settings.text)}`;
}

function joinVerifyText(settings: JoinVerifySettings, locale: Locale) {
  return locale === "zh-CN"
    ? `<b>🧩 进群验证</b>\n状态：${onOffZh(settings.enabled)}\n管理员审批：${onOffZh(settings.adminApproval)}`
    : `<b>🧩 Join verification</b>\nStatus: ${onOff(settings.enabled)}\nAdmin approval: ${onOff(settings.adminApproval)}`;
}

function autoDeleteText(settings: AutoDeleteSettings, locale: Locale) {
  return locale === "zh-CN"
    ? `<b>🧹 自动删除</b>\n状态：${onOffZh(settings.enabled)}\n延迟：${settings.seconds} 秒`
    : `<b>🧹 Auto delete</b>\nStatus: ${onOff(settings.enabled)}\nDelay: ${settings.seconds}s`;
}

function autoReplyText(settings: AutoReplySettings, locale: Locale) {
  if (locale !== "zh-CN") {
    return `💬 Keyword replies <b>Configured:</b> ${settings.rules.length}`;
  }

  return `💬 关键词回复 <b>已设置:</b> ${settings.rules.length} 条`;
}

function autoReplyDeleteText(settings: AutoReplySettings, locale: Locale) {
  const lines = settings.rules.map((rule, index) => `${index + 1}. ${rule.matchType === "exact" ? "-" : "*"} ${escapeHtml(rule.keyword)}`);
  return locale === "zh-CN"
    ? ["🗑 <b>删除关键词</b>", "", "选择要删除的关键词：", ...lines].join("\n")
    : ["🗑 <b>Delete keyword</b>", "", "Choose a keyword to delete:", ...lines].join("\n");
}

function autoReplyKeywordPromptText(settings: AutoReplySettings, locale: Locale) {
  const rules = settings.rules.length
    ? settings.rules.map((rule) => `${rule.matchType === "exact" ? "-" : "*"} ${escapeHtml(rule.keyword)}`)
    : ["[None]"];

  return locale === "zh-CN"
    ? [
        "💬 关键词回复",
        "",
        "<strong>已添加的关键词:</strong>",
        ...rules,
        "",
        "👉 第一步 请输入关键词:",
        "<i>直接输入为精准匹配，使用 * 开头为包含匹配</i>"
      ].join("\n")
    : [
        "💬 Keyword replies",
        "",
        "<strong>Added keywords:</strong>",
        ...rules,
        "",
        "👉 Step 1: Send a keyword:",
        "<i>Plain text matches exactly; use * for contains matching.</i>"
      ].join("\n");
}

function autoReplyResponsePromptText(keyword: string, locale: Locale) {
  const escapedKeyword = escapeHtml(keyword);
  return locale === "zh-CN"
    ? [
        "💬 关键词回复",
        "",
        `👉 第二步 请输入关键词<code>${escapedKeyword}</code>的回复内容（支持 <a href="tg://bot_command?command=html">HTML</a>，文字字体格式(加粗、链接、剧透、块引用等)，图片，表情，视频，文件等）:`
      ].join("\n")
    : [
        "💬 Keyword replies",
        "",
        `👉 Step 2: Send the reply content for <code>${escapedKeyword}</code> (HTML, formatting, images, videos, and files are supported):`
      ].join("\n");
}

function autoReplyButtonsPromptText(locale: Locale) {
  return locale === "zh-CN"
    ? [
        "💬 关键词回复",
        "",
        "第三步 回复内容添加按钮链接",
        "",
        "按钮内容格式(点击文本复制):",
        "",
        "<code>官网 - link.com\n电报 - t.me/DarvisXBot\n官网 - link.com &amp;&amp; 电报 - t.me/DarvisXBot</code>",
        "",
        "· 按钮文字和网址中间用英文-隔开",
        "· 两个按钮在一行，请用 &amp;&amp; (没有空格)分隔",
        "· 网址有无 https:// 都可以",
        "",
        "<strong>👉 输入按钮内容进行设置:</strong>"
      ].join("\n")
    : [
        "💬 Keyword replies",
        "",
        "Step 3: Add link buttons to the reply",
        "",
        "Button format:",
        "",
        "<code>Website - link.com\nTelegram - t.me/DarvisXBot\nWebsite - link.com &amp;&amp; Telegram - t.me/DarvisXBot</code>",
        "",
        "Use a hyphen between button text and URL.",
        "Use && without spaces to put two buttons on one row.",
        "https:// is optional.",
        "",
        "<strong>👉 Send button content:</strong>"
      ].join("\n");
}

function isRaidJoin(chatId: string, now: number, settings: BlocklistSettings) {
  const windowStart = now - settings.raidWindowSeconds * 1000;
  const events = (raidJoinEvents.get(chatId) ?? []).filter((time) => time >= windowStart);
  events.push(now);
  raidJoinEvents.set(chatId, events);
  return events.length >= settings.raidJoinThreshold;
}

async function banUser(ctx: Context, chatId: number, userId: number) {
  await ctx.api.banChatMember(chatId, userId).catch((error) => {
    console.error("Failed to ban member", { chatId, userId, error });
  });
}

async function declineJoinRequest(ctx: Context, request: ChatJoinRequest) {
  await ctx.api.declineChatJoinRequest(request.chat.id, request.from.id).catch((error) => {
    console.error("Failed to decline join request", {
      chatId: request.chat.id,
      userId: request.from.id,
      error
    });
  });
}

function fullChatPermissions() {
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
    can_manage_topics: true
  };
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

function extractInviteLink(message: Message | undefined): ChatInviteLink | null {
  if (!message || !("invite_link" in message)) return null;
  return (message as Message & { invite_link?: ChatInviteLink | null }).invite_link ?? null;
}

function userChatKey(chatId: string, userId: number) {
  return `${chatId}:${userId}`;
}

function verificationKey(chatId: number, userId: number) {
  return `${chatId}:${userId}`;
}

function isGroupLike(chat: Chat) {
  return chat.type === "group" || chat.type === "supergroup";
}

function displayName(user: User) {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return escapeHtml(fullName || user.username || String(user.id));
}

function displayPrismaUser(user: PrismaUser) {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || String(user.telegramUserId);
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onOff(value: boolean) {
  return value ? "On" : "Off";
}

function onOffZh(value: boolean) {
  return value ? "开启" : "关闭";
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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

async function inferTimezone(ctx: Context, fallback: string) {
  if (!ctx.message?.location) return fallback;
  const zones = findTimeZones(ctx.message.location.latitude, ctx.message.location.longitude);
  return zones[0] ?? fallback;
}

void redis;
void defaultScheduledContent;
void defaultScheduledRepeatRule;
void scheduledContentToJson;
void scheduledRepeatRuleToJson;
void hasScheduledMessageContent;
void nextScheduledRun;
void enqueueScheduledMessage;
void cancelScheduledMessageJob;
void enqueueGiveawayDraw;
void cancelGiveawayDrawJob;
void ScheduledMessageStatus;

