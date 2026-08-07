import { InlineKeyboard, type Context } from "grammy";
import type { InlineKeyboardButton, InlineKeyboardMarkup, Message } from "grammy/types";
import { ChatStatus, type Chat as PrismaChat } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { canConfigureChat } from "./permissions.js";

type Locale = "zh-CN" | "en";
type Button = InlineKeyboardButton;

type ChannelButtonTarget = {
  chatId: number;
  messageId: number;
  buttons: Button[][];
};

type ChannelButtonDraft = {
  sourceChatId: string;
  stage: "forward" | "add" | "edit";
  target?: ChannelButtonTarget;
  editRow?: number;
  editColumn?: number;
};

const drafts = new Map<number, ChannelButtonDraft>();

export function clearChannelButtonsDraft(userId: number) {
  drafts.delete(userId);
}

export async function openChannelButtonsMenu(ctx: Context, locale: Locale, sourceChat: PrismaChat) {
  if (sourceChat.type !== "CHANNEL" || sourceChat.status !== ChatStatus.ACTIVE) {
    await render(
      ctx,
      locale === "zh-CN" ? "修改按钮仅支持频道消息。" : "Button editing is only available for channel messages.",
      backKeyboard(sourceChat.id, locale)
    );
    return;
  }

  if (!ctx.from) return;
  drafts.set(ctx.from.id, { sourceChatId: sourceChat.id, stage: "forward" });
  await render(ctx, forwardPromptText(sourceChat, locale), backKeyboard(sourceChat.id, locale));
}

export async function handleChannelButtonsCallback(ctx: Context, locale: Locale) {
  await ctx.answerCallbackQuery().catch(() => undefined);

  const parts = ctx.callbackQuery?.data?.split(":") ?? [];
  const action = parts[1];
  const sourceChatId = parts[2];
  if (!action || !sourceChatId || !ctx.from) return;

  const sourceChat = await prisma.chat.findUnique({ where: { id: sourceChatId } });
  if (!sourceChat || sourceChat.type !== "CHANNEL" || sourceChat.status !== ChatStatus.ACTIVE) {
    await render(ctx, locale === "zh-CN" ? "找不到该来源频道。" : "Source channel not found.", backKeyboard(sourceChatId, locale));
    return;
  }

  if (!(await canConfigureChat(ctx, sourceChat, ctx.from.id).catch(() => false))) {
    await ctx.answerCallbackQuery({
      text: locale === "zh-CN" ? "只有频道管理员可以修改按钮。" : "Only channel admins can edit buttons.",
      show_alert: true
    }).catch(() => undefined);
    return;
  }

  const draft = drafts.get(ctx.from.id);
  if (!draft || draft.sourceChatId !== sourceChat.id) {
    drafts.set(ctx.from.id, { sourceChatId: sourceChat.id, stage: "forward" });
  }
  const current = drafts.get(ctx.from.id);
  if (!current) return;

  if (action === "cancel") {
    drafts.delete(ctx.from.id);
    await render(ctx, locale === "zh-CN" ? "已取消修改按钮。" : "Button editing cancelled.", backKeyboard(sourceChat.id, locale));
    return;
  }

  if (action === "forward") {
    current.stage = "forward";
    delete current.target;
    delete current.editRow;
    delete current.editColumn;
    await render(ctx, forwardPromptText(sourceChat, locale), backKeyboard(sourceChat.id, locale));
    return;
  }

  if (action === "panel") {
    if (!current.target) {
      await render(ctx, forwardPromptText(sourceChat, locale), backKeyboard(sourceChat.id, locale));
      return;
    }
    await render(ctx, buttonPanelText(sourceChat, current.target.buttons, locale), buttonPanelKeyboard(sourceChat.id, current.target.buttons, locale));
    return;
  }

  if (action === "add") {
    if (!current.target) {
      await render(ctx, forwardPromptText(sourceChat, locale), backKeyboard(sourceChat.id, locale));
      return;
    }
    current.stage = "add";
    delete current.editRow;
    delete current.editColumn;
    await render(ctx, buttonInputPromptText("add", locale), buttonInputKeyboard(sourceChat.id, locale));
    return;
  }

  if (action === "edit") {
    const row = parseIndex(parts[3]);
    const column = parseIndex(parts[4]);
    if (!current.target || row === null || column === null || !current.target.buttons[row]?.[column]) return;
    current.stage = "edit";
    current.editRow = row;
    current.editColumn = column;
    await render(ctx, buttonInputPromptText("edit", locale), buttonInputKeyboard(sourceChat.id, locale));
    return;
  }

  if (action === "delete") {
    const row = parseIndex(parts[3]);
    const column = parseIndex(parts[4]);
    if (!current.target || row === null || column === null || !current.target.buttons[row]?.[column]) return;

    current.target.buttons[row].splice(column, 1);
    if (!current.target.buttons[row].length) current.target.buttons.splice(row, 1);
    await updateTargetMarkup(ctx, current.target);
    await render(ctx, buttonPanelText(sourceChat, current.target.buttons, locale), buttonPanelKeyboard(sourceChat.id, current.target.buttons, locale));
    return;
  }

  if (action === "clear") {
    if (!current.target) return;
    current.target.buttons = [];
    await updateTargetMarkup(ctx, current.target);
    await render(ctx, buttonPanelText(sourceChat, current.target.buttons, locale), buttonPanelKeyboard(sourceChat.id, current.target.buttons, locale));
  }
}

