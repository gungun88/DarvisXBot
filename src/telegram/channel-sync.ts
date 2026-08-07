import { InlineKeyboard, type Context } from "grammy";
import { ChatStatus, Prisma, type Chat as PrismaChat } from "@prisma/client";
import type { Message } from "grammy/types";
import { listManagedChats } from "../chats/chat.service.js";
import { prisma } from "../lib/prisma.js";
import { canConfigureChat } from "./permissions.js";

type Locale = "zh-CN" | "en";
type TargetScope = "channel" | "group";
type ChannelSyncInputMode = "button" | "replacement" | "blocked";

type ChannelSyncReplacement = {
  from: string;
  to: string;
};

export type ChannelSyncButton = {
  text: string;
  url: string;
};

type ChannelSyncSettings = {
  enabled: boolean;
  preserveSource: boolean;
  pinMessages: boolean;
  buttonText: string;
  buttonUrl: string;
  buttons: ChannelSyncButton[][];
  replacements: ChannelSyncReplacement[];
  blockedWords: string[];
  targetChatIds: string[];
};

type ChannelSyncInputDraft = {
  sourceChatId: string;
  mode: ChannelSyncInputMode;
};

const settingKey = "channel_sync";
const drafts = new Map<number, ChannelSyncInputDraft>();
const defaultSettings: ChannelSyncSettings = {
  enabled: false,
  preserveSource: false,
  pinMessages: false,
  buttonText: "",
  buttonUrl: "",
  buttons: [],
  replacements: [],
  blockedWords: [],
  targetChatIds: []
};

export function clearChannelSyncDraft(userId: number) {
  drafts.delete(userId);
}

export async function openChannelSyncMenu(
  ctx: Context,
  botUsername: string,
  locale: Locale,
  sourceChat: PrismaChat
) {
  if (sourceChat.type !== "CHANNEL") {
    await renderMenu(ctx, locale === "zh-CN" ? "频道同步仅支持频道作为来源。" : "Channel sync requires a channel as the source.", channelSyncBackKeyboard(sourceChat.id, locale));
    return;
  }

  if (ctx.from) drafts.delete(ctx.from.id);
  await renderHome(ctx, botUsername, locale, sourceChat);
}

export async function openChannelSyncButtonMenu(
  ctx: Context,
  botUsername: string,
  locale: Locale,
  sourceChat: PrismaChat
) {
  if (sourceChat.type !== "CHANNEL") {
    await renderMenu(ctx, "Channel buttons require a channel as the source.", channelSyncBackKeyboard(sourceChat.id, locale));
    return;
  }
  const settings = await getSettings(sourceChat.id);
  await renderButtonPanel(ctx, locale, sourceChat, settings);
}

