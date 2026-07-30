import type { Context } from "grammy";

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