export async function handleChannelButtonsInputMessage(ctx: Context, locale: Locale) {
  if (!ctx.from || ctx.chat?.type !== "private" || !ctx.message) return false;

  const draft = drafts.get(ctx.from.id);
  if (!draft) return false;

  const sourceChat = await prisma.chat.findUnique({ where: { id: draft.sourceChatId } });
  if (!sourceChat || sourceChat.type !== "CHANNEL" || sourceChat.status !== ChatStatus.ACTIVE) {
    drafts.delete(ctx.from.id);
    return true;
  }

  if (!(await canConfigureChat(ctx, sourceChat, ctx.from.id).catch(() => false))) {
    drafts.delete(ctx.from.id);
    return true;
  }

  if (draft.stage === "forward") {
    const forwarded = extractForwardedChannelMessage(ctx.message);
    if (!forwarded || BigInt(forwarded.chatId) !== sourceChat.telegramChatId) {
      await ctx.reply(forwardPromptText(sourceChat, locale), {
        parse_mode: "HTML",
        reply_markup: backKeyboard(sourceChat.id, locale)
      });
      return true;
    }

    draft.target = {
      chatId: forwarded.chatId,
      messageId: forwarded.messageId,
      buttons: extractInlineKeyboard(ctx.message)
    };
    await ctx.reply(
      buttonPanelText(sourceChat, draft.target.buttons, locale),
      {
        parse_mode: "HTML",
        reply_markup: buttonPanelKeyboard(sourceChat.id, draft.target.buttons, locale)
      }
    );
    return true;
  }

  if (!draft.target) {
    draft.stage = "forward";
    await ctx.reply(forwardPromptText(sourceChat, locale), {
      parse_mode: "HTML",
      reply_markup: backKeyboard(sourceChat.id, locale)
    });
    return true;
  }

  const text = getText(ctx.message);
  const parsed = text ? parseButtonInput(text) : null;
  if (!parsed) {
    await ctx.reply(buttonInputPromptText(draft.stage, locale), {
      parse_mode: "HTML",
      reply_markup: buttonInputKeyboard(sourceChat.id, locale)
    });
    return true;
  }

  if (draft.stage === "add") {
    draft.target.buttons.push([{ text: parsed.text, url: parsed.url }]);
  } else {
    const row = draft.editRow;
    const column = draft.editColumn;
    if (row === undefined || column === undefined || !draft.target.buttons[row]?.[column]) {
      draft.stage = "forward";
      await ctx.reply(forwardPromptText(sourceChat, locale), {
        parse_mode: "HTML",
        reply_markup: backKeyboard(sourceChat.id, locale)
      });
      return true;
    }
    draft.target.buttons[row][column] = { text: parsed.text, url: parsed.url };
  }

  try {
    await updateTargetMarkup(ctx, draft.target);
  } catch {
    await ctx.reply(
      locale === "zh-CN"
        ? "修改失败，请确认 Bot 在频道内拥有编辑消息权限。"
        : "The update failed. Make sure the bot can edit messages in the channel.",
      { parse_mode: "HTML", reply_markup: buttonPanelKeyboard(sourceChat.id, draft.target.buttons, locale) }
    );
    return true;
  }

  draft.stage = "forward";
  delete draft.editRow;
  delete draft.editColumn;
  await ctx.reply(
    locale === "zh-CN" ? "✅ 按钮已更新。" : "✅ Button updated.",
    { parse_mode: "HTML", reply_markup: buttonPanelKeyboard(sourceChat.id, draft.target.buttons, locale) }
  );
  return true;
}

function forwardPromptText(sourceChat: PrismaChat, locale: Locale) {
  const title = escapeHtml(sourceChat.title ?? sourceChat.username ?? "频道");
  return locale === "zh-CN"
    ? `请转发 <b>${title}</b> 内的消息给机器人，添加、删除或者编辑按钮\n（请确保 Bot 已在频道内被设置为管理员）`
    : `Forward a message from <b>${title}</b> to add, delete, or edit its buttons.\n(Make sure the bot is an administrator in the channel.)`;
}

function buttonInputPromptText(mode: "add" | "edit", locale: Locale) {
  return locale === "zh-CN"
    ? `${mode === "add" ? "请发送要添加的按钮：" : "请发送新的按钮内容："}\n\n<code>按钮文字 - https://example.com</code>`
    : `${mode === "add" ? "Send the button to add:" : "Send the replacement button:"}\n\n<code>Button text - https://example.com</code>`;
}