export async function handleChannelSyncCallback(
  ctx: Context,
  botUsername: string,
  locale: Locale
) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const parts = ctx.callbackQuery?.data?.split(":") ?? [];
  const action = parts[1];
  const sourceChatId = parts[2];
  if (!action || !sourceChatId) return;

  const sourceChat = await getSourceChat(ctx, sourceChatId, locale);
  if (!sourceChat) return;
  if (!(await ensureCanConfigure(ctx, sourceChat, locale))) return;

  if (action === "home") {
    clearDraft(ctx);
    await renderHome(ctx, botUsername, locale, sourceChat);
    return;
  }

  const settings = await getSettings(sourceChat.id);

  if (action === "status" || action === "preserve" || action === "pin") {
    const value = parts[3];
    if (value !== "on" && value !== "off") return;
    if (action === "status") settings.enabled = value === "on";
    if (action === "preserve") settings.preserveSource = value === "on";
    if (action === "pin") settings.pinMessages = value === "on";
    await saveSettings(sourceChat.id, settings);
    await renderHome(ctx, botUsername, locale, sourceChat);
    return;
  }

  if (action === "buttons") {
    await renderChannelSyncButtonPanel(ctx, locale, sourceChat, settings);
    return;
  }

  if (action === "button_view") {
    await renderChannelSyncButtonView(ctx, locale, sourceChat, settings);
    return;
  }

  if (action === "button_edit") {
    setDraft(ctx, sourceChat.id, "button");
    await renderMenu(ctx, buttonPromptText(settings, locale), channelSyncInputKeyboard(sourceChat.id, locale));
    return;
  }

  if (action === "button_clear") {
    settings.buttonText = "";
    settings.buttonUrl = "";
    settings.buttons = [];
    await saveSettings(sourceChat.id, settings);
    await renderChannelSyncButtonPanel(ctx, locale, sourceChat, settings);
    return;
  }

  if (action === "replacements") {
    await renderReplacementPanel(ctx, locale, sourceChat, settings);
    return;
  }

  if (action === "replacement_add") {
    setDraft(ctx, sourceChat.id, "replacement");
    await renderMenu(ctx, replacementPromptText(locale), channelSyncInputKeyboard(sourceChat.id, locale));
    return;
  }

  if (action === "replacement_delete") {
    const index = parseIndex(parts[3]);
    if (index !== null) {
      settings.replacements.splice(index, 1);
      await saveSettings(sourceChat.id, settings);
    }
    await renderReplacementPanel(ctx, locale, sourceChat, settings);
    return;
  }

  if (action === "replacements_clear") {
    settings.replacements = [];
    await saveSettings(sourceChat.id, settings);
    await renderReplacementPanel(ctx, locale, sourceChat, settings);
    return;
  }

  if (action === "blocked") {
    await renderBlockedPanel(ctx, locale, sourceChat, settings);
    return;
  }

  if (action === "blocked_add") {
    setDraft(ctx, sourceChat.id, "blocked");
    await renderMenu(ctx, blockedPromptText(locale), channelSyncInputKeyboard(sourceChat.id, locale));
    return;
  }

  if (action === "blocked_delete") {
    const index = parseIndex(parts[3]);
    if (index !== null) {
      settings.blockedWords.splice(index, 1);
      await saveSettings(sourceChat.id, settings);
    }
    await renderBlockedPanel(ctx, locale, sourceChat, settings);
    return;
  }

  if (action === "blocked_clear") {
    settings.blockedWords = [];
    await saveSettings(sourceChat.id, settings);
    await renderBlockedPanel(ctx, locale, sourceChat, settings);
    return;
  }

  if (action === "targets") {
    const scope = parseTargetScope(parts[3]);
    if (!scope) return;
    await renderTargetPanel(ctx, locale, sourceChat, settings, scope, botUsername);
    return;
  }

  if (action === "target") {
    const scope = parseTargetScope(parts[3]);
    const targetChatId = parts[4];
    if (!scope || !targetChatId) return;

    const available = await getManagedChatsForUser(ctx);
    const target = available.find((chat) => chat.id === targetChatId);
    if (!target || target.id === sourceChat.id || !matchesTargetScope(target, scope)) {
      await renderMenu(ctx, locale === "zh-CN" ? "目标频道/群组不可用，请刷新后重试。" : "That target is unavailable. Refresh and try again.", channelSyncBackKeyboard(sourceChat.id, locale));
      return;
    }

    const selected = new Set(settings.targetChatIds);
    if (selected.has(target.id)) selected.delete(target.id);
    else selected.add(target.id);
    settings.targetChatIds = [...selected];
    await saveSettings(sourceChat.id, settings);
    await renderTargetPanel(ctx, locale, sourceChat, settings, scope, botUsername);
    return;
  }

  if (action === "cancel") {
    clearDraft(ctx);
    await renderHome(ctx, botUsername, locale, sourceChat);
  }
}

export async function handleChannelSyncInputMessage(ctx: Context, botUsername: string, locale: Locale) {
  if (!ctx.from) return false;
  const draft = drafts.get(ctx.from.id);
  if (!draft) return false;

  const sourceChat = await prisma.chat.findUnique({ where: { id: draft.sourceChatId } });
  if (!sourceChat || !(await ensureCanConfigure(ctx, sourceChat, locale))) {
    drafts.delete(ctx.from.id);
    return true;
  }

  const text = ctx.message && "text" in ctx.message ? ctx.message.text.trim() : "";
  if (!text) {
    await ctx.reply(inputTextOnlyText(locale), { parse_mode: "HTML", reply_markup: channelSyncInputKeyboard(sourceChat.id, locale) });
    return true;
  }

  const settings = await getSettings(sourceChat.id);
  if (draft.mode === "button") {
    const buttons = parseChannelSyncButtons(text);
    if (!buttons) {
      await ctx.reply(buttonPromptText(settings, locale), { parse_mode: "HTML", reply_markup: channelSyncInputKeyboard(sourceChat.id, locale) });
      return true;
    }
    settings.buttons = buttons;
    settings.buttonText = buttons[0]?.[0]?.text ?? "";
    settings.buttonUrl = buttons[0]?.[0]?.url ?? "";
    await saveSettings(sourceChat.id, settings);
    drafts.delete(ctx.from.id);
    await ctx.reply(buttonSavedText(locale), { parse_mode: "HTML", reply_markup: channelSyncHomeKeyboard(sourceChat.id, locale, botUsername, settings) });
    return true;
  }

  if (draft.mode === "replacement") {
    const parsed = parseReplacementInput(text);
    if (!parsed.length) {
      await ctx.reply(replacementPromptText(locale), { parse_mode: "HTML", reply_markup: channelSyncInputKeyboard(sourceChat.id, locale) });
      return true;
    }
    const replacements = [...settings.replacements];
    for (const item of parsed) {
      const existing = replacements.find((replacement) => replacement.from.toLocaleLowerCase() === item.from.toLocaleLowerCase());
      if (existing) existing.to = item.to;
      else replacements.push(item);
    }
    settings.replacements = replacements.slice(-100);
    await saveSettings(sourceChat.id, settings);
    drafts.delete(ctx.from.id);
    await ctx.reply(replacementSavedText(parsed.length, locale), { parse_mode: "HTML", reply_markup: channelSyncHomeKeyboard(sourceChat.id, locale, botUsername, settings) });
    return true;
  }

  const words = parseBlockedWordsInput(text);
  if (!words.length) {
    await ctx.reply(blockedPromptText(locale), { parse_mode: "HTML", reply_markup: channelSyncInputKeyboard(sourceChat.id, locale) });
    return true;
  }
  settings.blockedWords = [...new Set([...settings.blockedWords, ...words])].slice(-100);
  await saveSettings(sourceChat.id, settings);
  drafts.delete(ctx.from.id);
  await ctx.reply(blockedSavedText(words.length, locale), { parse_mode: "HTML", reply_markup: channelSyncHomeKeyboard(sourceChat.id, locale, botUsername, settings) });
  return true;
}

