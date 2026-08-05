import { ChatStatus, MembershipStatus, Prisma, type Chat as PrismaChat } from "@prisma/client";
import { InlineKeyboard, type Context } from "grammy";
import type { ChatPermissions, User } from "grammy/types";
import { prisma } from "../lib/prisma.js";
import { canConfigureChat, isUserChatAdmin } from "./permissions.js";

type Locale = "zh-CN" | "en";

type SpeechCheckInputField = "forbidden_names" | "punishment_minutes" | "required_channel";
type SpeechCheckPunishment = "warn" | "mute" | "kick" | "ban" | "delete_only";

type SpeechCheckSettings = {
  requireLastName: boolean;
  requireUsername: boolean;
  requireAvatar: boolean;
  requireChannelSubscription: boolean;
  requiredChannels: string[];
  forbiddenNameKeywords: string[];
  punishment: SpeechCheckPunishment;
  punishmentMinutes: number;
  permanentMute: boolean;
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
const noticeDeleteOptions = [10, 30, 60, 300, 600, 1800, 3600, 21600, 43200, 0] as const;
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

  if (key === "back" || key === "cancel") {
    inputDrafts.delete(ctx.from.id);
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
    await renderMenu(ctx, await buildRequiredChannelsListMenu(chat.id, locale), await requiredChannelsListKeyboard(chat.id, locale), "HTML");
    return;
  }

  if (key === "channel:add") {
    await renderMenu(ctx, buildRequiredChannelPrompt(locale), inputBackKeyboard(locale), "HTML");
    inputDrafts.set(ctx.from.id, { chatId: chat.id, field: "required_channel" });
    return;
  }

  if (key.startsWith("channel:noop:")) {
    return;
  }

  if (key.startsWith("channel:delete:")) {
    const index = Number(key.replace("channel:delete:", ""));
    if (Number.isInteger(index) && index >= 0) {
      const next = settings.requiredChannels.filter((_, itemIndex) => itemIndex !== index);
      await saveSpeechCheckSettings(chat.id, {
        requiredChannels: next,
        requireChannelSubscription: next.length > 0 ? settings.requireChannelSubscription : false
      });
    }
    await renderMenu(ctx, await buildRequiredChannelsListMenu(chat.id, locale), await requiredChannelsListKeyboard(chat.id, locale), "HTML");
    return;
  }

  if (key === "toggle:channel") {
    await saveSpeechCheckSettings(chat.id, { requireChannelSubscription: !settings.requireChannelSubscription });
    await renderSpeechCheckMenu(ctx, locale, chat);
    return;
  }

  if (key === "names") {
    await renderMenu(ctx, await buildForbiddenNamesListMenu(chat.id, locale), await forbiddenNamesListKeyboard(chat.id, locale), "HTML");
    return;
  }

  if (key === "names:list") {
    await renderMenu(ctx, await buildForbiddenNamesListMenu(chat.id, locale), await forbiddenNamesListKeyboard(chat.id, locale), "HTML");
    return;
  }

  if (key === "names:add") {
    await renderMenu(ctx, buildForbiddenNameInputPrompt(locale), cancelKeyboard(locale), "HTML");
    inputDrafts.set(ctx.from.id, { chatId: chat.id, field: "forbidden_names" });
    return;
  }

  if (key.startsWith("names:noop:")) {
    return;
  }

  if (key.startsWith("names:delete:")) {
    const index = Number(key.replace("names:delete:", ""));
    if (Number.isInteger(index) && index >= 0) {
      const next = settings.forbiddenNameKeywords.filter((_, itemIndex) => itemIndex !== index);
      await saveSpeechCheckSettings(chat.id, { forbiddenNameKeywords: next });
    }
    await renderMenu(ctx, await buildForbiddenNamesListMenu(chat.id, locale), await forbiddenNamesListKeyboard(chat.id, locale), "HTML");
    return;
  }

  if (key === "punishment") {
    await renderMenu(ctx, buildPunishmentMenu(locale, settings), punishmentKeyboard(locale, settings), "HTML");
    return;
  }

  if (key.startsWith("punishment:set:")) {
    const punishment = key.replace("punishment:set:", "");
    if (isSpeechCheckPunishment(punishment)) {
      await saveSpeechCheckSettings(chat.id, { punishment });
    }
    await renderMenu(ctx, buildPunishmentMenu(locale, await getSpeechCheckSettings(chat.id)), punishmentKeyboard(locale, await getSpeechCheckSettings(chat.id)), "HTML");
    return;
  }

  if (key === "punishment:duration") {
    await renderMenu(ctx, buildPunishmentDurationPrompt(locale, settings), punishmentDurationKeyboard(locale, settings), "HTML");
    inputDrafts.set(ctx.from.id, { chatId: chat.id, field: "punishment_minutes" });
    return;
  }

  if (key === "punishment:permanent") {
    await saveSpeechCheckSettings(chat.id, { punishment: "mute", permanentMute: true });
    await renderMenu(ctx, buildPunishmentMenu(locale, await getSpeechCheckSettings(chat.id)), punishmentKeyboard(locale, await getSpeechCheckSettings(chat.id)), "HTML");
    return;
  }

  if (key === "notice_delete") {
    await renderMenu(ctx, buildNoticeDeleteMenu(locale), noticeDeleteKeyboard(locale, settings), "HTML");
    return;
  }

  if (key.startsWith("notice:set:")) {
    const seconds = Number(key.replace("notice:set:", ""));
    if (noticeDeleteOptions.includes(seconds as (typeof noticeDeleteOptions)[number])) {
      await saveSpeechCheckSettings(chat.id, { noticeDeleteSeconds: seconds });
    }
    await renderMenu(ctx, buildNoticeDeleteMenu(locale), noticeDeleteKeyboard(locale, await getSpeechCheckSettings(chat.id)), "HTML");
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

  const settings = await getSpeechCheckSettings(chat.id);
  const patch = await parseSpeechCheckInput(ctx, chat.id, draft.field, text, settings, locale);
  if (!patch.ok) {
    await ctx.reply(patch.message, { parse_mode: "HTML" });
    return true;
  }

  const next = await saveSpeechCheckSettings(chat.id, patch.value);

  if (draft.field === "forbidden_names") {
    inputDrafts.set(ctx.from.id, draft);
    await ctx.reply(
      locale === "zh-CN"
        ? "✅ 成功，输入内容可以继续添加下一条，或点击按钮返回"
        : "✅ Saved. You can add another one or tap the button to return.",
      { parse_mode: "HTML", reply_markup: forbiddenNamesDoneKeyboard(locale) }
    );
    return true;
  }

  if (draft.field === "required_channel") {
    inputDrafts.delete(ctx.from.id);
    await ctx.reply(
      locale === "zh-CN"
        ? "✅ 设置成功，点击按钮返回。"
        : "✅ Saved. Tap the button to return.",
      { parse_mode: "HTML", reply_markup: requiredChannelsDoneKeyboard(locale) }
    );
    return true;
  }

  inputDrafts.delete(ctx.from.id);
  await ctx.reply(buildSpeechCheckMessage(locale, next), {
    parse_mode: "HTML",
    reply_markup: speechCheckKeyboard(locale, chat, next)
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
  const requiredChannels = normalizeRequiredChannels(value.requiredChannels);
  const legacyRequiredChannel = typeof value.requiredChannel === "string" ? normalizeRequiredChannel(value.requiredChannel) : "";
  return {
    requireLastName: typeof value.requireLastName === "boolean" ? value.requireLastName : false,
    requireUsername: typeof value.requireUsername === "boolean" ? value.requireUsername : false,
    requireAvatar: typeof value.requireAvatar === "boolean" ? value.requireAvatar : false,
    requireChannelSubscription: typeof value.requireChannelSubscription === "boolean" ? value.requireChannelSubscription : false,
    requiredChannels: requiredChannels.length ? requiredChannels : (legacyRequiredChannel ? [legacyRequiredChannel] : []),
    forbiddenNameKeywords: normalizeForbiddenNameKeywords(value.forbiddenNameKeywords),
    punishment: isSpeechCheckPunishment(value.punishment) ? value.punishment : "mute",
    punishmentMinutes: normalizePunishmentMinutes(value.punishmentMinutes),
    permanentMute: typeof value.permanentMute === "boolean" ? value.permanentMute : false,
    noticeDeleteSeconds: normalizeNoticeDeleteSeconds(value.noticeDeleteSeconds)
  };
}

function defaultSpeechCheckSettings(): SpeechCheckSettings {
  return {
    requireLastName: false,
    requireUsername: false,
    requireAvatar: false,
    requireChannelSubscription: false,
    requiredChannels: [],
    forbiddenNameKeywords: [],
    punishment: "mute",
    punishmentMinutes: defaultPunishmentMinutes,
    permanentMute: false,
    noticeDeleteSeconds: defaultNoticeDeleteSeconds
  };
}

function speechCheckSettingsToJson(settings: SpeechCheckSettings): Prisma.InputJsonObject {
  return {
    requireLastName: settings.requireLastName,
    requireUsername: settings.requireUsername,
    requireAvatar: settings.requireAvatar,
    requireChannelSubscription: settings.requireChannelSubscription,
    requiredChannels: settings.requiredChannels,
    forbiddenNameKeywords: settings.forbiddenNameKeywords,
    punishment: settings.punishment,
    punishmentMinutes: settings.punishmentMinutes,
    permanentMute: settings.permanentMute,
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
      `<b>Punishment:</b> ${formatPunishment(locale, settings)}`,
      `<b>Delete notice:</b> ${formatNoticeDelete(locale, settings.noticeDeleteSeconds)}`,
      settings.requiredChannels.length ? `<b>Required channels:</b> ${settings.requiredChannels.map((item) => `<code>${escapeHtml(item)}</code>`).join(", ")}` : "",
      settings.forbiddenNameKeywords.length ? `<b>Name forbidden contains:</b> ${settings.forbiddenNameKeywords.map(escapeHtml).join(", ")}` : ""
    ].filter(Boolean).join("\n");
  }

  return [
    "🔦 <b>发言检查</b>",
    "",
    "在用户发送消息时进行检查和屏蔽。",
    "",
    `<b>惩罚:</b> ${formatPunishment(locale, settings)}`,
    `<b>删除提醒:</b> ${formatNoticeDelete(locale, settings.noticeDeleteSeconds)}`,
    settings.requiredChannels.length ? `<b>订阅频道/群组:</b> ${settings.requiredChannels.map((item) => `<code>${escapeHtml(item)}</code>`).join("、")}` : "",
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
    .text(locale === "zh-CN" ? "🈲昵称禁止包含" : "🈲Name forbidden contains", "speech_check:names")
    .row()
    .text(locale === "zh-CN" ? "🚷惩罚" : "🚷Punishment", "speech_check:punishment")
    .text(locale === "zh-CN" ? "♻️删除提醒" : "♻️Delete notice", "speech_check:notice_delete")
    .row()
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `menu:chat:${scope}:${chat.id}`);
}

function buildRequiredChannelPrompt(locale: Locale) {
  if (locale !== "zh-CN") {
    return [
      "📢 <b>Speech Check</b>",
      "",
      "Require ordinary group members to join public channels/groups before speaking.",
      "",
      "⚠️ <i>Currently only public channels/groups are supported. Make sure the bot is added to the target chat and has admin permissions.</i>",
      "",
      "<b>Quota:</b>",
      "• <b>Normal users:</b> up to <b>1</b> channel/group",
      "• <b>Members:</b> up to <b>3</b> channels/groups",
      "",
      "👉 <b>Send a public channel or group address:</b>",
      "",
      "<b>Examples:</b>",
      "• <code>https://t.me/example</code>",
      "• <code>t.me/example</code>",
      "• <code>@example_channel</code>",
      "",
      "<i>Private invite links like <code>t.me/+xxxx</code> are not supported.</i>"
    ].join("\n");
  }

  return [
    "📢 <b>发言检查</b>",
    "",
    "用户发言的时候，强制要求普通群成员必须先加入指定的频道或群组。",
    "",
    "⚠️ <i>提示：当前仅支持<b>公开</b>频道/群组，且请确保机器人已被添加至目标频道/群组中并赋予管理权限。</i>",
    "",
    "<b>👥 检测额度：</b>",
    "• <b>普通用户：</b> 最多支持检测 <b>1 个</b> 频道/群组",
    "• <b>会员用户：</b> 最多支持检测 <b>3 个</b> 频道/群组",
    "",
    "👉 <b>请输入公开频道或群组地址：</b>",
    "",
    "<b>💡 格式示例：</b>",
    "• <code>https://t.me/example</code>",
    "• <code>t.me/example</code>",
    "• <code>@example_channel</code>",
    "",
    "<i>不支持 <code>t.me/+xxxx</code> 这类私密邀请链接。</i>"
  ].join("\n");
}

async function buildRequiredChannelsListMenu(chatId: string, locale: Locale) {
  const settings = await getSpeechCheckSettings(chatId);
  const lines = settings.requiredChannels.length
    ? settings.requiredChannels.map((channel, index) => `${index + 1}. <code>${escapeHtml(channel)}</code>`)
    : [locale === "zh-CN" ? "暂无订阅频道/群组。" : "No required channels/groups yet."];

  return locale === "zh-CN"
    ? [
        "📢 <b>发言检查</b>",
        "",
        "用户发言的时候，强制要求普通群成员必须先加入指定的频道或群组。",
        "",
        `已添加频道/群组: ${settings.requiredChannels.length} 个`,
        "",
        ...lines
      ].join("\n")
    : [
        "📢 <b>Speech Check</b>",
        "",
        "Require ordinary group members to join configured channels/groups before speaking.",
        "",
        `Added channels/groups: ${settings.requiredChannels.length}`,
        "",
        ...lines
      ].join("\n");
}

async function requiredChannelsListKeyboard(chatId: string, locale: Locale) {
  const settings = await getSpeechCheckSettings(chatId);
  const keyboard = new InlineKeyboard();
  settings.requiredChannels.forEach((_, index) => {
    keyboard
      .text(`${index + 1}.`, `speech_check:channel:noop:${index}`)
      .text(locale === "zh-CN" ? "删除🗑️" : "Delete🗑️", `speech_check:channel:delete:${index}`)
      .row();
  });
  keyboard
    .text(locale === "zh-CN" ? "➕添加" : "➕Add", "speech_check:channel:add")
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", "speech_check:back");
  return keyboard;
}

function requiredChannelsDoneKeyboard(locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", "speech_check:channel");
}

function buildForbiddenNamesMenu(locale: Locale, settings: SpeechCheckSettings) {
  if (locale !== "zh-CN") {
    return [
      "🔦 <b>Speech Check</b>",
      "",
      "⛔ Names containing these keywords will be punished.",
      "",
      `Added forbidden names: ${settings.forbiddenNameKeywords.length}`
    ].join("\n");
  }

  return [
    "🔦 <b>发言检查</b>",
    "",
    "⛔️ 昵称中包含关键词将惩罚",
    "",
    `已添加禁止名单: ${settings.forbiddenNameKeywords.length} 条`
  ].join("\n");
}

async function buildForbiddenNamesListMenu(chatId: string, locale: Locale) {
  const settings = await getSpeechCheckSettings(chatId);
  const lines = settings.forbiddenNameKeywords.length
    ? settings.forbiddenNameKeywords.map((keyword, index) => `${index + 1}. <code>${escapeHtml(keyword)}</code>`)
    : [locale === "zh-CN" ? "暂无禁止名单。" : "No forbidden names yet."];

  return locale === "zh-CN"
    ? [
        "🔦 <b>发言检查</b>",
        "",
        "⛔️ 昵称中包含关键词将惩罚",
        "",
        `已添加禁止名单: ${settings.forbiddenNameKeywords.length} 条`,
        "",
        ...lines
      ].join("\n")
    : [
        "🔦 <b>Speech Check</b>",
        "",
        "Names containing these keywords will be punished.",
        "",
        `Added forbidden names: ${settings.forbiddenNameKeywords.length}`,
        "",
        ...lines
      ].join("\n");
}

function forbiddenNamesKeyboard(locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "➕添加" : "➕Add", "speech_check:names:list")
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", "speech_check:back");
}

async function forbiddenNamesListKeyboard(chatId: string, locale: Locale) {
  const settings = await getSpeechCheckSettings(chatId);
  const keyboard = new InlineKeyboard();
  settings.forbiddenNameKeywords.forEach((_, index) => {
    keyboard
      .text(String(index + 1), `speech_check:names:noop:${index}`)
      .text(locale === "zh-CN" ? "删除🗑️" : "Delete🗑️", `speech_check:names:delete:${index}`)
      .row();
  });
  keyboard
    .text(locale === "zh-CN" ? "➕添加" : "➕Add", "speech_check:names:add")
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", "speech_check:back");
  return keyboard;
}

function buildForbiddenNameInputPrompt(locale: Locale) {
  return locale === "zh-CN"
    ? ["🔦 <b>发言检查</b>", "", "👉 输入你想要禁止的名字:"].join("\n")
    : ["🔦 <b>Speech Check</b>", "", "👉 Send the name keyword to block:"].join("\n");
}

function forbiddenNamesDoneKeyboard(locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", "speech_check:back");
}

function buildPunishmentMenu(locale: Locale, settings: SpeechCheckSettings) {
  return locale === "zh-CN"
    ? ["<b>🔦 发言检查</b>", "", `<b>惩罚：</b>${formatPunishment(locale, settings)}`].join("\n")
    : ["<b>🔦 Speech Check</b>", "", `<b>Punishment:</b> ${formatPunishment(locale, settings)}`].join("\n");
}

function punishmentKeyboard(locale: Locale, settings: SpeechCheckSettings) {
  const selected = (value: SpeechCheckPunishment, label: string) => settings.punishment === value ? `✅${label}` : label;
  return new InlineKeyboard()
    .text(selected("warn", locale === "zh-CN" ? "警告" : "Warn"), "speech_check:punishment:set:warn")
    .text(selected("mute", locale === "zh-CN" ? "禁言" : "Mute"), "speech_check:punishment:set:mute")
    .text(selected("kick", locale === "zh-CN" ? "踢出" : "Kick"), "speech_check:punishment:set:kick")
    .row()
    .text(selected("ban", locale === "zh-CN" ? "封禁" : "Ban"), "speech_check:punishment:set:ban")
    .text(selected("delete_only", locale === "zh-CN" ? "仅删除" : "Delete only"), "speech_check:punishment:set:delete_only")
    .row()
    .text(locale === "zh-CN" ? "🔇🕙设置禁言时长" : "🔇🕙Set mute duration", "speech_check:punishment:duration")
    .row()
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", "speech_check:back");
}

function buildPunishmentDurationPrompt(locale: Locale, settings: SpeechCheckSettings) {
  return locale === "zh-CN"
    ? [
        "<b>🔦 发言检查</b>",
        "",
        `当前设置: ${settings.permanentMute ? "永久禁言" : `禁言${formatDuration(locale, settings.punishmentMinutes)}`}`,
        "",
        "👉 输入处罚禁言时长，只需发送分钟数，例如 <b>60</b>。也支持 <code>60分钟</code>:"
      ].join("\n")
    : [
        "<b>🔦 Speech Check</b>",
        "",
        `Current: ${settings.permanentMute ? "permanent mute" : `mute ${formatDuration(locale, settings.punishmentMinutes)}`}`,
        "",
        "👉 Send mute duration in minutes, for example <b>60</b>:"
      ].join("\n");
}

function punishmentDurationKeyboard(locale: Locale, settings: SpeechCheckSettings) {
  return new InlineKeyboard()
    .text(settings.permanentMute ? (locale === "zh-CN" ? "✅永久禁言" : "✅Permanent mute") : (locale === "zh-CN" ? "⛔永久禁言" : "⛔Permanent mute"), "speech_check:punishment:permanent")
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", "speech_check:punishment");
}

function buildNoticeDeleteMenu(locale: Locale) {
  return locale === "zh-CN"
    ? [
        "<b>🔦 发言检查</b>",
        "",
        "群成员触发🔦检查时，机器人发出的提醒消息在多少时间后自动删除"
      ].join("\n")
    : [
        "<b>🔦 Speech Check</b>",
        "",
        "Choose when bot notice messages should be deleted after a member triggers speech check."
      ].join("\n");
}

function noticeDeleteKeyboard(locale: Locale, settings: SpeechCheckSettings) {
  const label = (seconds: number, text: string) => settings.noticeDeleteSeconds === seconds ? `✅${text}` : text;
  return new InlineKeyboard()
    .text(label(10, locale === "zh-CN" ? "10秒" : "10s"), "speech_check:notice:set:10")
    .text(label(30, locale === "zh-CN" ? "30秒" : "30s"), "speech_check:notice:set:30")
    .text(label(60, locale === "zh-CN" ? "60秒" : "60s"), "speech_check:notice:set:60")
    .row()
    .text(label(300, locale === "zh-CN" ? "5分钟" : "5m"), "speech_check:notice:set:300")
    .text(label(600, locale === "zh-CN" ? "10分钟" : "10m"), "speech_check:notice:set:600")
    .text(label(1800, locale === "zh-CN" ? "30分钟" : "30m"), "speech_check:notice:set:1800")
    .row()
    .text(label(3600, locale === "zh-CN" ? "1小时" : "1h"), "speech_check:notice:set:3600")
    .text(label(21600, locale === "zh-CN" ? "6小时" : "6h"), "speech_check:notice:set:21600")
    .text(label(43200, locale === "zh-CN" ? "12小时" : "12h"), "speech_check:notice:set:43200")
    .row()
    .text(label(0, locale === "zh-CN" ? "不删除" : "Do not delete"), "speech_check:notice:set:0")
    .row()
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", "speech_check:back");
}

async function parseSpeechCheckInput(
  ctx: Context,
  chatId: string,
  field: SpeechCheckInputField,
  text: string,
  settings: SpeechCheckSettings,
  locale: Locale
): Promise<{ ok: true; value: Partial<SpeechCheckSettings> } | { ok: false; message: string }> {
  if (field === "required_channel") {
    if (/^https?:\/\/t\.me\/\+|^t\.me\/\+/i.test(text.trim())) {
      return {
        ok: false,
        message: locale === "zh-CN"
          ? "这是私密邀请链接，当前仅支持公开频道/群组地址，请发送 <code>https://t.me/example</code>、<code>t.me/example</code> 或 <code>@example</code>。"
          : "This is a private invite link. Only public channel/group addresses are supported: <code>https://t.me/example</code>, <code>t.me/example</code>, or <code>@example</code>."
      };
    }

    const channel = normalizeRequiredChannel(text);
    if (!channel) {
      return { ok: false, message: locale === "zh-CN" ? "频道/群组格式不正确，请发送 <code>https://t.me/example</code>、<code>t.me/example</code> 或 <code>@example</code>。" : "Invalid channel/group. Send https://t.me/example, t.me/example, or @example." };
    }

    const limit = await requiredChannelLimit(ctx.from?.id);
    const nextChannels = [...settings.requiredChannels.filter((item) => item !== channel), channel];
    if (nextChannels.length > limit) {
      return { ok: false, message: locale === "zh-CN" ? `当前账号最多支持检测 ${limit} 个频道/群组。` : `This account can check up to ${limit} channel/group(s).` };
    }

    const botCanRead = await canBotReadRequiredChannel(ctx, channel);
    if (!botCanRead) {
      return { ok: false, message: locale === "zh-CN" ? "无法读取该频道/群组成员状态。请确认它是公开频道/群组，且机器人已加入并拥有管理权限。" : "Could not read membership for that channel/group. Make sure it is public and the bot is added as an admin." };
    }

    return { ok: true, value: { requiredChannels: nextChannels, requireChannelSubscription: true } };
  }

  if (field === "forbidden_names") {
    if (text.toLowerCase() === "clear") return { ok: true, value: { forbiddenNameKeywords: [] } };
    const keywords = normalizeForbiddenNameKeywords(text.split(/[\s,，、;；|]+/));
    if (!keywords.length) {
      return { ok: false, message: locale === "zh-CN" ? "请至少发送一个关键词，或发送 clear 清空。" : "Send at least one keyword, or send clear." };
    }
    return { ok: true, value: { forbiddenNameKeywords: [...new Set([...settings.forbiddenNameKeywords, ...keywords])].slice(0, 50) } };
  }

  const minutes = parseDurationMinutes(text);
  if (!minutes) {
    return { ok: false, message: locale === "zh-CN" ? "时长格式不正确，请发送分钟数，例如 60。" : "Invalid duration. Send minutes, for example 60." };
  }
  return { ok: true, value: { punishment: "mute", punishmentMinutes: minutes, permanentMute: false } };
}

async function requiredChannelLimit(telegramUserId: number | undefined) {
  if (!telegramUserId) return 1;
  const user = await prisma.user.findUnique({ where: { telegramUserId: BigInt(telegramUserId) } });
  if (!user) return 1;
  const activeMembership = await prisma.membership.findFirst({
    where: {
      userId: user.id,
      status: MembershipStatus.ACTIVE,
      expiresAt: { gt: new Date() }
    },
    select: { id: true }
  });
  return activeMembership ? 3 : 1;
}

async function canBotReadRequiredChannel(ctx: Context, channel: string) {
  const me = await ctx.api.getMe().catch(() => null);
  if (!me) return false;
  const member = await ctx.api.getChatMember(channel, me.id).catch(() => null);
  return Boolean(member && (member.status === "creator" || member.status === "administrator" || member.status === "member"));
}

async function findSpeechCheckFailures(ctx: Context, user: User, settings: SpeechCheckSettings) {
  const reasons: string[] = [];
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ");
  const nameTarget = `${fullName} ${user.username ?? ""}`.toLowerCase();

  if (settings.requireLastName && !user.last_name?.trim()) reasons.push("last_name");
  if (settings.requireUsername && !user.username?.trim()) reasons.push("username");
  if (settings.requireAvatar && !(await userHasAvatar(ctx, user.id))) reasons.push("avatar");
  if (settings.requireChannelSubscription && settings.requiredChannels.length && !(await userSubscribedToAllRequiredChannels(ctx, settings.requiredChannels, user.id))) {
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

async function userSubscribedToAllRequiredChannels(ctx: Context, channels: string[], userId: number) {
  for (const channel of channels) {
    if (!(await userSubscribedToRequiredChannel(ctx, channel, userId))) return false;
  }
  return true;
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
  if (settings.punishment === "warn" || settings.punishment === "delete_only") return;
  if (settings.punishment === "kick") {
    await ctx.api.banChatMember(chatId, userId).catch(() => undefined);
    await ctx.api.unbanChatMember(chatId, userId, { only_if_banned: true }).catch(() => undefined);
    return;
  }
  if (settings.punishment === "ban") {
    await ctx.api.banChatMember(chatId, userId).catch(() => undefined);
    return;
  }

  const untilDate = settings.permanentMute
    ? Math.floor((Date.now() + 367 * 24 * 60 * 60 * 1000) / 1000)
    : Math.floor((Date.now() + settings.punishmentMinutes * 60_000) / 1000);
  await ctx.api.restrictChatMember(chatId, userId, mutedChatPermissions(), { until_date: untilDate }).catch(() => undefined);
}

function buildViolationNotice(user: User, reasons: string[], settings: SpeechCheckSettings, locale: Locale) {
  const name = escapeHtml([user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || String(user.id));
  const labels = reasons.map((reason) => violationReasonLabel(reason, locale));
  if (locale !== "zh-CN") {
    return [
      `<b>${name}</b> message blocked.`,
      `Reason: ${labels.join(", ")}`,
      `Punishment: ${formatPunishment(locale, settings)}`
    ].join("\n");
  }

  return [
    `<b>${name}</b> 的发言已被屏蔽。`,
    `原因：${labels.join("、")}`,
    `惩罚：${formatPunishment(locale, settings)}`
  ].join("\n");
}

function violationReasonLabel(reason: string, locale: Locale) {
  const zh: Record<string, string> = {
    last_name: "未设置姓氏",
    username: "未设置用户名",
    avatar: "未设置头像",
    channel: "未订阅指定频道/群组",
    forbidden_name: "昵称包含禁用词"
  };
  const en: Record<string, string> = {
    last_name: "missing last name",
    username: "missing username",
    avatar: "missing avatar",
    channel: "not subscribed to required channel/group",
    forbidden_name: "name contains forbidden keyword"
  };
  return locale === "zh-CN" ? zh[reason] ?? reason : en[reason] ?? reason;
}

function hasEnabledSpeechCheckRule(settings: SpeechCheckSettings) {
  return settings.requireLastName
    || settings.requireUsername
    || settings.requireAvatar
    || (settings.requireChannelSubscription && settings.requiredChannels.length > 0)
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

function normalizeRequiredChannels(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map(normalizeRequiredChannel)
    .filter(Boolean))]
    .slice(0, 3);
}

function normalizeRequiredChannel(text: string) {
  const value = text.trim();
  const username = value
    .replace(/^https?:\/\/t\.me\//i, "@")
    .replace(/^t\.me\//i, "@")
    .replace(/^telegram\.me\//i, "@");
  if (/^@[A-Za-z0-9_]{5,32}$/.test(username)) return username;
  return "";
}

function parseDurationMinutes(input: string) {
  const text = input.trim().toLowerCase().replace(/\s+/g, "");
  const match = text.match(/^(\d+)(分钟|分|单位\/?分钟|min|m|)?$/i);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  return normalizePunishmentMinutes(amount);
}

function normalizePunishmentMinutes(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultPunishmentMinutes;
  const minutes = Math.round(value);
  return Math.min(maxPunishmentMinutes, Math.max(minPunishmentMinutes, minutes));
}

function normalizeNoticeDeleteSeconds(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultNoticeDeleteSeconds;
  const seconds = Math.round(value);
  return noticeDeleteOptions.includes(seconds as (typeof noticeDeleteOptions)[number])
    ? seconds
    : defaultNoticeDeleteSeconds;
}

function formatPunishment(locale: Locale, settings: SpeechCheckSettings) {
  if (locale === "zh-CN") {
    if (settings.punishment === "warn") return "警告";
    if (settings.punishment === "kick") return "踢出";
    if (settings.punishment === "ban") return "封禁";
    if (settings.punishment === "delete_only") return "仅删除";
    return settings.permanentMute ? "永久禁言" : `禁言${formatDuration(locale, settings.punishmentMinutes)}`;
  }

  if (settings.punishment === "warn") return "Warn";
  if (settings.punishment === "kick") return "Kick";
  if (settings.punishment === "ban") return "Ban";
  if (settings.punishment === "delete_only") return "Delete only";
  return settings.permanentMute ? "Permanent mute" : `Mute ${formatDuration(locale, settings.punishmentMinutes)}`;
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

function formatNoticeDelete(locale: Locale, seconds: number) {
  if (seconds === 0) return locale === "zh-CN" ? "不删除" : "Do not delete";
  if (seconds < 60) return locale === "zh-CN" ? `${seconds} 秒` : `${seconds}s`;
  return formatDuration(locale, seconds / 60);
}

function isSpeechCheckPunishment(value: unknown): value is SpeechCheckPunishment {
  return value === "warn" || value === "mute" || value === "kick" || value === "ban" || value === "delete_only";
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
  return new InlineKeyboard().text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", "speech_check:back");
}

function cancelKeyboard(locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "❌取消" : "❌ Cancel", "speech_check:cancel");
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
