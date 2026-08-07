import { InlineKeyboard, type Context } from "grammy";
import { ChatStatus, type Chat as PrismaChat, type Prisma } from "@prisma/client";
import type { Message } from "grammy/types";
import { prisma } from "../lib/prisma.js";
import { canConfigureChat } from "./permissions.js";

type Locale = "zh-CN" | "en";

type CommentSofaMediaKind = "photo" | "video" | "animation" | "sticker" | "document" | "audio" | "voice";

type CommentSofaButton = {
  text: string;
  url: string;
};

type CommentSofaSettings = {
  enabled: boolean;
  text: string;
  mediaKind: CommentSofaMediaKind | undefined;
  mediaFileId: string | undefined;
  buttons: CommentSofaButton[][];
};

type CommentSofaDraft = {
  chatId: string;
  mode: "text" | "media" | "buttons";
};

const settingKey = "comment_sofa";
const drafts = new Map<number, CommentSofaDraft>();
const defaultSettings: CommentSofaSettings = {
  enabled: false,
  text: "",
  mediaKind: undefined,
  mediaFileId: undefined,
  buttons: []
};

export function clearCommentSofaDraft(userId: number) {
  drafts.delete(userId);
}

export async function openCommentSofaMenu(ctx: Context, locale: Locale, sourceChat: PrismaChat) {
  if (sourceChat.type !== "CHANNEL") {
    await render(ctx, locale === "zh-CN" ? "评论沙发仅支持频道。" : "Comment sofa is only available for channels.", backKeyboard(sourceChat.id, locale));
    return;
  }

  const settings = await getSettings(sourceChat.id);
  await render(ctx, commentSofaText(settings, locale), commentSofaKeyboard(sourceChat.id, settings, locale));
}

export async function handleCommentSofaCallback(ctx: Context, locale: Locale) {
  await ctx.answerCallbackQuery().catch(() => undefined);

  const parts = ctx.callbackQuery?.data?.split(":") ?? [];
  const action = parts[1];
  const sourceChatId = parts[2];
  if (!action || !sourceChatId || !ctx.from) return;

  const sourceChat = await prisma.chat.findUnique({ where: { id: sourceChatId } });
  if (!sourceChat || sourceChat.type !== "CHANNEL" || sourceChat.status !== ChatStatus.ACTIVE) {
    await render(ctx, locale === "zh-CN" ? "找不到该频道。" : "Source channel not found.", backKeyboard(sourceChatId, locale));
    return;
  }

  if (!(await canConfigureChat(ctx, sourceChat, ctx.from.id).catch(() => false))) {
    await ctx.answerCallbackQuery({
      text: locale === "zh-CN" ? "只有频道管理员可以配置评论沙发。" : "Only channel admins can configure comment sofa.",
      show_alert: true
    }).catch(() => undefined);
    return;
  }

  const draft = drafts.get(ctx.from.id);
  if (!draft || draft.chatId !== sourceChat.id) {
    drafts.set(ctx.from.id, { chatId: sourceChat.id, mode: "text" });
  }
  const current = drafts.get(ctx.from.id);
  if (!current) return;

  if (action === "home") {
    drafts.delete(ctx.from.id);
    const currentSettings = await getSettings(sourceChat.id);
    await render(ctx, commentSofaText(currentSettings, locale), commentSofaKeyboard(sourceChat.id, currentSettings, locale));
    return;
  }

  const settings = await getSettings(sourceChat.id);

  if (action === "status") {
    const value = parts[3];
    if (value !== "on" && value !== "off") return;
    settings.enabled = value === "on";
    await saveSettings(sourceChat.id, settings);
    await render(ctx, commentSofaText(settings, locale), commentSofaKeyboard(sourceChat.id, settings, locale));
    return;
  }

  if (action === "text") {
    current.mode = "text";
    await render(ctx, textPromptText(settings, locale), inputKeyboard(sourceChat.id, "text", locale));
    return;
  }

  if (action === "media") {
    current.mode = "media";
    await render(ctx, mediaPromptText(settings, locale), inputKeyboard(sourceChat.id, "media", locale));
    return;
  }

  if (action === "buttons") {
    current.mode = "buttons";
    await render(ctx, buttonsPromptText(settings, locale), inputKeyboard(sourceChat.id, "buttons", locale));
    return;
  }

  if (action === "preview") {
    await sendCommentContent(ctx, settings, ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id);
    await render(ctx, commentSofaText(settings, locale), commentSofaKeyboard(sourceChat.id, settings, locale));
    return;
  }

  if (action === "clear") {
    if (current.mode === "text") settings.text = "";
    if (current.mode === "media") {
      settings.mediaKind = undefined;
      settings.mediaFileId = undefined;
    }
    if (current.mode === "buttons") settings.buttons = [];
    await saveSettings(sourceChat.id, settings);
    await render(ctx, commentSofaText(settings, locale), commentSofaKeyboard(sourceChat.id, settings, locale));
    return;
  }

  if (action === "clear_text") {
    settings.text = "";
    await saveSettings(sourceChat.id, settings);
    await render(ctx, commentSofaText(settings, locale), commentSofaKeyboard(sourceChat.id, settings, locale));
    return;
  }

  if (action === "clear_media") {
    settings.mediaKind = undefined;
    settings.mediaFileId = undefined;
    await saveSettings(sourceChat.id, settings);
    await render(ctx, commentSofaText(settings, locale), commentSofaKeyboard(sourceChat.id, settings, locale));
    return;
  }

  if (action === "clear_buttons") {
    settings.buttons = [];
    await saveSettings(sourceChat.id, settings);
    await render(ctx, commentSofaText(settings, locale), commentSofaKeyboard(sourceChat.id, settings, locale));
    return;
  }

  if (action === "cancel") {
    drafts.delete(ctx.from.id);
    await render(ctx, commentSofaText(settings, locale), commentSofaKeyboard(sourceChat.id, settings, locale));
  }
}