export async function handleChannelSyncChannelPost(ctx: Context) {
  const message = ctx.channelPost;
  if (!message || !ctx.chat || ctx.chat.type !== "channel") return;

  const sourceChat = await prisma.chat.findFirst({
    where: {
      telegramChatId: BigInt(ctx.chat.id),
      type: "CHANNEL",
      status: ChatStatus.ACTIVE
    }
  });
  if (!sourceChat) return;

  const settings = await getSettings(sourceChat.id);
  if (!settings.enabled || !settings.targetChatIds.length) return;
  if (getMessageRecord(message).media_group_id) return;

  const body = getMessageBody(message);
  if (containsBlockedWord(body, settings.blockedWords)) return;

  const targets = await prisma.chat.findMany({
    where: {
      id: { in: settings.targetChatIds },
      status: ChatStatus.ACTIVE,
      type: { in: ["GROUP", "SUPERGROUP", "CHANNEL"] }
    }
  });
  const targetChatId = Number(sourceChat.telegramChatId);
  const hasButton = settings.buttons.length > 0;
  const transformedBody = settings.preserveSource ? body : applyReplacements(body, settings.replacements);
  const requiresManualSend = hasButton || (!settings.preserveSource && transformedBody !== body);

  await Promise.all(targets
    .filter((target) => target.id !== sourceChat.id)
    .map(async (target) => {
      try {
        const sent = requiresManualSend
          ? await sendTransformedMessage(ctx, target, message, transformedBody, settings)
          : settings.preserveSource
            ? await ctx.api.forwardMessage(Number(target.telegramChatId), targetChatId, message.message_id)
            : await ctx.api.copyMessage(Number(target.telegramChatId), targetChatId, message.message_id);
        const sentMessageId = getSentMessageId(sent);
        if (settings.pinMessages && sentMessageId !== null) {
          await ctx.api.pinChatMessage(Number(target.telegramChatId), sentMessageId, { disable_notification: true }).catch(() => undefined);
        }
      } catch (error) {
        console.warn("Failed to sync channel post", {
          sourceChatId: sourceChat.id,
          targetChatId: target.id,
          messageId: message.message_id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }));
}

async function sendTransformedMessage(
  ctx: Context,
  target: PrismaChat,
  message: Message,
  body: string,
  settings: ChannelSyncSettings
) {
  const chatId = Number(target.telegramChatId);
  const keyboard = channelSyncInlineKeyboard(settings.buttons);
  const record = getMessageRecord(message);

  if (typeof record.text === "string") {
    const textOptions: Record<string, unknown> = {};
    if (keyboard) textOptions.reply_markup = keyboard;
    return ctx.api.sendMessage(chatId, body || " ", textOptions as never);
  }

  const photoFileId = getMediaFileId(record.photo);
  const mediaOptions: Record<string, unknown> = {};
  if (body) mediaOptions.caption = body;
  if (keyboard) mediaOptions.reply_markup = keyboard;
  if (photoFileId) return ctx.api.sendPhoto(chatId, photoFileId, mediaOptions as never);
  if (typeof record.video === "object" && record.video) {
    return ctx.api.sendVideo(chatId, getMediaFileId(record.video)!, mediaOptions as never);
  }
  if (typeof record.animation === "object" && record.animation) {
    return ctx.api.sendAnimation(chatId, getMediaFileId(record.animation)!, mediaOptions as never);
  }
  if (typeof record.document === "object" && record.document) {
    return ctx.api.sendDocument(chatId, getMediaFileId(record.document)!, mediaOptions as never);
  }
  if (typeof record.audio === "object" && record.audio) {
    return ctx.api.sendAudio(chatId, getMediaFileId(record.audio)!, mediaOptions as never);
  }
  if (typeof record.voice === "object" && record.voice) {
    return ctx.api.sendVoice(chatId, getMediaFileId(record.voice)!, mediaOptions as never);
  }
  if (typeof record.sticker === "object" && record.sticker) {
    return ctx.api.sendSticker(chatId, getMediaFileId(record.sticker)!, keyboard ? { reply_markup: keyboard } : undefined);
  }

  return settings.preserveSource
    ? ctx.api.forwardMessage(chatId, Number(ctx.chat?.id), message.message_id)
    : ctx.api.copyMessage(chatId, Number(ctx.chat?.id), message.message_id);
}

async function renderHome(ctx: Context, botUsername: string, locale: Locale, sourceChat: PrismaChat) {
  const settings = await getSettings(sourceChat.id);
  const targets = await getSelectedTargets(settings);
  const title = escapeHtml(sourceChat.title ?? sourceChat.username ?? sourceChat.telegramChatId.toString());
  const targetText = targets.length
    ? targets.map((target) => `• ${escapeHtml(chatLabel(target))}`).join("\n")
    : locale === "zh-CN" ? "-" : "None";
  const text = locale === "zh-CN"
    ? [
        "🔊 <b>频道同步</b>",
        "",
        `设置 <b>${title}</b> 的消息同时发送到哪些频道/群组`,
        "",
        "⚠️ <b>Bot不支持转发多图片消息</b>",
        "⚠️ <b>关键词替换只支持不保留转发源头</b>",
        "",
        `<b>同步状态：</b>${settings.enabled ? "✅开启" : "❌关闭"}`,
        `<b>来源频道：</b>${title}`,
        `<b>目标频道/群组：</b>\n${targetText}`,
        `<b>链接按钮：</b>${settings.buttons.length ? "✅" : "❌"}`
      ].join("\n")
    : [
        "🔊 <b>Channel sync</b>",
        "",
        `Send messages from <b>${title}</b> to selected channels/groups`,
        "",
        "⚠️ <b>Multiple-photo albums are not supported</b>",
        "⚠️ <b>Keyword replacement requires source forwarding to be off</b>",
        "",
        `<b>Status:</b> ${settings.enabled ? "✅ On" : "❌ Off"}`,
        `<b>Source channel:</b> ${title}`,
        `<b>Targets:</b>\n${targetText}`,
        `<b>Link button:</b> ${settings.buttons.length ? "✅" : "❌"}`
      ].join("\n");
  await renderMenu(ctx, text, channelSyncHomeKeyboard(sourceChat.id, locale, botUsername, settings));
}

function channelSyncHomeKeyboard(
  sourceChatId: string,
  locale: Locale,
  botUsername: string,
  settings: ChannelSyncSettings
) {
  const labels = locale === "zh-CN"
    ? { status: "状态:", on: "开启", off: "关闭", preserve: "保留转发源", pin: "置顶：", yes: "是", no: "否", buttons: "🔠修改按钮", replacements: "📝关键词替换", blocked: "🚫添加屏蔽词", channels: "☑️选择目标频道", groups: "☑️选择目标群组", back: "🔙返回" }
    : { status: "Status:", on: "On", off: "Off", preserve: "Preserve source", pin: "Pin:", yes: "Yes", no: "No", buttons: "🔠 Edit button", replacements: "📝 Replacements", blocked: "🚫 Blocked words", channels: "☑️ Select channels", groups: "☑️ Select groups", back: "🔙 Back" };
  const selected = (active: boolean, label: string) => active ? `✅${label}` : label;
  return new InlineKeyboard()
    .text(labels.status, `channel_sync:noop:${sourceChatId}`)
    .text(selected(settings.enabled, labels.on), `channel_sync:status:${sourceChatId}:on`)
    .text(selected(!settings.enabled, labels.off), `channel_sync:status:${sourceChatId}:off`)
    .row()
    .text(labels.preserve, `channel_sync:noop:${sourceChatId}`)
    .text(selected(settings.preserveSource, labels.yes), `channel_sync:preserve:${sourceChatId}:on`)
    .text(selected(!settings.preserveSource, labels.no), `channel_sync:preserve:${sourceChatId}:off`)
    .row()
    .text(labels.pin, `channel_sync:noop:${sourceChatId}`)
    .text(selected(settings.pinMessages, labels.yes), `channel_sync:pin:${sourceChatId}:on`)
    .text(selected(!settings.pinMessages, labels.no), `channel_sync:pin:${sourceChatId}:off`)
    .row()
    .text(labels.buttons, `channel_sync:buttons:${sourceChatId}`)
    .text(labels.replacements, `channel_sync:replacements:${sourceChatId}`)
    .row()
    .text(labels.blocked, `channel_sync:blocked:${sourceChatId}`)
    .row()
    .text(labels.channels, `channel_sync:targets:${sourceChatId}:channel`)
    .text(labels.groups, `channel_sync:targets:${sourceChatId}:group`)
    .row()
    .url(locale === "zh-CN" ? "➕添加频道" : "➕ Add channel", `https://t.me/${botUsername}?startchannel`)
    .url(locale === "zh-CN" ? "➕添加群组" : "➕ Add group", `https://t.me/${botUsername}?startgroup`)
    .row()
    .text(labels.back, `menu:chat:channel:${sourceChatId}`);
}

function channelSyncBackKeyboard(sourceChatId: string, locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `menu:chat:channel:${sourceChatId}`);
}

function channelSyncInputKeyboard(sourceChatId: string, locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "取消" : "Cancel", `channel_sync:cancel:${sourceChatId}`);
}

async function renderChannelSyncButtonPanel(
  ctx: Context,
  locale: Locale,
  sourceChat: PrismaChat,
  settings: ChannelSyncSettings
) {
  const current = settings.buttons.length
    ? serializeChannelSyncButtons(settings.buttons)
    : locale === "zh-CN" ? "未设置" : "Not set";
  const text = locale === "zh-CN"
    ? ["🔠 <b>修改按钮</b>", "", `当前按钮：<code>${escapeHtml(current)}</code>`, "", buttonFormatHelp(locale)].join("\n")
    : ["🔠 <b>Edit buttons</b>", "", `Current buttons: <code>${escapeHtml(current)}</code>`, "", buttonFormatHelp(locale)].join("\n");
  const keyboard = new InlineKeyboard()
    .text(locale === "zh-CN" ? "修改" : "Edit", `channel_sync:button_edit:${sourceChat.id}`)
    .text(locale === "zh-CN" ? "清空" : "Clear", `channel_sync:button_clear:${sourceChat.id}`)
    .row()
    .text(locale === "zh-CN" ? "预览" : "View buttons", `channel_sync:button_view:${sourceChat.id}`)
    .row()
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `channel_sync:home:${sourceChat.id}`);
  await renderMenu(ctx, text, keyboard);
}