function backKeyboard(sourceChatId: string, locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "返回" : "Back", `channel_buttons:cancel:${sourceChatId}`);
}

function buttonInputKeyboard(sourceChatId: string, locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "返回按钮列表" : "Back to buttons", `channel_buttons:panel:${sourceChatId}`)
    .text(locale === "zh-CN" ? "重新转发" : "Forward another", `channel_buttons:forward:${sourceChatId}`);
}

function buttonPanelKeyboard(sourceChatId: string, buttons: Button[][], locale: Locale) {
  const keyboard = new InlineKeyboard()
    .text(locale === "zh-CN" ? "添加按钮" : "Add button", `channel_buttons:add:${sourceChatId}`);

  buttons.forEach((row, rowIndex) => {
    row.forEach((button, columnIndex) => {
      const label = `${rowIndex + 1}-${columnIndex + 1}`;
      keyboard
        .row()
        .text(`${locale === "zh-CN" ? "编辑" : "Edit"} ${label}`, `channel_buttons:edit:${sourceChatId}:${rowIndex}:${columnIndex}`)
        .text(`${locale === "zh-CN" ? "删除" : "Delete"} ${label}`, `channel_buttons:delete:${sourceChatId}:${rowIndex}:${columnIndex}`);
    });
  });

  if (buttons.length) {
    keyboard.row().text(locale === "zh-CN" ? "清空全部按钮" : "Clear all", `channel_buttons:clear:${sourceChatId}`);
  }

  return keyboard
    .row()
    .text(locale === "zh-CN" ? "重新转发" : "Forward another", `channel_buttons:forward:${sourceChatId}`)
    .text(locale === "zh-CN" ? "返回" : "Back", `channel_buttons:cancel:${sourceChatId}`);
}

function buttonPanelText(sourceChat: PrismaChat, buttons: Button[][], locale: Locale) {
  const title = escapeHtml(sourceChat.title ?? sourceChat.username ?? "频道");
  const lines = buttons.length
    ? buttons.map((row, rowIndex) =>
        row
          .map((button, columnIndex) => {
            const suffix = isUrlButton(button) ? ` - ${escapeHtml(button.url)}` : "";
            return `${rowIndex + 1}-${columnIndex + 1}. ${escapeHtml(button.text)}${suffix}`;
          })
          .join("\n")
      )
    : [locale === "zh-CN" ? "当前没有按钮。" : "No buttons are attached."];

  return locale === "zh-CN"
    ? [`🔠 <b>修改按钮</b>`, "", `<b>频道：</b>${title}`, "", ...lines, "", "请选择添加、删除或编辑。"].join("\n")
    : [`🔠 <b>Edit buttons</b>`, "", `<b>Channel:</b> ${title}`, "", ...lines, "", "Choose add, delete, or edit."].join("\n");
}

function extractForwardedChannelMessage(message: Message) {
  const record = getRecord(message);
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

  const legacyChat = isRecord(record.forward_from_chat) ? record.forward_from_chat : undefined;
  const legacyMessageId = record.forward_from_message_id;
  if (legacyChat && legacyChat.type === "channel" && typeof legacyChat.id === "number" && typeof legacyMessageId === "number") {
    return { chatId: legacyChat.id, messageId: legacyMessageId };
  }

  return null;
}

function extractInlineKeyboard(message: Message): Button[][] {
  const replyMarkup = getRecord(message).reply_markup;
  if (!isRecord(replyMarkup) || !Array.isArray(replyMarkup.inline_keyboard)) return [];

  return replyMarkup.inline_keyboard
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => row.filter(isInlineKeyboardButton))
    .filter((row) => row.length > 0);
}

function isInlineKeyboardButton(value: unknown): value is Button {
  return isRecord(value) && typeof value.text === "string";
}

function isUrlButton(value: Button): value is InlineKeyboardButton.UrlButton {
  return "url" in value && typeof value.url === "string";
}

async function updateTargetMarkup(ctx: Context, target: ChannelButtonTarget) {
  const replyMarkup = target.buttons.length
    ? { inline_keyboard: target.buttons } satisfies InlineKeyboardMarkup
    : undefined;
  await ctx.api.editMessageReplyMarkup(
    target.chatId,
    target.messageId,
    replyMarkup ? { reply_markup: replyMarkup } : {}
  );
}

function getText(message: Message) {
  const record = getRecord(message);
  return typeof record.text === "string" ? record.text.trim() : "";
}

function parseButtonInput(input: string) {
  const separator = input.indexOf("-");
  if (separator < 1) return null;

  const text = input.slice(0, separator).trim().replace(/^#[prg]\s*/i, "").slice(0, 64);
  const url = normalizeButtonUrl(input.slice(separator + 1).trim());
  return text && url ? { text, url } : null;
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

function parseIndex(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function getRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
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

async function render(ctx: Context, text: string, keyboard: InlineKeyboard) {
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