export async function handleCommentSofaInputMessage(ctx: Context, locale: Locale) {
  if (!ctx.from || ctx.chat?.type !== "private" || !ctx.message) return false;

  const draft = drafts.get(ctx.from.id);
  if (!draft) return false;

  const sourceChat = await prisma.chat.findUnique({ where: { id: draft.chatId } });
  if (!sourceChat || sourceChat.type !== "CHANNEL" || !(await canConfigureChat(ctx, sourceChat, ctx.from.id).catch(() => false))) {
    drafts.delete(ctx.from.id);
    return true;
  }

  const settings = await getSettings(sourceChat.id);

  if (draft.mode === "text") {
    const text = getMessageText(ctx.message);
    if (!text) {
      await ctx.reply(textPromptText(settings, locale), { parse_mode: "HTML", reply_markup: inputKeyboard(sourceChat.id, "text", locale) });
      return true;
    }

    settings.text = text;
    await saveSettings(sourceChat.id, settings);
    drafts.delete(ctx.from.id);
    await ctx.reply(locale === "zh-CN" ? "✅ 文本已保存。" : "✅ Text saved.", {
      parse_mode: "HTML",
      reply_markup: commentSofaKeyboard(sourceChat.id, settings, locale)
    });
    return true;
  }

  if (draft.mode === "media") {
    const media = extractMedia(ctx.message);
    if (!media) {
      await ctx.reply(mediaPromptText(settings, locale), { parse_mode: "HTML", reply_markup: inputKeyboard(sourceChat.id, "media", locale) });
      return true;
    }

    settings.mediaKind = media.kind;
    settings.mediaFileId = media.fileId;
    const caption = "caption" in ctx.message && typeof ctx.message.caption === "string" ? ctx.message.caption.trim() : "";
    if (caption) settings.text = caption;
    await saveSettings(sourceChat.id, settings);
    drafts.delete(ctx.from.id);
    await ctx.reply(locale === "zh-CN" ? "✅ 媒体已保存。" : "✅ Media saved.", {
      parse_mode: "HTML",
      reply_markup: commentSofaKeyboard(sourceChat.id, settings, locale)
    });
    return true;
  }

  const text = getMessageText(ctx.message);
  const buttons = parseButtonsInput(text ?? "");
  if (!buttons.length) {
    await ctx.reply(buttonsPromptText(settings, locale), { parse_mode: "HTML", reply_markup: inputKeyboard(sourceChat.id, "buttons", locale) });
    return true;
  }

  settings.buttons = buttons;
  await saveSettings(sourceChat.id, settings);
  drafts.delete(ctx.from.id);
  await ctx.reply(locale === "zh-CN" ? "✅ 按钮已保存。" : "✅ Buttons saved.", {
    parse_mode: "HTML",
    reply_markup: commentSofaKeyboard(sourceChat.id, settings, locale)
  });
  return true;
}