async function renderChannelSyncButtonView(
  ctx: Context,
  locale: Locale,
  sourceChat: PrismaChat,
  settings: ChannelSyncSettings
) {
  const lines = settings.buttons.length
    ? settings.buttons.map((row, index) => `${index + 1}. ${row.map((button) => `${button.text} - ${button.url}`).join(" && ")}`)
    : [locale === "zh-CN" ? "暂无按钮。" : "No buttons yet."];
  const text = locale === "zh-CN"
    ? ["🔠 <b>按钮预览</b>", "", ...lines.map(escapeHtml), "", "点击“修改”重新输入。"].join("\n")
    : ["🔠 <b>Button preview</b>", "", ...lines.map(escapeHtml), "", "Tap Edit to replace them."].join("\n");
  await renderMenu(ctx, text, new InlineKeyboard().text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `channel_sync:buttons:${sourceChat.id}`));
}

async function renderButtonPanel(ctx: Context, locale: Locale, sourceChat: PrismaChat, settings: ChannelSyncSettings) {
  const current = settings.buttons.length
    ? settings.buttons.map((row) => `<code>${row.map((button) => `${escapeHtml(button.text)} - ${escapeHtml(button.url)}`).join(" && ")}</code>`).join("\n")
    : locale === "zh-CN" ? "未设置" : "Not set";
  const text = locale === "zh-CN"
    ? ["🔠 <b>修改按钮</b>", "", `当前按钮：${current}`, "", "格式：按钮文字 - https://example.com", "同一行两个按钮用 && 分隔。"].join("\n")
    : ["🔠 <b>Edit button</b>", "", `Current button: ${current}`, "", "Format: Button text - https://example.com", "Use && for two buttons in one row."].join("\n");
  const keyboard = new InlineKeyboard()
    .text(locale === "zh-CN" ? "修改" : "Edit", `channel_sync:button_edit:${sourceChat.id}`)
    .text(locale === "zh-CN" ? "删除" : "Clear", `channel_sync:button_clear:${sourceChat.id}`)
    .row()
    .text(locale === "zh-CN" ? "查看按钮" : "View buttons", `channel_sync:button_view:${sourceChat.id}`)
    .row()
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `channel_sync:home:${sourceChat.id}`);
  await renderMenu(ctx, text, keyboard);
}

