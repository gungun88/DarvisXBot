import type { Context } from "grammy";
import type { Chat as PrismaChat } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export const controlPermissionModes = [
  "all_admins",
  "can_promote_members",
  "creator",
  "can_restrict_members"
] as const;

export type ControlPermissionMode = (typeof controlPermissionModes)[number];

const controlPermissionsSettingKey = "control_permissions";

const requiredGroupPermissions = [
  { key: "can_delete_messages", label: "Delete messages" },
  { key: "can_restrict_members", label: "Restrict members" },
  { key: "can_invite_users", label: "Invite users" }
] as const;

const requiredChannelPermissions = [
  { key: "can_post_messages", label: "Post messages" },
  { key: "can_edit_messages", label: "Edit messages" },
  { key: "can_delete_messages", label: "Delete messages" },
  { key: "can_invite_users", label: "Invite users" }
] as const;

export async function isUserChatAdmin(ctx: Context, chatId: number, userId: number) {
  const member = await ctx.api.getChatMember(chatId, userId);
  return member.status === "creator" || member.status === "administrator";
}

export async function getControlPermissionMode(chatId: string): Promise<ControlPermissionMode> {
  const setting = await prisma.setting.findUnique({
    where: {
      chatId_key: {
        chatId,
        key: controlPermissionsSettingKey
      }
    }
  });
  const mode = setting?.value;
  return isControlPermissionMode(mode) ? mode : "all_admins";
}

export async function setControlPermissionMode(chatId: string, mode: ControlPermissionMode) {
  await prisma.setting.upsert({
    where: {
      chatId_key: {
        chatId,
        key: controlPermissionsSettingKey
      }
    },
    create: {
      chatId,
      key: controlPermissionsSettingKey,
      value: mode
    },
    update: {
      value: mode
    }
  });
}

export async function canConfigureChat(ctx: Context, chat: PrismaChat, userId: number) {
  const member = await ctx.api.getChatMember(Number(chat.telegramChatId), userId);
  if (member.status === "creator") return true;
  if (member.status !== "administrator") return false;

  const mode = await getControlPermissionMode(chat.id);
  if (mode === "all_admins") return true;

  const permissions = member as unknown as Record<string, unknown>;
  if (mode === "can_promote_members") return permissions.can_promote_members === true;
  if (mode === "can_restrict_members") return permissions.can_restrict_members === true;
  return false;
}

export function isControlPermissionMode(value: unknown): value is ControlPermissionMode {
  return typeof value === "string" && controlPermissionModes.includes(value as ControlPermissionMode);
}

export async function getBotPermissionReport(ctx: Context, chatId: number) {
  const botInfo = await ctx.api.getMe();
  const botMember = await ctx.api.getChatMember(chatId, botInfo.id);

  if (botMember.status === "creator") {
    return { canManageBaseFeatures: true, missingPermissions: [] as string[] };
  }

  if (botMember.status !== "administrator") {
    return { canManageBaseFeatures: false, missingPermissions: ["Bot is not an administrator"] };
  }

  const chat = await ctx.api.getChat(chatId);
  const requiredPermissions = chat.type === "channel" ? requiredChannelPermissions : requiredGroupPermissions;
  const member = botMember as unknown as Record<string, unknown>;

  const missingPermissions = requiredPermissions
    .filter(({ key }) => !Boolean(member[key]))
    .map(({ label }) => label);

  return {
    canManageBaseFeatures: missingPermissions.length === 0,
    missingPermissions
  };
}