export async function handleCommentSofaMessage(ctx: Context) {
  const message = ctx.message;
  if (!ctx.chat || !message || !isGroupLike(ctx.chat)) return false;

  const source = getForwardedChannelSource(message);
  if (!source) return false;

  const sourceChat = await prisma.chat.findFirst({
    where: {
      telegramChatId: BigInt(source.chatId),
      type: "CHANNEL",
      status: ChatStatus.ACTIVE
    }
  });
  if (!sourceChat) return false;

  const settings = await getSettings(sourceChat.id);
  if (!settings.enabled) return false;

  const chatId = ctx.chat.id;
  const replyToMessageId = message.message_id;
  await sendCommentContent(ctx, settings, chatId, replyToMessageId).catch((error) => {
    console.warn("Failed to send comment sofa message", {
      sourceChatId: sourceChat.id,
      chatId,
      replyToMessageId,
      error: error instanceof Error ? error.message : String(error)
    });
  });
  return true;
}

function commentSofaText(settings: CommentSofaSettings, locale: Locale) {
  const enabled = settings.enabled ? "✅ 开启" : "❌ 关闭";
  const text = settings.text ? "✅" : "❌";
  const media = settings.mediaFileId ? "✅" : "❌";
  const buttons = settings.buttons.length ? "✅" : "❌";
  return locale === "zh-CN"
    ? [
        "🛋️ <b>评论区沙发</b>",
        "",
        "开启后，频道发送的消息，机器人会第一时间占领评论区沙发",
        "",
        `<b>状态：</b>${enabled}`,
        `<b>评论文本：</b>${text}`,
        `<b>评论媒体：</b>${media}`,
        `<b>评论按钮：</b>${buttons}`
      ].join("\n")
    : [
        "🛋️ <b>Comment sofa</b>",
        "",
        "When enabled, the bot will post first in the linked discussion thread for channel posts.",
        "",
        `<b>Status:</b> ${enabled}`,
        `<b>Comment text:</b> ${text}`,
        `<b>Comment media:</b> ${media}`,
        `<b>Comment buttons:</b> ${buttons}`
      ].join("\n");
}

function commentSofaKeyboard(sourceChatId: string, settings: CommentSofaSettings, locale: Locale) {
  const selected = (active: boolean, label: string) => (active ? `✅ ${label}` : label);
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "状态:" : "Status:", `comment_sofa:noop:${sourceChatId}`)
    .text(selected(settings.enabled, locale === "zh-CN" ? "开启" : "On"), `comment_sofa:status:${sourceChatId}:on`)
    .text(selected(!settings.enabled, locale === "zh-CN" ? "关闭" : "Off"), `comment_sofa:status:${sourceChatId}:off`)
    .row()
    .text(locale === "zh-CN" ? "📝 修改文本" : "📝 Edit text", `comment_sofa:text:${sourceChatId}`)
    .text(locale === "zh-CN" ? "📷 修改媒体" : "📷 Edit media", `comment_sofa:media:${sourceChatId}`)
    .row()
    .text(locale === "zh-CN" ? "🔠 修改按钮" : "🔠 Edit buttons", `comment_sofa:buttons:${sourceChatId}`)
    .text(locale === "zh-CN" ? "👀 预览消息" : "👀 Preview", `comment_sofa:preview:${sourceChatId}`)
    .row()
    .text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `menu:chat:channel:${sourceChatId}`);
}

function inputKeyboard(sourceChatId: string, mode: CommentSofaDraft["mode"], locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "清空" : "Clear", `comment_sofa:clear_${mode}:${sourceChatId}`)
    .text(locale === "zh-CN" ? "取消" : "Cancel", `comment_sofa:cancel:${sourceChatId}`);
}

function textPromptText(settings: CommentSofaSettings, locale: Locale) {
  const current = settings.text ? escapeHtml(settings.text) : (locale === "zh-CN" ? "未设置" : "Not set");
  return locale === "zh-CN"
    ? [`📝 <b>修改评论文本</b>`, "", `当前文本：<code>${current}</code>`, "", "发送新的文本内容。"].join("\n")
    : [`📝 <b>Edit comment text</b>`, "", `Current text: <code>${current}</code>`, "", "Send the new text content."].join("\n");
}