async function renderReplacementPanel(ctx: Context, locale: Locale, sourceChat: PrismaChat, settings: ChannelSyncSettings) {
  const lines = settings.replacements.length
    ? settings.replacements.map((item, index) => `${index + 1}. <code>${escapeHtml(item.from)}</code> → <code>${escapeHtml(item.to)}</code>`)
    : [locale === "zh-CN" ? "暂无关键词替换。" : "No replacements configured."];
  const text = locale === "zh-CN"
    ? ["📝 <b>关键词替换</b>", "", ...lines, "", "仅在关闭“保留转发源”时生效。"].join("\n")
    : ["📝 <b>Keyword replacements</b>", "", ...lines, "", "Only works when preserving the forward source is off."].join("\n");
  const keyboard = new InlineKeyboard()
    .text(locale === "zh-CN" ? "添加" : "Add", `channel_sync:replacement_add:${sourceChat.id}`);
  if (settings.replacements.length) {
    keyboard.row().text(locale === "zh-CN" ? "清空" : "Clear all", `channel_sync:replacements_clear:${sourceChat.id}`);
  }
  settings.replacements.forEach((_, index) => {
    keyboard.row().text(`${locale === "zh-CN" ? "删除" : "Delete"} ${index + 1}`, `channel_sync:replacement_delete:${sourceChat.id}:${index}`);
  });
  keyboard.row().text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `channel_sync:home:${sourceChat.id}`);
  await renderMenu(ctx, text, keyboard);
}