function mediaPromptText(settings: CommentSofaSettings, locale: Locale) {
  const current = settings.mediaFileId ? escapeHtml(settings.mediaKind ?? "media") : (locale === "zh-CN" ? "未设置" : "Not set");
  return locale === "zh-CN"
    ? [`📷 <b>修改评论媒体</b>`, "", `当前媒体：<code>${current}</code>`, "", "回复一条照片、视频、GIF、贴纸、文件、音频或语音。"].join("\n")
    : [`📷 <b>Edit comment media</b>`, "", `Current media: <code>${current}</code>`, "", "Reply with a photo, video, GIF, sticker, document, audio, or voice."].join("\n");
}

function buttonsPromptText(settings: CommentSofaSettings, locale: Locale) {
  const current = settings.buttons.length
    ? settings.buttons.map((row) => `<code>${row.map((button) => `${escapeHtml(button.text)} - ${escapeHtml(button.url)}`).join(" && ")}</code>`).join("\n")
    : (locale === "zh-CN" ? "未设置" : "Not set");
  return locale === "zh-CN"
    ? [
        "🔠 <b>修改评论按钮</b>",
        "",
        `当前按钮：${current}`,
        "",
        "格式：按钮文字 - https://example.com",
        "同一行两个按钮用 && 分隔。"
      ].join("\n")
    : [
        "🔠 <b>Edit comment buttons</b>",
        "",
        `Current buttons: ${current}`,
        "",
        "Format: Button text - https://example.com",
        "Use && to place two buttons on one row."
      ].join("\n");
}

function backKeyboard(sourceChatId: string, locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "返回" : "Back", `menu:chat:channel:${sourceChatId}`);
}

async function render(ctx: Context, text: string, keyboard: InlineKeyboard) {
  if (ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard }).catch(async () => {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    });
    return;
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
}

async function getSettings(chatId: string): Promise<CommentSofaSettings> {
  const record = await prisma.setting.findUnique({ where: { chatId_key: { chatId, key: settingKey } } });
  return parseSettings(record?.value);
}

async function saveSettings(chatId: string, settings: CommentSofaSettings) {
  await prisma.setting.upsert({
    where: { chatId_key: { chatId, key: settingKey } },
    create: { chatId, key: settingKey, value: serializeSettings(settings) },
    update: { value: serializeSettings(settings) }
  });
}

function parseSettings(value: Prisma.JsonValue | null | undefined): CommentSofaSettings {
  if (!isRecord(value)) return { ...defaultSettings };
  const raw = value as Record<string, unknown>;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : defaultSettings.enabled,
    text: typeof raw.text === "string" ? raw.text : defaultSettings.text,
    mediaKind: isMediaKind(raw.mediaKind) ? raw.mediaKind : undefined,
    mediaFileId: typeof raw.mediaFileId === "string" ? raw.mediaFileId : undefined,
    buttons: parseSavedButtons(raw.buttons)
  };
}

function serializeSettings(settings: CommentSofaSettings): Prisma.InputJsonObject {
  const value: Record<string, unknown> = {
    enabled: settings.enabled,
    text: settings.text,
    buttons: settings.buttons
  };
  if (settings.mediaKind) value.mediaKind = settings.mediaKind;
  if (settings.mediaFileId) value.mediaFileId = settings.mediaFileId;
  return value as Prisma.InputJsonObject;
}

function parseSavedButtons(value: unknown): CommentSofaButton[][] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => Array.isArray(row)
      ? row
        .map((item) => isRecord(item) && typeof item.text === "string" && typeof item.url === "string"
          ? { text: item.text.trim().slice(0, 64), url: item.url.trim().slice(0, 256) }
          : null)
        .filter((item): item is CommentSofaButton => Boolean(item))
      : [])
    .filter((row) => row.length > 0);
}

function parseButtonsInput(input: string) {
  return input
    .split(/\r?\n/)
    .map((line) =>
      line
        .split("&&")
        .map((item) => parseButtonItem(item.trim()))
        .filter((item): item is CommentSofaButton => Boolean(item))
    )
    .filter((row) => row.length > 0);
}

function parseButtonItem(input: string): CommentSofaButton | null {
  const separator = input.lastIndexOf("-");
  if (separator < 1) return null;
  const text = input.slice(0, separator).trim();
  const url = normalizeUrl(input.slice(separator + 1).trim());
  if (!text || !url) return null;
  return { text: text.slice(0, 64), url: url.slice(0, 256) };
}