async function renderBlockedPanel(ctx: Context, locale: Locale, sourceChat: PrismaChat, settings: ChannelSyncSettings) {
  const lines = settings.blockedWords.length
    ? settings.blockedWords.map((word, index) => `${index + 1}. <code>${escapeHtml(word)}</code>`)
    : [locale === "zh-CN" ? "暂无屏蔽词。" : "No blocked words configured."];
  const text = locale === "zh-CN"
    ? ["🚫 <b>屏蔽词</b>", "", ...lines, "", "命中屏蔽词的消息不会同步。"].join("\n")
    : ["🚫 <b>Blocked words</b>", "", ...lines, "", "Messages containing a blocked word are skipped."].join("\n");
  const keyboard = new InlineKeyboard()
    .text(locale === "zh-CN" ? "添加" : "Add", `channel_sync:blocked_add:${sourceChat.id}`);
  if (settings.blockedWords.length) {
    keyboard.row().text(locale === "zh-CN" ? "清空" : "Clear all", `channel_sync:blocked_clear:${sourceChat.id}`);
  }
  settings.blockedWords.forEach((_, index) => {
    keyboard.row().text(`${locale === "zh-CN" ? "删除" : "Delete"} ${index + 1}`, `channel_sync:blocked_delete:${sourceChat.id}:${index}`);
  });
  keyboard.row().text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `channel_sync:home:${sourceChat.id}`);
  await renderMenu(ctx, text, keyboard);
}

async function renderTargetPanel(
  ctx: Context,
  locale: Locale,
  sourceChat: PrismaChat,
  settings: ChannelSyncSettings,
  scope: TargetScope,
  botUsername: string
) {
  const chats = (await getManagedChatsForUser(ctx))
    .filter((chat) => chat.id !== sourceChat.id && matchesTargetScope(chat, scope));
  const selected = new Set(settings.targetChatIds);
  const keyboard = new InlineKeyboard();
  for (const chat of chats) {
    keyboard.text(`${selected.has(chat.id) ? "✅" : "⬜"} ${chatLabel(chat)}`.slice(0, 60), `channel_sync:target:${sourceChat.id}:${scope}:${chat.id}`).row();
  }
  if (!chats.length) {
    keyboard.text(locale === "zh-CN" ? "暂无可选目标" : "No available targets", `channel_sync:noop:${sourceChat.id}`).row();
  }
  keyboard
    .url(locale === "zh-CN" ? "➕添加频道" : "➕ Add channel", `https://t.me/${botUsername}?startchannel`)
    .url(locale === "zh-CN" ? "➕添加群组" : "➕ Add group", `https://t.me/${botUsername}?startgroup`)
    .row()
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `channel_sync:home:${sourceChat.id}`);
  const title = scope === "channel"
    ? (locale === "zh-CN" ? "选择目标频道" : "Select target channels")
    : (locale === "zh-CN" ? "选择目标群组" : "Select target groups");
  await renderMenu(ctx, `<b>${title}</b>`, keyboard);
}

function buttonPromptText(settings: ChannelSyncSettings, locale: Locale) {
  const current = settings.buttons.length
    ? `\n当前：${settings.buttons.map((row) => `<code>${row.map((button) => `${escapeHtml(button.text)} - ${escapeHtml(button.url)}`).join(" && ")}</code>`).join("\n")}\n`
    : "";
  return locale === "zh-CN"
    ? `请发送按钮内容，格式：<code>按钮文字 - https://example.com</code>\n同一行两个按钮用 <code>&amp;&amp;</code> 分隔。${current}`
    : `Send button content as <code>Button text - https://example.com</code>. Use <code>&amp;&amp;</code> for two buttons in one row.${current}`;
}

function replacementPromptText(locale: Locale) {
  return locale === "zh-CN"
    ? "请发送替换规则，每行一条：<code>原关键词 =&gt; 替换内容</code>"
    : "Send replacement rules, one per line: <code>old =&gt; new</code>";
}

function blockedPromptText(locale: Locale) {
  return locale === "zh-CN"
    ? "请发送要屏蔽的词，多个词可用换行、逗号或顿号分隔。"
    : "Send blocked words separated by new lines or commas.";
}