function normalizeUrl(url: string) {
  if (!url) return "";
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function extractMedia(message: Message): { kind: CommentSofaMediaKind; fileId: string } | null {
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

function getMessageText(message: Message) {
  if ("text" in message && typeof message.text === "string") return message.text.trim();
  if ("caption" in message && typeof message.caption === "string") return message.caption.trim();
  return "";
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function sendCommentContent(
  ctx: Context,
  settings: CommentSofaSettings,
  chatId?: number,
  replyToMessageId?: number
) {
  if (!chatId) return false;
  const buttons = buildButtons(settings.buttons);
  const hasText = Boolean(settings.text.trim());
  const hasMedia = Boolean(settings.mediaKind && settings.mediaFileId);
  if (!hasText && !hasMedia) return false;

  const baseOptions = {
    ...(buttons ? { reply_markup: buttons } : {}),
    ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {})
  };

  if (!hasMedia || !settings.mediaFileId || !settings.mediaKind) {
    await ctx.api.sendMessage(chatId, hasText ? settings.text : " ", {
      ...baseOptions,
      parse_mode: "HTML"
    });
    return true;
  }

  const captionOptions = hasText ? { caption: settings.text, parse_mode: "HTML" as const } : {};
  if (settings.mediaKind === "photo") {
    await ctx.api.sendPhoto(chatId, settings.mediaFileId, { ...baseOptions, ...captionOptions });
    return true;
  }
  if (settings.mediaKind === "video") {
    await ctx.api.sendVideo(chatId, settings.mediaFileId, { ...baseOptions, ...captionOptions });
    return true;
  }
  if (settings.mediaKind === "animation") {
    await ctx.api.sendAnimation(chatId, settings.mediaFileId, { ...baseOptions, ...captionOptions });
    return true;
  }
  if (settings.mediaKind === "document") {
    await ctx.api.sendDocument(chatId, settings.mediaFileId, { ...baseOptions, ...captionOptions });
    return true;
  }
  if (settings.mediaKind === "audio") {
    await ctx.api.sendAudio(chatId, settings.mediaFileId, { ...baseOptions, ...captionOptions });
    return true;
  }
  if (settings.mediaKind === "voice") {
    await ctx.api.sendVoice(chatId, settings.mediaFileId, { ...baseOptions, ...captionOptions });
    return true;
  }

  await ctx.api.sendSticker(chatId, settings.mediaFileId, baseOptions);
  if (hasText) {
    await ctx.api.sendMessage(chatId, settings.text, {
      ...baseOptions,
      parse_mode: "HTML"
    });
  }
  return true;
}

function buildButtons(buttons: CommentSofaButton[][]) {
  if (!buttons.length) return undefined;
  const keyboard = new InlineKeyboard();
  buttons.forEach((row, rowIndex) => {
    row.forEach((button) => keyboard.url(button.text, button.url));
    if (rowIndex < buttons.length - 1) keyboard.row();
  });
  return keyboard;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMediaKind(value: unknown): value is CommentSofaMediaKind {
  return value === "photo"
    || value === "video"
    || value === "animation"
    || value === "sticker"
    || value === "document"
    || value === "audio"
    || value === "voice";
}

function isGroupLike(chat: { type: string }) {
  return chat.type === "group" || chat.type === "supergroup";
}

function getForwardedChannelSource(message: Message) {
  const record = message as unknown as Record<string, unknown>;
  const origin = isRecord(record.forward_origin) ? record.forward_origin : undefined;
  const originChat = origin && isRecord(origin.chat) ? origin.chat : undefined;
  if (
    origin?.type === "channel"
    && originChat
    && typeof originChat.id === "number"
    && typeof origin.message_id === "number"
  ) {
    return { chatId: originChat.id, messageId: origin.message_id };
  }

  const forwardFromChat = isRecord(record.forward_from_chat) ? record.forward_from_chat : undefined;
  const forwardFromMessageId = typeof record.forward_from_message_id === "number" ? record.forward_from_message_id : undefined;
  if (
    forwardFromChat?.type === "channel"
    && typeof forwardFromChat.id === "number"
    && typeof forwardFromMessageId === "number"
  ) {
    return { chatId: forwardFromChat.id, messageId: forwardFromMessageId };
  }

  if (record.is_automatic_forward === true && forwardFromChat?.type === "channel" && typeof forwardFromChat.id === "number") {
    return { chatId: forwardFromChat.id, messageId: 0 };
  }

  return null;
}