function inputTextOnlyText(locale: Locale) {
  return locale === "zh-CN" ? "请输入文字内容。" : "Please send text.";
}

function buttonSavedText(locale: Locale) {
  return locale === "zh-CN" ? "✅链接按钮已保存。" : "✅ Link button saved.";
}

function replacementSavedText(count: number, locale: Locale) {
  return locale === "zh-CN" ? `✅已保存 ${count} 条关键词替换。` : `✅ Saved ${count} replacement(s).`;
}

function blockedSavedText(count: number, locale: Locale) {
  return locale === "zh-CN" ? `✅已保存 ${count} 个屏蔽词。` : `✅ Saved ${count} blocked word(s).`;
}

async function getSourceChat(ctx: Context, sourceChatId: string, locale: Locale) {
  const chat = await prisma.chat.findUnique({ where: { id: sourceChatId } });
  if (!chat || chat.type !== "CHANNEL" || chat.status !== ChatStatus.ACTIVE) {
    await renderMenu(ctx, locale === "zh-CN" ? "找不到该来源频道。" : "Source channel not found.", channelSyncBackKeyboard(sourceChatId, locale));
    return null;
  }
  return chat;
}

async function ensureCanConfigure(ctx: Context, chat: PrismaChat, locale: Locale) {
  if (ctx.from && await canConfigureChat(ctx, chat, ctx.from.id).catch(() => false)) return true;
  await ctx.answerCallbackQuery({
    text: locale === "zh-CN" ? "只有符合控制权限的管理员可以设置机器人。" : "Only permitted admins can configure the bot.",
    show_alert: true
  }).catch(() => undefined);
  return false;
}

async function getManagedChatsForUser(ctx: Context) {
  if (!ctx.from) return [];
  const user = await prisma.user.findUnique({
    where: { telegramUserId: BigInt(ctx.from.id) },
    select: { id: true }
  });
  return user ? listManagedChats(user.id) : [];
}

async function getSelectedTargets(settings: ChannelSyncSettings) {
  if (!settings.targetChatIds.length) return [];
  return prisma.chat.findMany({
    where: {
      id: { in: settings.targetChatIds },
      status: ChatStatus.ACTIVE,
      type: { in: ["GROUP", "SUPERGROUP", "CHANNEL"] }
    }
  });
}

function matchesTargetScope(chat: PrismaChat, scope: TargetScope) {
  return scope === "channel" ? chat.type === "CHANNEL" : chat.type === "GROUP" || chat.type === "SUPERGROUP";
}

function setDraft(ctx: Context, sourceChatId: string, mode: ChannelSyncInputMode) {
  if (ctx.from) drafts.set(ctx.from.id, { sourceChatId, mode });
}

function clearDraft(ctx: Context) {
  if (ctx.from) drafts.delete(ctx.from.id);
}

function parseTargetScope(value: string | undefined): TargetScope | null {
  return value === "channel" || value === "group" ? value : null;
}

function parseIndex(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) return null;
  const index = Number(value);
  return Number.isSafeInteger(index) ? index : null;
}

function getMessageRecord(message: Message) {
  return message as unknown as Record<string, unknown>;
}

function getMessageBody(message: Message) {
  const record = getMessageRecord(message);
  if (typeof record.text === "string") return record.text;
  if (typeof record.caption === "string") return record.caption;
  return "";
}

function containsBlockedWord(body: string, words: string[]) {
  const normalized = body.toLocaleLowerCase();
  return words.some((word) => word && normalized.includes(word.toLocaleLowerCase()));
}

function applyReplacements(body: string, replacements: ChannelSyncReplacement[]) {
  return replacements.reduce((result, replacement) => result.split(replacement.from).join(replacement.to), body);
}

function parseReplacementInput(input: string) {
  return input
    .split(/\r?\n/)
    .map((line) => {
      const separator = line.indexOf("=>");
      if (separator < 1) return null;
      const from = line.slice(0, separator).trim();
      const to = line.slice(separator + 2).trim();
      if (!from || from.length > 128 || to.length > 256) return null;
      return { from, to };
    })
    .filter((item): item is ChannelSyncReplacement => Boolean(item));
}

function parseBlockedWordsInput(input: string) {
  return [...new Set(input.split(/[\r\n,，、]+/).map((item) => item.trim()).filter(Boolean))]
    .filter((item) => item.length <= 128)
    .slice(0, 100);
}

function parseChannelSyncButtons(input: string) {
  const rows = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const buttons = line
        .split("&&")
        .map((segment) => segment.trim())
        .filter(Boolean)
        .map((segment) => {
          const separator = segment.indexOf("-");
          if (separator < 1) return null;
          const text = segment.slice(0, separator).trim().replace(/^#[prg]\s*/i, "").slice(0, 64);
          const url = normalizeButtonUrl(segment.slice(separator + 1).trim());
          if (!text || !url) return null;
          return { text, url };
        })
        .filter((item): item is ChannelSyncButton => Boolean(item));
      return buttons.length ? buttons : null;
    })
    .filter((row): row is ChannelSyncButton[] => Boolean(row));
  return rows.length ? rows : null;
}

function serializeChannelSyncButtons(buttons: ChannelSyncButton[][]) {
  return buttons.map((row) => row.map((button) => `${button.text} - ${button.url}`).join(" && ")).join("\n");
}

function buttonFormatHelp(locale: Locale) {
  return locale === "zh-CN"
    ? "格式：<code>按钮名-https://example.com</code>，同一行多个按钮用 <code>&amp;&amp;</code> 分隔，换行表示新的一行。"
    : "Format: <code>Button-https://example.com</code>. Use <code>&amp;&amp;</code> for multiple buttons on one row and new lines for new rows.";
}

function channelSyncInlineKeyboard(buttons: ChannelSyncButton[][]) {
  if (!buttons.length) return undefined;
  const keyboard = new InlineKeyboard();
  buttons.forEach((row) => {
    row.forEach((button) => keyboard.url(button.text, button.url));
    keyboard.row();
  });
  return keyboard;
}

function normalizeButtonUrl(value: string) {
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function getMediaFileId(value: unknown) {
  if (Array.isArray(value)) {
    const item = value.at(-1);
    return isRecord(item) && typeof item.file_id === "string" ? item.file_id : "";
  }
  return isRecord(value) && typeof value.file_id === "string" ? value.file_id : "";
}

function getSentMessageId(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return isRecord(value) && typeof value.message_id === "number" ? value.message_id : null;
}

function chatLabel(chat: PrismaChat) {
  return chat.title ?? (chat.username ? `@${chat.username}` : chat.telegramChatId.toString());
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

async function getSettings(chatId: string): Promise<ChannelSyncSettings> {
  const row = await prisma.setting.findUnique({
    where: { chatId_key: { chatId, key: settingKey } }
  });
  const raw = isRecord(row?.value) ? row.value : {};
  const replacementValue: unknown = raw.replacements;
  const blockedWordsValue: unknown = raw.blockedWords;
  const targetChatIdsValue: unknown = raw.targetChatIds;
  const legacyButtons = typeof raw.buttonText === "string" && typeof raw.buttonUrl === "string" && raw.buttonText && raw.buttonUrl
    ? [[{ text: raw.buttonText.slice(0, 64), url: normalizeButtonUrl(raw.buttonUrl) }]].filter((row) => row[0]?.url)
    : [];
  const replacements = Array.isArray(replacementValue)
    ? replacementValue
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({
        from: typeof item.from === "string" ? item.from.trim().slice(0, 128) : "",
        to: typeof item.to === "string" ? item.to.slice(0, 256) : ""
      }))
      .filter((item) => item.from)
    : [];
  const blockedWords = Array.isArray(blockedWordsValue)
    ? blockedWordsValue.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 128)).slice(0, 100)
    : [];
  const targetChatIds = Array.isArray(targetChatIdsValue)
    ? targetChatIdsValue.filter((item): item is string => typeof item === "string").slice(0, 100)
    : [];
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : defaultSettings.enabled,
    preserveSource: typeof raw.preserveSource === "boolean" ? raw.preserveSource : defaultSettings.preserveSource,
    pinMessages: typeof raw.pinMessages === "boolean" ? raw.pinMessages : defaultSettings.pinMessages,
    buttonText: typeof raw.buttonText === "string" ? raw.buttonText.slice(0, 64) : defaultSettings.buttonText,
    buttonUrl: typeof raw.buttonUrl === "string" ? raw.buttonUrl.slice(0, 512) : defaultSettings.buttonUrl,
    buttons: Array.isArray(raw.buttons)
      ? (raw.buttons
        .map((row) => Array.isArray(row)
          ? row
            .map((item) => isRecord(item) && typeof item.text === "string" && typeof item.url === "string"
              ? { text: item.text.slice(0, 64), url: normalizeButtonUrl(item.url) }
              : null)
            .filter((item): item is ChannelSyncButton => Boolean(item))
          : [])
        .filter((row) => row.length > 0))
      : legacyButtons.length ? legacyButtons : defaultSettings.buttons,
    replacements,
    blockedWords,
    targetChatIds
  };
}

async function saveSettings(chatId: string, settings: ChannelSyncSettings) {
  await prisma.setting.upsert({
    where: { chatId_key: { chatId, key: settingKey } },
    create: { chatId, key: settingKey, value: settings as unknown as Prisma.InputJsonObject },
    update: { value: settings as unknown as Prisma.InputJsonObject }
  });
}

async function renderMenu(ctx: Context, text: string, keyboard: InlineKeyboard) {
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
