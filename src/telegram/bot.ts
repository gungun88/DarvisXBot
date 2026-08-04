import { Bot, InlineKeyboard, InputFile } from "grammy";
import type { Context } from "grammy";
import type { Chat, ChatInviteLink, ChatJoinRequest, ChatPermissions, InlineKeyboardMarkup, InlineQueryResult, Message, User } from "grammy/types";
import { deflateSync } from "node:zlib";
import {
  ChatStatsEventType,
  ChatStatus,
  GiveawayStatus,
  PointTransactionType,
  Prisma,
  RuleAction,
  RuleType,
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
import {
  canConfigureChat,
  getBotPermissionReport,
  getControlPermissionMode,
  isControlPermissionMode,
  isUserChatAdmin,
  setControlPermissionMode
} from "./permissions.js";
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
import {
  handleNightModeAction,
  handleNightModeMessage,
  handleNightModePrivateMessage,
  openNightModeMenu,
  rememberSelectedNightModeChat,
  startNightModeScheduler
} from "./night-mode.js";
import {
  clearSpeechCheckDraft,
  handleSpeechCheckAction,
  handleSpeechCheckMessage,
  handleSpeechCheckPrivateMessage,
  openSpeechCheckMenu,
  rememberSelectedSpeechCheckChat
} from "./speech-check.js";
import {
  clearAntiSpamDraft,
  handleAntiSpamCallback,
  handleAntiSpamEditedMessage,
  handleAntiSpamInputMessage,
  handleAntiSpamMessage,
  openAntiSpamMenu
} from "./anti-spam.js";
import {
  createJoinVerificationChallenge,
  isJoinVerifyMode,
  type JoinVerificationChallenge,
  type JoinVerifyMode
} from "./join-verification.js";

type Locale = "zh-CN" | "en";

type SettingRecord = Record<string, unknown>;

type ControlPermissionMode = "all_admins" | "can_promote_members" | "creator" | "can_restrict_members";

const controlPermissionCallbackTokens: Record<ControlPermissionMode, string> = {
  all_admins: "all",
  can_promote_members: "promote",
  creator: "creator",
  can_restrict_members: "restrict"
};

function controlPermissionModeFromCallbackToken(value: string | undefined): ControlPermissionMode | undefined {
  if (value === "all") return "all_admins";
  if (value === "promote") return "can_promote_members";
  if (value === "creator") return "creator";
  if (value === "restrict") return "can_restrict_members";
  return undefined;
}

type WelcomeSettings = {
  enabled: boolean;
  text: string;
  deleteAfterMinutes: number;
  mediaKind: PublishMediaKind | undefined;
  mediaFileId: string | undefined;
  buttonText: string;
  buttonUrl: string;
  buttons: AutoReplyButton[][] | undefined;
  replyKeyboard: string[][] | undefined;
  lastMessageIds: number[];
};

type JoinVerifySettings = {
  enabled: boolean;
  adminApproval: boolean;
  mode: JoinVerifyMode;
  durationMinutes: number;
  punishment: "kick" | "ban" | "mute";
};

type BlocklistBotPunishment = "off" | "warn" | "mute" | "kick" | "ban";

type BlocklistSettings = {
  blockBots: boolean;
  blockBotPunishment: BlocklistBotPunishment;
  banAfterLeave: boolean;
  blockFlashJoinLeave: boolean;
  blockFollowerRaid: boolean;
  flashWindowSeconds: number;
  raidWindowSeconds: number;
  raidJoinThreshold: number;
};

type InviteLinkSettings = {
  enabled: boolean;
  notify: boolean;
  createsJoinRequest: boolean;
  expireSeconds: number;
  memberLimit: number;
};

type InviteLinkInputField = "expireDays" | "memberLimit" | "resetUserId";

type InviteLinkInputDraft = {
  chatId: string;
  field: InviteLinkInputField;
};

type AutoDeleteEventKey = "join" | "leave" | "boost" | "pin" | "photo" | "title";

type AutoDeleteSettings = Record<AutoDeleteEventKey, boolean> & {
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

type BannedWordsPunishment = "warn" | "mute" | "kick" | "ban" | "delete_only";
type BannedWordsFinalPunishment = "mute" | "kick" | "ban";

type BannedWordsSettings = {
  enabled: boolean;
  punishment: BannedWordsPunishment;
  warningPunishment: BannedWordsFinalPunishment;
  warningLimit: number;
  muteMinutes: number;
  deleteNotice: boolean;
  noticeDeleteSeconds: number;
};

type BannedWordsInputStage = "add" | "delete" | "mute_duration";

type BannedWordsInputDraft = {
  chatId: string;
  stage: BannedWordsInputStage;
};

type GroupCommandKey = "link" | "sign_in" | "points_rank" | "points" | "stat" | "stat_week" | "stats" | "lottery";

type GroupCommandSettings = {
  commands: Record<GroupCommandKey, boolean>;
  aliases: Record<GroupCommandKey, string[]>;
};

type GroupCommandAliasInputDraft = {
  chatId: string;
  command: GroupCommandKey;
  mode: "add" | "delete";
};

type PointsRuleField =
  | "signInPoints"
  | "deleteSignInSeconds"
  | "speechPoints"
  | "speechDailyLimit"
  | "speechMinLength"
  | "invitePoints"
  | "inviteDailyLimit";

type PointsSettings = {
  enabled: boolean;
  deleteSignInMessage: boolean;
  deleteSignInSeconds: number;
  signInPoints: number;
  speechPoints: number;
  speechDailyLimit: number;
  speechMinLength: number;
  invitePoints: number;
  inviteDailyLimit: number;
};

type PointProduct = {
  id: string;
  name: string;
  cost: number;
  listed: boolean;
  codes: string[];
  soldCount: number;
  dailyLimit: number;
};

type PointExchangeSettings = {
  enabled: boolean;
  keyword: string;
  products: PointProduct[];
};

type PointsInputDraft =
  | {
      chatId: string;
      kind: "alias";
      command: Extract<GroupCommandKey, "points" | "points_rank">;
    }
  | {
      chatId: string;
      kind: "exchange_keyword";
    }
  | {
      chatId: string;
      kind: "product_name" | "product_cost" | "product_codes" | "product_daily_limit";
      productId: string;
    }
  | {
      chatId: string;
      kind: "adjust_user";
    }
  | {
      chatId: string;
      kind: "adjust_amount";
      targetUserId: string;
    };

type GiveawayCreateType = "common" | "points" | "active" | "invite" | "report" | "fun";
type GiveawayDrawMode = "full" | "timed";
type GiveawayInputStage = "target_count" | "draw_at" | "details";

type GiveawayInputDraft = {
  chatId: string;
  type: GiveawayCreateType;
  drawMode?: GiveawayDrawMode;
  stage: GiveawayInputStage;
  targetCount?: number;
  drawAt?: Date;
};

type CommonGiveawayRequirements = {
  type: "common";
  entry: "keyword";
  keyword: string;
  drawMode: GiveawayDrawMode;
  targetCount?: number;
};

type MemberStatsSnapshot = {
  date: string;
  count: number;
  collectedAt: string;
};

type MemberStatsSettings = {
  enabled: boolean;
  lastCollectedDate: string | undefined;
  lastCount: number | undefined;
  snapshots: MemberStatsSnapshot[];
};

type GroupMembersSettings = {
  watchNicknameChange: boolean;
  watchUsernameChange: boolean;
  unpinLinkedChannelMessages: boolean;
};

type StoredUserProfile = {
  telegramUserId: bigint;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
};

type UserProfileChange = {
  previous: StoredUserProfile;
  current: StoredUserProfile;
  nicknameChanged: boolean;
  usernameChanged: boolean;
};

type PendingVerification = {
  chatId: number;
  userId: number;
  messageId: number;
  timeout: NodeJS.Timeout;
  answer?: string;
};

type TelegramApi = Context["api"];

type StoredJoinVerification = {
  id: string;
  chatId: string;
  telegramChatId: bigint;
  telegramUserId: bigint;
  messageId: number;
  mode: string;
  answer: string;
  punishment: JoinVerifySettings["punishment"];
  expiresAt: Date;
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

type AutoReplyInputStage = "keyword" | "response" | "buttons" | "trigger" | "delete";

type AutoReplyInputDraft = {
  chatId: string;
  stage: AutoReplyInputStage;
  keyword?: string;
  matchType?: "exact" | "contains";
  response?: string;
  mediaKind?: AutoReplyMediaKind;
  mediaFileId?: string;
  buttons?: AutoReplyButton[][];
};

type WelcomeInputField = "text" | "media" | "button";

type WelcomeInputDraft = {
  chatId: string;
  field: WelcomeInputField;
};

type ImportConfigDraft = {
  targetChatId: string;
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
  { command: "clear", description: "关闭底部键盘" },
  { command: "cancel", description: "取消当前操作" },
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

const legacyDefaultWelcomeText = "欢迎 {name} 加入 {chat}！";
const defaultWelcomeText = "👏 欢迎 {MENTION} 加入本群";

const defaultWelcomeSettings: WelcomeSettings = {
  enabled: false,
  text: defaultWelcomeText,
  deleteAfterMinutes: 0,
  mediaKind: undefined,
  mediaFileId: undefined,
  buttonText: "",
  buttonUrl: "",
  buttons: undefined,
  replyKeyboard: undefined,
  lastMessageIds: []
};

const defaultJoinVerifySettings: JoinVerifySettings = {
  enabled: false,
  adminApproval: false,
  mode: "button",
  durationMinutes: 1,
  punishment: "mute"
};

const defaultBlocklistSettings: BlocklistSettings = {
  blockBots: false,
  blockBotPunishment: "off",
  banAfterLeave: false,
  blockFlashJoinLeave: false,
  blockFollowerRaid: false,
  flashWindowSeconds: 120,
  raidWindowSeconds: 60,
  raidJoinThreshold: 10
};

const defaultInviteLinkSettings: InviteLinkSettings = {
  enabled: false,
  notify: false,
  createsJoinRequest: false,
  expireSeconds: 0,
  memberLimit: 0
};

const autoDeleteEventKeys = ["join", "leave", "boost", "pin", "photo", "title"] as const satisfies readonly AutoDeleteEventKey[];

function isAutoDeleteEventKey(value: string | undefined): value is AutoDeleteEventKey {
  return autoDeleteEventKeys.includes(value as AutoDeleteEventKey);
}

const defaultAutoDeleteSettings: AutoDeleteSettings = {
  enabled: true,
  join: false,
  leave: false,
  boost: false,
  pin: true,
  photo: true,
  title: true,
  seconds: 0
};

const defaultAutoReplySettings: AutoReplySettings = {
  enabled: true,
  deleteAfterMinutes: 0,
  deletePreviousMessage: true,
  rules: []
};

const defaultBannedWordsSettings: BannedWordsSettings = {
  enabled: false,
  punishment: "warn",
  warningPunishment: "mute",
  warningLimit: 3,
  muteMinutes: 60,
  deleteNotice: true,
  noticeDeleteSeconds: 60
};

const groupCommandDefinitions: Array<{ key: GroupCommandKey; command: string; zh: string; en: string }> = [
  { key: "link", command: "/link", zh: "邀请链接", en: "Invite link" },
  { key: "sign_in", command: "/sign_in", zh: "群组签到", en: "Sign in" },
  { key: "points_rank", command: "/points_rank", zh: "积分排名", en: "Points ranking" },
  { key: "points", command: "/points", zh: "增减积分", en: "Adjust points" },
  { key: "stat", command: "/stat", zh: "今日活跃统计", en: "Today stats" },
  { key: "stat_week", command: "/stat_week", zh: "周活跃统计", en: "Week stats" },
  { key: "stats", command: "/stats", zh: "自定义活跃统计", en: "Custom stats" },
  { key: "lottery", command: "/lottery", zh: "抽奖列表", en: "Giveaway list" }
];

const defaultGroupCommandSettings: GroupCommandSettings = {
  commands: Object.fromEntries(groupCommandDefinitions.map((item) => [item.key, true])) as Record<GroupCommandKey, boolean>,
  aliases: {
    link: [],
    sign_in: [],
    points_rank: ["积分排名"],
    points: ["积分"],
    stat: [],
    stat_week: [],
    stats: [],
    lottery: []
  }
};

const defaultPointsSettings: PointsSettings = {
  enabled: false,
  deleteSignInMessage: false,
  deleteSignInSeconds: 60,
  signInPoints: 1,
  speechPoints: 1,
  speechDailyLimit: 50,
  speechMinLength: 5,
  invitePoints: 1,
  inviteDailyLimit: 0
};

const defaultPointExchangeSettings: PointExchangeSettings = {
  enabled: false,
  keyword: "积分兑换",
  products: []
};

const defaultMemberStatsSettings: MemberStatsSettings = {
  enabled: false,
  lastCollectedDate: undefined,
  lastCount: undefined,
  snapshots: []
};

const defaultGroupMembersSettings: GroupMembersSettings = {
  watchNicknameChange: false,
  watchUsernameChange: false,
  unpinLinkedChannelMessages: false
};

const importableSettingKeys = [
  "welcome",
  "blocklist",
  "invite_links",
  "join_verify",
  "auto_delete",
  "auto_reply",
  "banned_words",
  "group_commands",
  "points",
  "point_exchange",
  "member_stats",
  "group_members",
  "new_member_limit",
  "open_close",
  "adult_check",
  "speech_check",
  "anti_spam",
  "control_permissions"
] as const;

const importableSettingKeySet = new Set<string>(importableSettingKeys);

const pendingVerifications = new Map<string, PendingVerification>();
const recentJoins = new Map<string, number>();
const raidJoinEvents = new Map<string, number[]>();
const bannedWordWarnings = new Map<string, { count: number; expiresAt: number }>();
const timezoneInputUsers = new Set<number>();
const publishDrafts = new Map<number, PublishDraft>();
const scheduledInputDrafts = new Map<number, ScheduledInputDraft>();
const autoReplyInputDrafts = new Map<number, AutoReplyInputDraft>();
const autoReplySelectedChats = new Map<number, string>();
const bannedWordsInputDrafts = new Map<number, BannedWordsInputDraft>();
const groupCommandAliasInputDrafts = new Map<number, GroupCommandAliasInputDraft>();
const pointsInputDrafts = new Map<number, PointsInputDraft>();
const welcomeInputDrafts = new Map<number, WelcomeInputDraft>();
const inviteLinkInputDrafts = new Map<number, InviteLinkInputDraft>();
const giveawayInputDrafts = new Map<number, GiveawayInputDraft>();
const importConfigDrafts = new Map<number, ImportConfigDraft>();
const userProfileChanges = new Map<number, UserProfileChange>();
const memberStatsShareCache = new Map<string, {
  photoFileId: string;
  caption: string;
  title: string;
  updatedAt: number;
}>();

function rememberSelectedChatForModules(userId: number | undefined, chatId: string) {
  if (typeof userId !== "number") return;
  autoReplySelectedChats.set(userId, chatId);
  rememberSelectedNewMemberLimitChat(userId, chatId);
  rememberSelectedOpenCloseChat(userId, chatId);
  rememberSelectedAdultCheckChat(userId, chatId);
  rememberSelectedNightModeChat(userId, chatId);
  rememberSelectedSpeechCheckChat(userId, chatId);
}

export function createBot(config: AppConfig) {
  const bot = new Bot(config.botToken);
  startNightModeScheduler(bot);

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
      try {
        const previousUser = await prisma.user.findUnique({
          where: { telegramUserId: BigInt(ctx.from.id) },
          select: {
            telegramUserId: true,
            username: true,
            firstName: true,
            lastName: true
          }
        });
        const currentUser = await upsertTelegramUser(ctx.from, config.defaultTimezone);
        if (previousUser) {
          const profileChange = buildUserProfileChange(previousUser, currentUser);
          if (profileChange.nicknameChanged || profileChange.usernameChanged) {
            userProfileChanges.set(ctx.from.id, profileChange);
          }
        }
      } catch (error) {
        console.error("Failed to upsert Telegram user", error);
      }
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
        "可用变量：<code>{NAME}</code>、<code>{MENTION}</code>、<code>{GROUPNAME}</code>。"
      ].join("\n"),
      { parse_mode: "HTML" }
    );
  });

  bot.command("clear", async (ctx) => {
    const locale = await getLocale(ctx);
    await ctx.reply(locale === "zh-CN" ? "已关闭底部键盘。" : "Reply keyboard cleared.", {
      reply_markup: { remove_keyboard: true }
    });
  });

  bot.command("cancel", async (ctx) => {
    await handleCancelCommand(ctx, config);
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

  bot.callbackQuery(/^import_config:/, async (ctx) => {
    await handleImportConfigCallback(ctx);
  });

  bot.callbackQuery(/^invite:/, async (ctx) => {
    await handleInviteLinkCallback(ctx);
  });

  bot.callbackQuery(/^group_stats:/, async (ctx) => {
    await handleGroupStatsCallback(ctx);
  });

  bot.callbackQuery(/^member_stats:/, async (ctx) => {
    await handleMemberStatsCallback(ctx);
  });

  bot.callbackQuery(/^group_members:/, async (ctx) => {
    await handleGroupMembersCallback(ctx);
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

  bot.callbackQuery(/^control_permissions:/, async (ctx) => {
    await handleControlPermissionsCallback(ctx);
  });

  bot.callbackQuery(/^auto_delete:/, async (ctx) => {
    await handleAutoDeleteCallback(ctx);
  });

  bot.callbackQuery(/^auto_reply:/, async (ctx) => {
    await handleAutoReplyCallback(ctx, config);
  });

  bot.callbackQuery(/^banned_words:/, async (ctx) => {
    await handleBannedWordsCallback(ctx);
  });

  bot.callbackQuery(/^group_commands:/, async (ctx) => {
    await handleGroupCommandsCallback(ctx);
  });

  bot.callbackQuery(/^points:/, async (ctx) => {
    await handlePointsCallback(ctx);
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

  bot.callbackQuery(/^night_mode:/, async (ctx) => {
    await handleNightModeCallback(ctx);
  });

  bot.callbackQuery(/^speech_check:/, async (ctx) => {
    await handleSpeechCheckCallback(ctx);
  });

  bot.callbackQuery(/^anti_spam:/, async (ctx) => {
    await handleAntiSpamCallback(ctx);
  });

  bot.callbackQuery(/^verify:/, async (ctx) => {
    await handleVerificationCallback(ctx);
  });

  bot.callbackQuery(/^giveaway:join:/, async (ctx) => {
    await handleGiveawayJoinCallback(ctx, config);
  });

  bot.callbackQuery(/^giveaway:/, async (ctx) => {
    await handleGiveawayCallback(ctx, config);
  });

  bot.inlineQuery(/.*/, async (ctx) => {
    await handlePublishInlineQuery(ctx);
  });

  bot.on("chat_join_request", async (ctx) => {
    await handleChatJoinRequest(ctx, config);
  });

  bot.on("message", async (ctx) => {
    const locale = await getLocale(ctx);
    if (await handleAntiSpamInputMessage(ctx, locale)) return;
    if (await handleBannedWordsInputMessage(ctx, locale)) return;
    if (await handlePointsInputMessage(ctx, config, locale)) return;
    if (await handleGroupCommandAliasInputMessage(ctx, locale)) return;
    if (await handleAutoReplyInputMessage(ctx, locale)) return;
    if (await handleWelcomeInputMessage(ctx, locale)) return;
    if (await handleInviteLinkInputMessage(ctx, locale)) return;
    if (await handleGiveawayInputMessage(ctx, config, locale)) return;
    if (await handleImportConfigInputMessage(ctx, locale)) return;
    if (await handleTimezoneInputMessage(ctx, config, locale)) return;
    if (await handleScheduledInputMessage(ctx, locale)) return;
    if (await handlePublishInputMessage(ctx, locale)) return;
    if (await handleNewMemberLimitPrivateMessage(ctx, config, locale)) return;
    if (await handleOpenClosePrivateMessage(ctx, config, locale)) return;
    if (await handleNightModePrivateMessage(ctx, locale)) return;
    if (await handleSpeechCheckPrivateMessage(ctx, locale)) return;
    if (await handleNightModeMessage(ctx)) return;
    if (await handleOpenCloseGroupMessage(ctx)) return;
    if (await handleSpeechCheckMessage(ctx, locale)) return;
    if (await handleAdultCheckMessage(ctx, locale)) return;
    if (await handleGiveawayKeywordEntry(ctx, config, locale)) return;
    await handleIncomingMessage(ctx, config);
  });

  bot.on("edited_message", async (ctx) => {
    const locale = await getLocale(ctx);
    await handleAntiSpamEditedMessage(ctx, locale);
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

  void recoverPendingJoinVerifications(bot.api);
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
  if (payload === "_CommandHelp") {
    await ctx.reply(commandHelpText(locale), { parse_mode: "HTML" });
    return;
  }

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
  bannedWordsInputDrafts.delete(userId);
  groupCommandAliasInputDrafts.delete(userId);
  pointsInputDrafts.delete(userId);
  welcomeInputDrafts.delete(userId);
  inviteLinkInputDrafts.delete(userId);
  giveawayInputDrafts.delete(userId);
  importConfigDrafts.delete(userId);
  clearAntiSpamDraft(userId);
  clearSpeechCheckDraft(userId);
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

function commandHelpText(locale: Locale) {
  const lines = botCommands.map((item) => `/${item.command} - ${escapeHtml(item.description)}`);
  return locale === "zh-CN"
    ? ["<b>命令帮助</b>", "", ...lines].join("\n")
    : ["<b>Command help</b>", "", ...lines].join("\n");
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

function blocklistKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "🤖 屏蔽机器人" : "🤖 Block bots", `blocklist:menu:bots:${chatId}`)
    .text(locale === "zh-CN" ? "🚪 退群封禁" : "🚪 Ban leavers", `blocklist:menu:leave:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "🏃 屏蔽闪进闪退" : "🏃 Block flash join/leave", `blocklist:menu:flash:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "👨‍👩‍👧‍👦 屏蔽刷粉攻击" : "👨‍👩‍👧‍👦 Block join raids", `blocklist:menu:raid:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "🏠 返回首页" : "🏠 Home", "menu:home");
}

function blocklistBotKeyboard(chatId: string, settings: BlocklistSettings, locale: Locale) {
  const selected = (value: BlocklistBotPunishment, label: string) => settings.blockBotPunishment === value ? `✅${label}` : label;
  return new InlineKeyboard()
    .text(selected("off", locale === "zh-CN" ? "关闭" : "Off"), `blocklist:bot:${chatId}:off`)
    .text(selected("warn", locale === "zh-CN" ? "警告" : "Warn"), `blocklist:bot:${chatId}:warn`)
    .text(selected("mute", locale === "zh-CN" ? "禁言" : "Mute"), `blocklist:bot:${chatId}:mute`)
    .row()
    .text(selected("kick", locale === "zh-CN" ? "踢出" : "Kick"), `blocklist:bot:${chatId}:kick`)
    .text(selected("ban", locale === "zh-CN" ? "封禁" : "Ban"), `blocklist:bot:${chatId}:ban`)
    .row()
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `blocklist:back:${chatId}`);
}

function blocklistLeaveKeyboard(chatId: string, settings: BlocklistSettings, locale: Locale) {
  const selected = (active: boolean, label: string) => active ? `✅${label}` : label;
  return new InlineKeyboard()
    .text(selected(!settings.banAfterLeave, locale === "zh-CN" ? "关闭" : "Off"), `blocklist:leave:${chatId}:off`)
    .text(selected(settings.banAfterLeave, locale === "zh-CN" ? "🚷封禁" : "🚷 Ban"), `blocklist:leave:${chatId}:ban`)
    .row()
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `blocklist:back:${chatId}`);
}

function blocklistPremiumKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "💎订阅会员" : "💎 Memberships", "menu:memberships")
    .row()
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `blocklist:back:${chatId}`);
}

function inviteLinkKeyboard(chatId: string, settings: InviteLinkSettings, locale: Locale) {
  const selected = (active: boolean, label: string) => active ? `✅${label}` : label;
  const labels = locale === "zh-CN"
    ? {
        status: "状态:",
        notify: "邀请提醒:",
        approval: "链接审核：",
        on: "开启",
        off: "关闭",
        expire: "🔧链接过期时间",
        limit: "🔧最大邀请人数",
        export: "🖨导出",
        clear: "🗑清空数据",
        reset: "🧹重置链接",
        home: "🏠返回首页"
      }
    : {
        status: "Status:",
        notify: "Invite notice:",
        approval: "Link approval:",
        on: "On",
        off: "Off",
        expire: "🔧Link expiration",
        limit: "🔧Member limit",
        export: "🖨Export",
        clear: "🗑Clear data",
        reset: "🧹Reset links",
        home: "🏠Home"
      };

  return new InlineKeyboard()
    .text(labels.status, `invite:noop:${chatId}`)
    .text(selected(settings.enabled, labels.on), `invite:status:${chatId}:on`)
    .text(selected(!settings.enabled, labels.off), `invite:status:${chatId}:off`)
    .row()
    .text(labels.notify, `invite:noop:${chatId}`)
    .text(selected(settings.notify, labels.on), `invite:notify:${chatId}:on`)
    .text(selected(!settings.notify, labels.off), `invite:notify:${chatId}:off`)
    .row()
    .text(labels.approval, `invite:noop:${chatId}`)
    .text(selected(settings.createsJoinRequest, labels.on), `invite:approval:${chatId}:on`)
    .text(selected(!settings.createsJoinRequest, labels.off), `invite:approval:${chatId}:off`)
    .row()
    .text(`${labels.expire}（${formatInviteExpire(settings.expireSeconds, locale)}）`, `invite:expire:${chatId}`)
    .row()
    .text(`${labels.limit}（${settings.memberLimit || (locale === "zh-CN" ? "无限制" : "Unlimited")}）`, `invite:limit:${chatId}`)
    .row()
    .text(labels.export, `invite:export:${chatId}`)
    .text(labels.clear, `invite:clear:${chatId}`)
    .row()
    .text(labels.reset, `invite:reset:${chatId}`)
    .row()
    .text(labels.home, "menu:home");
}

function welcomeKeyboard(chatId: string, settings: WelcomeSettings, locale: Locale) {
  const selected = (active: boolean, label: string) => active ? `✅${label}` : label;
  const labels = locale === "zh-CN"
    ? {
        status: "状态:",
        on: "开启",
        off: "关闭",
        deleteAfter: "删除消息(分钟)⬇️",
        no: "否",
        deleteLast: "删除上一条",
        preview: "👀预览消息",
        editText: "📃修改文本",
        editMedia: "📷修改媒体",
        editButton: "🔠修改按钮",
        back: "🔙返回"
      }
    : {
        status: "Status:",
        on: "On",
        off: "Off",
        deleteAfter: "Delete message (minutes)⬇️",
        no: "No",
        deleteLast: "Delete previous",
        preview: "👀 Preview",
        editText: "📃 Edit text",
        editMedia: "📷 Edit media",
        editButton: "🔠 Edit button",
        back: "🔙 Back"
      };

  return new InlineKeyboard()
    .text(labels.status, `welcome:noop:${chatId}`)
    .text(selected(settings.enabled, labels.on), `welcome:status:${chatId}:on`)
    .text(selected(!settings.enabled, labels.off), `welcome:status:${chatId}:off`)
    .row()
    .text(labels.deleteAfter, `welcome:noop:${chatId}`)
    .row()
    .text(selected(settings.deleteAfterMinutes === 0, labels.no), `welcome:delete_after:${chatId}:0`)
    .text(selected(settings.deleteAfterMinutes === 1, "1"), `welcome:delete_after:${chatId}:1`)
    .text(selected(settings.deleteAfterMinutes === 5, "5"), `welcome:delete_after:${chatId}:5`)
    .text(selected(settings.deleteAfterMinutes === 10, "10"), `welcome:delete_after:${chatId}:10`)
    .row()
    .text(labels.deleteLast, `welcome:delete_last:${chatId}`)
    .row()
    .text(labels.preview, `welcome:preview:${chatId}`)
    .row()
    .text(labels.editText, `welcome:edit:${chatId}:text`)
    .text(labels.editMedia, `welcome:edit:${chatId}:media`)
    .row()
    .text(labels.editButton, `welcome:edit:${chatId}:button`)
    .row()
    .text(labels.back, `menu:chat:group:${chatId}`);
}

function welcomeInputKeyboard(chatId: string, _field: WelcomeInputField, locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `chat_feature:welcome:${chatId}`);
}

function welcomeSavedKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `chat_feature:welcome:${chatId}`);
}

function joinVerifyKeyboard(chatId: string, settings: JoinVerifySettings, locale: Locale) {
  const selected = (active: boolean, label: string) => active ? `✅${label}` : label;
  const text = locale === "zh-CN"
    ? {
        status: "状态:",
        on: "开启",
        off: "关闭",
        approval: "管理员审批:",
        mode: "模式:",
        button: "按钮",
        math: "数学题",
        captcha: "数字验证码",
        emoji: "Emoji识别",
        duration: "验证时长:",
        mute: "禁言",
        kick: "踢出",
        punishment: "超时惩罚:",
        back: "🔙 返回"
      }
    : {
        status: "Status:",
        on: "On",
        off: "Off",
        approval: "Admin approval:",
        mode: "Mode:",
        button: "Button",
        math: "Math",
        captcha: "Number captcha",
        emoji: "Emoji",
        duration: "Duration:",
        mute: "Mute",
        kick: "Kick",
        punishment: "Timeout:",
        back: "🔙 Back"
      };

  return new InlineKeyboard()
    .text(text.status, `join_verify:noop:${chatId}`)
    .text(selected(settings.enabled, text.on), `join_verify:status:on:${chatId}`)
    .text(selected(!settings.enabled, text.off), `join_verify:status:off:${chatId}`)
    .row()
    .text(text.approval, `join_verify:noop:${chatId}`)
    .text(selected(settings.adminApproval, text.on), `join_verify:approval:on:${chatId}`)
    .text(selected(!settings.adminApproval, text.off), `join_verify:approval:off:${chatId}`)
    .row()
    .text(text.mode, `join_verify:noop:${chatId}`)
    .text(selected(settings.mode === "button", text.button), `join_verify:mode:button:${chatId}`)
    .text(selected(settings.mode === "math", text.math), `join_verify:mode:math:${chatId}`)
    .text(selected(settings.mode === "captcha", text.captcha), `join_verify:mode:captcha:${chatId}`)
    .row()
    .text(selected(settings.mode === "emoji", text.emoji), `join_verify:mode:emoji:${chatId}`)
    .row()
    .text(text.duration, `join_verify:noop:${chatId}`)
    .text(selected(settings.durationMinutes === 1, locale === "zh-CN" ? "1分钟" : "1m"), `join_verify:duration:1:${chatId}`)
    .text(selected(settings.durationMinutes === 5, locale === "zh-CN" ? "5分钟" : "5m"), `join_verify:duration:5:${chatId}`)
    .text(selected(settings.durationMinutes === 10, locale === "zh-CN" ? "10分钟" : "10m"), `join_verify:duration:10:${chatId}`)
    .row()
    .text(text.punishment, `join_verify:noop:${chatId}`)
    .text(selected(settings.punishment === "mute", text.mute), `join_verify:punishment:mute:${chatId}`)
    .text(selected(settings.punishment === "kick", text.kick), `join_verify:punishment:kick:${chatId}`)
    .row()
    .text(text.back, `menu:chat:group:${chatId}`);
}

function autoDeleteKeyboard(chatId: string, settings: AutoDeleteSettings, locale: Locale) {
  const keyboard = new InlineKeyboard();
  const labels = autoDeleteLabels(locale);
  const mark = (active: boolean, label: string) => active ? `✅${label}` : label;

  for (const key of autoDeleteEventKeys) {
    keyboard
      .text(labels[key], `auto_delete:noop:${chatId}`)
      .text(mark(settings[key], labels.on), `auto_delete:set:${key}:on:${chatId}`)
      .text(mark(!settings[key], labels.off), `auto_delete:set:${key}:off:${chatId}`)
      .row();
  }

  return keyboard.text(labels.back, `menu:chat:group:${chatId}`);
}

function autoDeleteLabels(locale: Locale): Record<AutoDeleteEventKey | "on" | "off" | "back", string> {
  return locale === "zh-CN"
    ? {
        join: "进群：",
        leave: "退群：",
        boost: "助推消息",
        pin: "置顶：",
        photo: "修改头像：",
        title: "修改名称：",
        on: "开启",
        off: "关闭",
        back: "🔙返回"
      }
    : {
        join: "Join:",
        leave: "Leave:",
        boost: "Boost:",
        pin: "Pin:",
        photo: "Photo:",
        title: "Title:",
        on: "On",
        off: "Off",
        back: "🔙 Back"
      };
}

function autoReplyKeyboard(chatId: string, settings: AutoReplySettings, locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "状态:" : "Status:", `auto_reply:noop:${chatId}`)
    .text(settings.enabled ? "✅启用" : "启用", `auto_reply:toggle:${chatId}:on`)
    .text(!settings.enabled ? "✅关闭" : "关闭", `auto_reply:toggle:${chatId}:off`)
    .row()
    .text(locale === "zh-CN" ? "删除消息(分钟) ⤵︎" : "Delete reply (minutes) ⤵︎", `auto_reply:noop:${chatId}`)
    .row()
    .text(settings.deleteAfterMinutes === 0 ? "✅否" : "否", `auto_reply:delete_after:${chatId}:0`)
    .text(settings.deleteAfterMinutes === 1 ? "✅1" : "1", `auto_reply:delete_after:${chatId}:1`)
    .text(settings.deleteAfterMinutes === 5 ? "✅5" : "5", `auto_reply:delete_after:${chatId}:5`)
    .text(settings.deleteAfterMinutes === 10 ? "✅10" : "10", `auto_reply:delete_after:${chatId}:10`)
    .text(settings.deleteAfterMinutes === 30 ? "✅30" : "30", `auto_reply:delete_after:${chatId}:30`)
    .row()
    .text(locale === "zh-CN" ? "✍ 添加" : "✍ Add", `auto_reply:add:${chatId}`)
    .text(locale === "zh-CN" ? "🗑 删除" : "🗑 Delete", `auto_reply:delete:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `menu:chat:group:${chatId}`);
}

function bannedWordsKeyboard(chatId: string, settings: BannedWordsSettings, locale: Locale) {
  const selected = (active: boolean, label: string) => active ? `✅${label}` : label;
  const labels = locale === "zh-CN"
    ? {
        mode: "模式:",
        on: "开启",
        off: "关闭",
        add: "➕添加",
        list: "📋列表",
        punishment: "🚷惩罚",
        deleteNotice: "♻️删除提醒",
        back: "🔙返回"
      }
    : {
        mode: "Mode:",
        on: "On",
        off: "Off",
        add: "➕ Add",
        list: "📋 List",
        punishment: "🚷 Punishment",
        deleteNotice: "♻️ Delete notice",
        back: "🔙 Back"
      };

  return new InlineKeyboard()
    .text(labels.mode, `banned_words:noop:${chatId}`)
    .text(selected(settings.enabled, labels.on), `banned_words:status:${chatId}:on`)
    .text(selected(!settings.enabled, labels.off), `banned_words:status:${chatId}:off`)
    .row()
    .text(labels.add, `banned_words:add:${chatId}`)
    .row()
    .text(labels.list, `banned_words:list:${chatId}`)
    .row()
    .text(labels.punishment, `banned_words:punishment:${chatId}`)
    .text(bannedWordsNoticeStatusLabel(settings, labels.deleteNotice), `banned_words:notice:${chatId}`)
    .row()
    .text(labels.back, `menu:chat:group:${chatId}`);
}

function bannedWordsListKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "🗑删除" : "🗑 Delete", `banned_words:delete:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `chat_feature:banned_words:${chatId}`);
}

function bannedWordsDeleteKeyboard(chatId: string, rules: Awaited<ReturnType<typeof listBannedWordRules>>, locale: Locale) {
  const keyboard = new InlineKeyboard();
  rules.slice(0, 80).forEach((rule, index) => {
    keyboard.text(`${index + 1}. ${rule.pattern}`.slice(0, 64), `banned_words:delete_rule:${chatId}:${rule.id}`).row();
  });
  return keyboard.text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `chat_feature:banned_words:${chatId}`);
}

function bannedWordsCancelKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `banned_words:cancel:${chatId}`);
}

function bannedWordsDoneKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `chat_feature:banned_words:${chatId}`);
}

function bannedWordsPunishmentKeyboard(chatId: string, settings: BannedWordsSettings, locale: Locale) {
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
        muteDuration: "🔇🕘设置禁言时长",
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
        muteDuration: "🔇🕘Set mute duration",
        back: "🔙 Back"
      };

  return new InlineKeyboard()
    .text(selected(settings.punishment === "warn", labels.warn), `banned_words:punishment:${chatId}:warn`)
    .text(selected(settings.punishment === "mute", labels.mute), `banned_words:punishment:${chatId}:mute`)
    .text(selected(settings.punishment === "kick", labels.kick), `banned_words:punishment:${chatId}:kick`)
    .row()
    .text(selected(settings.punishment === "ban", labels.ban), `banned_words:punishment:${chatId}:ban`)
    .text(selected(settings.punishment === "delete_only", labels.deleteOnly), `banned_words:punishment:${chatId}:delete_only`)
    .row()
    .text(labels.warningLimit, `banned_words:noop:${chatId}`)
    .row()
    .text(selected(settings.warningLimit === 1, "1"), `banned_words:warning_limit:${chatId}:1`)
    .text(selected(settings.warningLimit === 2, "2"), `banned_words:warning_limit:${chatId}:2`)
    .text(selected(settings.warningLimit === 3, "3"), `banned_words:warning_limit:${chatId}:3`)
    .text(selected(settings.warningLimit === 4, "4"), `banned_words:warning_limit:${chatId}:4`)
    .text(selected(settings.warningLimit === 5, "5"), `banned_words:warning_limit:${chatId}:5`)
    .row()
    .text(labels.warnAfter, `banned_words:noop:${chatId}`)
    .row()
    .text(selected(settings.warningPunishment === "mute", labels.mute), `banned_words:warn_action:${chatId}:mute`)
    .text(selected(settings.warningPunishment === "kick", labels.kick), `banned_words:warn_action:${chatId}:kick`)
    .text(selected(settings.warningPunishment === "ban", labels.ban), `banned_words:warn_action:${chatId}:ban`)
    .row()
    .text(labels.muteDuration, `banned_words:mute_duration:${chatId}`)
    .row()
    .text(labels.back, `chat_feature:banned_words:${chatId}`);
}

function bannedWordsMuteDurationKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "⛔永久禁言" : "⛔ Permanent mute", `banned_words:mute_forever:${chatId}`)
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `banned_words:punishment:${chatId}`);
}

function bannedWordsNoticeKeyboard(chatId: string, settings: BannedWordsSettings, locale: Locale) {
  const selected = (active: boolean, label: string) => active ? `✅${label}` : label;
  const option = (seconds: number, label: string) => selected(settings.noticeDeleteSeconds === seconds, label);
  return new InlineKeyboard()
    .text(option(10, locale === "zh-CN" ? "10秒" : "10s"), `banned_words:notice_delay:${chatId}:10`)
    .text(option(30, locale === "zh-CN" ? "30秒" : "30s"), `banned_words:notice_delay:${chatId}:30`)
    .text(option(60, locale === "zh-CN" ? "60秒" : "60s"), `banned_words:notice_delay:${chatId}:60`)
    .row()
    .text(option(300, locale === "zh-CN" ? "5分钟" : "5m"), `banned_words:notice_delay:${chatId}:300`)
    .text(option(600, locale === "zh-CN" ? "10分钟" : "10m"), `banned_words:notice_delay:${chatId}:600`)
    .text(option(1800, locale === "zh-CN" ? "30分钟" : "30m"), `banned_words:notice_delay:${chatId}:1800`)
    .row()
    .text(option(3600, locale === "zh-CN" ? "1小时" : "1h"), `banned_words:notice_delay:${chatId}:3600`)
    .text(option(21600, locale === "zh-CN" ? "6小时" : "6h"), `banned_words:notice_delay:${chatId}:21600`)
    .text(option(43200, locale === "zh-CN" ? "12小时" : "12h"), `banned_words:notice_delay:${chatId}:43200`)
    .row()
    .text(selected(settings.noticeDeleteSeconds === 0, locale === "zh-CN" ? "不删除" : "Do not delete"), `banned_words:notice_delay:${chatId}:0`)
    .text(selected(settings.noticeDeleteSeconds < 0, locale === "zh-CN" ? "不提醒" : "Do not notify"), `banned_words:notice_delay:${chatId}:-1`)
    .row()
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `chat_feature:banned_words:${chatId}`);
}

function autoReplyDeleteKeyboard(chatId: string, settings: AutoReplySettings, locale: Locale) {
  const keyboard = new InlineKeyboard();
  settings.rules.forEach((rule, index) => {
    const prefix = rule.matchType === "exact" ? "-" : "*";
    keyboard.text(`${index + 1}. ${prefix}${rule.keyword}`.slice(0, 64), `auto_reply:delete_rule:${chatId}:${rule.id}`).row();
  });
  return keyboard.text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `chat_feature:auto_reply:${chatId}`);
}

function autoReplyCancelKeyboard(_chatId: string, locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", "auto_reply:cancel");
}

function autoReplyDoneKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `chat_feature:auto_reply:${chatId}`);
}

function autoReplyButtonsKeyboard(_chatId: string, locale: Locale) {
  return new InlineKeyboard().text(
    locale === "zh-CN" ? "♻️ 不设置，跳过" : "♻️ Skip buttons",
    "auto_reply:skip_buttons"
  );
}

function autoReplyTriggerKeyboard(_chatId: string, locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "包含触发" : "Contains", "auto_reply:trigger:contains")
    .text(locale === "zh-CN" ? "精准触发" : "Exact", "auto_reply:trigger:exact");
}

function groupCommandsHomeKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "群组命令" : "Group commands", `group_commands:list:${chatId}`)
    .text(locale === "zh-CN" ? "命令别名" : "Command aliases", `group_commands:aliases:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "返回首页" : "Home", "menu:home");
}

function groupCommandsKeyboard(chatId: string, settings: GroupCommandSettings, locale: Locale) {
  const keyboard = new InlineKeyboard();
  groupCommandDefinitions.forEach((item, index) => {
    const label = groupCommandLabel(item.key, locale);
    const enabled = settings.commands[item.key];
    keyboard.text(`${enabled ? "✅" : "⬜"} ${label}`, `group_commands:toggle:${chatId}:${item.key}`);
    if (index % 2 === 1) keyboard.row();
  });
  return keyboard
    .row()
    .text(locale === "zh-CN" ? "返回" : "Back", `group_commands:home:${chatId}`);
}

function groupCommandsAliasKeyboard(chatId: string, settings: GroupCommandSettings, locale: Locale) {
  const keyboard = new InlineKeyboard();
  groupCommandDefinitions.forEach((item, index) => {
    const count = settings.aliases[item.key].length;
    keyboard.text(`${groupCommandLabel(item.key, locale)} (${count})`, `group_commands:alias:${chatId}:${item.key}`);
    if (index % 2 === 1) keyboard.row();
  });
  return keyboard
    .row()
    .text(locale === "zh-CN" ? "返回" : "Back", `group_commands:home:${chatId}`);
}

function groupCommandAliasDetailKeyboard(chatId: string, command: GroupCommandKey, locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "添加别名" : "Add aliases", `group_commands:alias_add:${chatId}:${command}`)
    .text(locale === "zh-CN" ? "删除别名" : "Delete aliases", `group_commands:alias_delete:${chatId}:${command}`)
    .row()
    .text(locale === "zh-CN" ? "返回" : "Back", `group_commands:aliases:${chatId}`);
}

function groupCommandAliasInputKeyboard(chatId: string, command: GroupCommandKey, locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "取消" : "Cancel", `group_commands:alias:${chatId}:${command}`);
}

function pointsKeyboard(chatId: string, settings: PointsSettings, locale: Locale) {
  const selected = (active: boolean, label: string) => active ? `✅${label}` : label;
  if (locale !== "zh-CN") {
    return new InlineKeyboard()
      .text("Status:", `points:noop:${chatId}`)
      .text(selected(settings.enabled, "On"), `points:status:${chatId}:on`)
      .text(selected(!settings.enabled, "Off"), `points:status:${chatId}:off`)
      .row()
      .text("Delete sign-in reply:", `points:noop:${chatId}`)
      .text(selected(settings.deleteSignInMessage, "On"), `points:delete_sign:${chatId}:on`)
      .text(selected(!settings.deleteSignInMessage, "Off"), `points:delete_sign:${chatId}:off`)
      .row()
      .text("⚙ Sign-in rule", `points:rule:${chatId}:sign`)
      .text("⚙ Speech rule", `points:rule:${chatId}:speech`)
      .row()
      .text("⚙ Invite rule", `points:rule:${chatId}:invite`)
      .row()
      .text("⚙ Points alias", `points:alias:${chatId}:points`)
      .text("⚙ Ranking alias", `points:alias:${chatId}:points_rank`)
      .row()
      .text("➕➖ Adjust points", `points:adjust:${chatId}`)
      .row()
      .text("🎁 Point giveaway", `chat_feature:giveaway:${chatId}`)
      .text("🗑 Clear data", `points:clear:${chatId}`)
      .row()
      .text("🛒 Product exchange", `points:exchange:${chatId}`)
      .row()
      .text("🔙 Back", `menu:chat:group:${chatId}`);
  }

  return new InlineKeyboard()
    .text("状态:", `points:noop:${chatId}`)
    .text(selected(settings.enabled, "开启"), `points:status:${chatId}:on`)
    .text(selected(!settings.enabled, "关闭"), `points:status:${chatId}:off`)
    .row()
    .text("删除签到信息:", `points:noop:${chatId}`)
    .text(selected(settings.deleteSignInMessage, "开启"), `points:delete_sign:${chatId}:on`)
    .text(selected(!settings.deleteSignInMessage, "关闭"), `points:delete_sign:${chatId}:off`)
    .row()
    .text("⚙️签到规则", `points:rule:${chatId}:sign`)
    .text("⚙️发言规则", `points:rule:${chatId}:speech`)
    .row()
    .text("⚙️邀请规则", `points:rule:${chatId}:invite`)
    .row()
    .text("⚙️积分别名", `points:alias:${chatId}:points`)
    .text("⚙️排名别名", `points:alias:${chatId}:points_rank`)
    .row()
    .text("➕➖增减积分", `points:adjust:${chatId}`)
    .row()
    .text("🎁积分抽奖", `chat_feature:giveaway:${chatId}`)
    .text("🗑清空数据", `points:clear:${chatId}`)
    .row()
    .text("🛒商品兑换", `points:exchange:${chatId}`)
    .row()
    .text("🔙返回", `menu:chat:group:${chatId}`);
}

function pointsRuleKeyboard(chatId: string, settings: PointsSettings, rule: "sign" | "speech" | "invite", locale: Locale) {
  const keyboard = new InlineKeyboard();
  const option = (field: PointsRuleField, value: number, label: string, current: number) =>
    `${current === value ? "✅" : ""}${label}`;

  if (rule === "sign") {
    keyboard.text(locale === "zh-CN" ? "签到积分:" : "Sign-in points:", `points:noop:${chatId}`).row();
    for (const value of [0, 1, 2, 5, 10]) {
      keyboard.text(option("signInPoints", value, String(value), settings.signInPoints), `points:set:${chatId}:signInPoints:${value}`);
    }
    keyboard.row().text(locale === "zh-CN" ? "删除延迟:" : "Delete after:", `points:noop:${chatId}`).row();
    for (const value of [30, 60, 300]) {
      keyboard.text(option("deleteSignInSeconds", value, `${value}s`, settings.deleteSignInSeconds), `points:set:${chatId}:deleteSignInSeconds:${value}`);
    }
  } else if (rule === "speech") {
    keyboard.text(locale === "zh-CN" ? "每次发言积分:" : "Speech points:", `points:noop:${chatId}`).row();
    for (const value of [0, 1, 2, 5]) {
      keyboard.text(option("speechPoints", value, String(value), settings.speechPoints), `points:set:${chatId}:speechPoints:${value}`);
    }
    keyboard.row().text(locale === "zh-CN" ? "每日上限:" : "Daily limit:", `points:noop:${chatId}`).row();
    for (const value of [10, 50, 100, 0]) {
      keyboard.text(option("speechDailyLimit", value, value === 0 ? (locale === "zh-CN" ? "无限制" : "Unlimited") : String(value), settings.speechDailyLimit), `points:set:${chatId}:speechDailyLimit:${value}`);
    }
    keyboard.row().text(locale === "zh-CN" ? "最小字数:" : "Min length:", `points:noop:${chatId}`).row();
    for (const value of [0, 5, 10, 20]) {
      keyboard.text(option("speechMinLength", value, String(value), settings.speechMinLength), `points:set:${chatId}:speechMinLength:${value}`);
    }
  } else {
    keyboard.text(locale === "zh-CN" ? "邀请积分:" : "Invite points:", `points:noop:${chatId}`).row();
    for (const value of [0, 1, 5, 10]) {
      keyboard.text(option("invitePoints", value, String(value), settings.invitePoints), `points:set:${chatId}:invitePoints:${value}`);
    }
    keyboard.row().text(locale === "zh-CN" ? "每日上限:" : "Daily limit:", `points:noop:${chatId}`).row();
    for (const value of [10, 50, 100, 0]) {
      keyboard.text(option("inviteDailyLimit", value, value === 0 ? (locale === "zh-CN" ? "无限制" : "Unlimited") : String(value), settings.inviteDailyLimit), `points:set:${chatId}:inviteDailyLimit:${value}`);
    }
  }

  return keyboard.row().text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `chat_feature:points:${chatId}`);
}

function pointsConfirmClearKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `chat_feature:points:${chatId}`)
    .text(locale === "zh-CN" ? "❗️确认删除" : "❗️Confirm delete", `points:clear_confirm:${chatId}`);
}

function pointsBackKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `chat_feature:points:${chatId}`);
}

function pointExchangeKeyboard(chatId: string, settings: PointExchangeSettings, locale: Locale) {
  const selected = (active: boolean, label: string) => active ? `✅${label}` : label;
  if (locale !== "zh-CN") {
    return new InlineKeyboard()
      .text("Status:", `points:exchange_noop:${chatId}`)
      .text(selected(settings.enabled, "On"), `points:exchange_status:${chatId}:on`)
      .text(selected(!settings.enabled, "Off"), `points:exchange_status:${chatId}:off`)
      .row()
      .text("Change exchange keyword", `points:exchange_keyword:${chatId}`)
      .row()
      .text("🎁 Product management", `points:products:${chatId}`)
      .text("🧾 Exchange records", `points:exchange_records:${chatId}`)
      .row()
      .text("🔙 Back", `chat_feature:points:${chatId}`);
  }

  return new InlineKeyboard()
    .text("状态:", `points:exchange_noop:${chatId}`)
    .text(selected(settings.enabled, "开启"), `points:exchange_status:${chatId}:on`)
    .text(selected(!settings.enabled, "关闭"), `points:exchange_status:${chatId}:off`)
    .row()
    .text("修改兑换关键词", `points:exchange_keyword:${chatId}`)
    .row()
    .text("🎁商品管理", `points:products:${chatId}`)
    .text("🧾兑换记录", `points:exchange_records:${chatId}`)
    .row()
    .text("🔙返回", `chat_feature:points:${chatId}`);
}

function productsKeyboard(chatId: string, settings: PointExchangeSettings, locale: Locale) {
  const keyboard = new InlineKeyboard();
  for (const product of settings.products) {
    const name = product.name || (locale === "zh-CN" ? "未命名商品" : "Unnamed product");
    keyboard.text(`${product.listed ? "✅" : "⬜"} ${product.id} ${name}`.slice(0, 64), `points:product:${chatId}:${product.id}`).row();
  }
  return keyboard
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `points:exchange:${chatId}`)
    .text(locale === "zh-CN" ? "➕添加商品" : "➕ Add product", `points:product_add:${chatId}`);
}

function productKeyboard(chatId: string, product: PointProduct, locale: Locale) {
  const selected = (active: boolean, label: string) => active ? `✅${label}` : label;
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "是否上架：" : "Listed:", `points:product_noop:${chatId}:${product.id}`)
    .text(selected(product.listed, locale === "zh-CN" ? "是" : "Yes"), `points:product_listed:${chatId}:${product.id}:on`)
    .text(selected(!product.listed, locale === "zh-CN" ? "否" : "No"), `points:product_listed:${chatId}:${product.id}:off`)
    .row()
    .text(locale === "zh-CN" ? "修改名称" : "Edit name", `points:product_edit:${chatId}:${product.id}:name`)
    .text(locale === "zh-CN" ? "修改消耗 积分" : "Edit cost", `points:product_edit:${chatId}:${product.id}:cost`)
    .row()
    .text(locale === "zh-CN" ? "设置卡密" : "Set codes", `points:product_edit:${chatId}:${product.id}:codes`)
    .text(locale === "zh-CN" ? "查看卡密" : "View codes", `points:product_codes:${chatId}:${product.id}`)
    .row()
    .text(locale === "zh-CN" ? "设置每日兑换上限" : "Set daily limit", `points:product_edit:${chatId}:${product.id}:daily_limit`)
    .row()
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `points:products:${chatId}`);
}

function exchangeProductListKeyboard(chatId: string, products: PointProduct[], locale: Locale) {
  const keyboard = new InlineKeyboard();
  for (const product of products) {
    const name = product.name || (locale === "zh-CN" ? "未命名商品" : "Unnamed product");
    keyboard.text(`${name} - ${product.cost}`, `points:exchange_redeem:${chatId}:${product.id}`).row();
  }
  return keyboard;
}

function groupStatsKeyboard(chatId: string, locale: Locale) {
  if (locale !== "zh-CN") {
    return new InlineKeyboard()
      .text("🔽 Message stats 🔽", groupStatsCallbackData("noop", chatId))
      .row()
      .text("Today message ranking", groupStatsCallbackData("speech_today_rank", chatId))
      .row()
      .text("7-day message ranking", groupStatsCallbackData("speech_7d_rank", chatId))
      .text("7-day message stats", groupStatsCallbackData("speech_7d_stats", chatId))
      .row()
      .text("Monthly message ranking", groupStatsCallbackData("speech_month_rank", chatId))
      .row()
      .text("🔽 Invite stats 🔽", groupStatsCallbackData("noop", chatId))
      .row()
      .text("Today invite ranking", groupStatsCallbackData("invite_today_rank", chatId))
      .text("7-day invite stats", groupStatsCallbackData("invite_7d_stats", chatId))
      .row()
      .text("🔽 Join/leave stats 🔽", groupStatsCallbackData("noop", chatId))
      .row()
      .text("Today join/leave data", groupStatsCallbackData("member_today", chatId))
      .text("7-day join/leave stats", groupStatsCallbackData("member_7d", chatId))
      .row()
      .text("🏠 Home", `menu:chat:group:${chatId}`);
  }

  return new InlineKeyboard()
    .text("🔽发言统计🔽", groupStatsCallbackData("noop", chatId))
    .row()
    .text("今日发言排名", groupStatsCallbackData("speech_today_rank", chatId))
    .row()
    .text("7日发言排名", groupStatsCallbackData("speech_7d_rank", chatId))
    .text("7日发言统计", groupStatsCallbackData("speech_7d_stats", chatId))
    .row()
    .text("月发言排名", groupStatsCallbackData("speech_month_rank", chatId))
    .row()
    .text("🔽邀请统计🔽", groupStatsCallbackData("noop", chatId))
    .row()
    .text("今日邀请排名", groupStatsCallbackData("invite_today_rank", chatId))
    .text("7日邀请统计", groupStatsCallbackData("invite_7d_stats", chatId))
    .row()
    .text("🔽进退群统计🔽", groupStatsCallbackData("noop", chatId))
    .row()
    .text("今日进退群数据", groupStatsCallbackData("member_today", chatId))
    .text("7日进退群统计", groupStatsCallbackData("member_7d", chatId))
    .row()
    .text("🏠返回首页", `menu:chat:group:${chatId}`);
}

const groupStatsCallbackActions = {
  noop: "n",
  speech_today_rank: "st",
  speech_7d_rank: "s7r",
  speech_7d_stats: "s7s",
  speech_month_rank: "sm",
  invite_today_rank: "it",
  invite_7d_stats: "i7",
  member_today: "mt",
  member_7d: "m7"
} as const;

type GroupStatsAction = keyof typeof groupStatsCallbackActions;

function groupStatsCallbackData(action: GroupStatsAction, chatId: string) {
  return `group_stats:${groupStatsCallbackActions[action]}:${chatId}`;
}

function normalizeGroupStatsAction(action: string) {
  const entry = Object.entries(groupStatsCallbackActions)
    .find(([, token]) => token === action);
  return entry?.[0] ?? action;
}

function memberStatsKeyboard(chat: PrismaChat, settings: MemberStatsSettings, locale: Locale) {
  const scope = chat.type === "CHANNEL" ? "channel" : "group";
  const labels = locale === "zh-CN"
    ? { status: "状态:", on: "开启", off: "关闭", view: "查看统计", back: "🔙返回" }
    : { status: "Status:", on: "On", off: "Off", view: "View stats", back: "🔙Back" };

  return new InlineKeyboard()
    .text(labels.status, `member_stats:noop:${chat.id}`)
    .text(settings.enabled ? `✅${labels.on}` : labels.on, `member_stats:toggle:${chat.id}:on`)
    .text(!settings.enabled ? `✅${labels.off}` : labels.off, `member_stats:toggle:${chat.id}:off`)
    .row()
    .text(labels.view, `member_stats:view:${chat.id}:7`)
    .row()
    .text(labels.back, `menu:chat:${scope}:${chat.id}`);
}

function groupMembersKeyboard(chat: PrismaChat, settings: GroupMembersSettings, locale: Locale) {
  const scope = chat.type === "CHANNEL" ? "channel" : "group";
  const labels = locale === "zh-CN"
    ? {
        nickname: "监听昵称",
        username: "监听用户名",
        unpinLinkedChannel: "取消绑定频道消息置顶",
        back: "🔙返回"
      }
    : {
        nickname: "Watch names",
        username: "Watch usernames",
        unpinLinkedChannel: "Unpin linked channel messages",
        back: "🔙Back"
      };

  const mark = (enabled: boolean, label: string) => `${enabled ? "✅" : "❌"}${label}`;

  return new InlineKeyboard()
    .text(mark(settings.watchNicknameChange, labels.nickname), `group_members:toggle:nickname:${chat.id}`)
    .row()
    .text(mark(settings.watchUsernameChange, labels.username), `group_members:toggle:username:${chat.id}`)
    .row()
    .text(mark(settings.unpinLinkedChannelMessages, labels.unpinLinkedChannel), `group_members:toggle:unpin_linked_channel:${chat.id}`)
    .row()
    .text(labels.back, `menu:chat:${scope}:${chat.id}`);
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

async function resolveScheduledCallbackChat(action: string, id: string) {
  if (["list", "back", "add", "bulk", "bulk_on", "bulk_off", "bulk_delete_confirm", "bulk_delete"].includes(action)) {
    return prisma.chat.findUnique({ where: { id } });
  }

  const scheduled = await prisma.scheduledMessage.findUnique({
    where: { id },
    include: { chat: true }
  });
  return scheduled?.chat ?? null;
}

async function handleScheduledCallback(ctx: Context) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const locale = await getLocale(ctx);
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const [, action, id, value] = data.split(":");
  if (!action || !id) return;

  const accessChat = await resolveScheduledCallbackChat(action, id);
  if (!accessChat) return;
  if (!(await ensureControlPermissionAccess(ctx, accessChat, locale))) return;

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

  const scheduled = await prisma.scheduledMessage.findUnique({
    where: { id: draft.scheduledMessageId },
    include: { chat: true }
  });
  if (!scheduled) {
    scheduledInputDrafts.delete(ctx.from.id);
    return false;
  }

  if (!(await ensureControlPermissionAccess(ctx, scheduled.chat, locale))) {
    scheduledInputDrafts.delete(ctx.from.id);
    return true;
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
    "• 插入<b>两行四个按钮(带背景颜色)</b>：",
    "<pre>#p第1行链接名称1-https://t.me/xxx && #r第1行链接名称2-https://t.me/xxx\n#g第2行链接名称1-https://t.me/xxx && 第2行链接名称2-https://t.me/xxx</pre>",
    "",
    "<b>二、底部键盘</b>：",
    "<pre>导航 && 签到</pre>",
    "⚠️ 消息按钮和底部键盘不能同时发送, <a href=\"tg://bot_command?command=clear\"><b>/clear</b></a><b> 命令可以关闭底部键盘</b>",
    "⚠️ #p-蓝色背景 #r-红色背景 #g-绿色背景"
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

  if (!(await ensureControlPermissionForChatId(ctx, draft.chatId, locale))) {
    autoReplyInputDrafts.delete(ctx.from.id);
    return true;
  }

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

  if (draft.stage === "delete") {
    const text = getMessageText(ctx.message);
    const keyword = text ? normalizeAutoReplyKeywordName(text) : "";
    if (!keyword) {
      const settings = await getAutoReplySettings(draft.chatId);
      await ctx.reply(autoReplyDeletePromptText(settings, locale), {
        parse_mode: "HTML",
        reply_markup: autoReplyCancelKeyboard(draft.chatId, locale)
      });
      return true;
    }

    const settings = await getAutoReplySettings(draft.chatId);
    const index = settings.rules.findIndex((rule) => rule.keyword === keyword);
    if (index < 0) {
      await ctx.reply(locale === "zh-CN" ? "未找到这个关键词，请重新输入。" : "Keyword not found. Send it again.", {
        parse_mode: "HTML",
        reply_markup: autoReplyCancelKeyboard(draft.chatId, locale)
      });
      return true;
    }

    settings.rules.splice(index, 1);
    autoReplyInputDrafts.delete(ctx.from.id);
    await saveAutoReplySettings(draft.chatId, settings);
    await ctx.reply(locale === "zh-CN" ? "✅ 删除成功，点击按钮返回。" : "✅ Deleted. Tap the button to return.", {
      parse_mode: "HTML",
      reply_markup: autoReplyDoneKeyboard(draft.chatId, locale)
    });
    return true;
  }

  if (draft.stage === "trigger") {
    await ctx.reply(autoReplyTriggerPromptText(locale), {
      parse_mode: "HTML",
      reply_markup: autoReplyTriggerKeyboard(draft.chatId, locale)
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

  draft.buttons = buttons;
  draft.stage = "trigger";
  await ctx.reply(autoReplyTriggerPromptText(locale), {
    parse_mode: "HTML",
    reply_markup: autoReplyTriggerKeyboard(draft.chatId, locale)
  });
  return true;
}

async function handleBannedWordsInputMessage(ctx: Context, locale: Locale) {
  if (!ctx.from) return false;
  const draft = bannedWordsInputDrafts.get(ctx.from.id);
  if (!draft) return false;

  if (!(await ensureControlPermissionForChatId(ctx, draft.chatId, locale))) {
    bannedWordsInputDrafts.delete(ctx.from.id);
    return true;
  }

  const text = getMessageText(ctx.message);

  if (draft.stage === "mute_duration") {
    const minutes = text ? Number(text.trim()) : NaN;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 525600) {
      const settings = await getBannedWordsSettings(draft.chatId);
      await ctx.reply(bannedWordsMuteDurationPromptText(settings, locale), {
        parse_mode: "HTML",
        reply_markup: bannedWordsMuteDurationKeyboard(draft.chatId, locale)
      });
      return true;
    }

    const settings = await getBannedWordsSettings(draft.chatId);
    settings.muteMinutes = minutes;
    await saveBannedWordsSettings(draft.chatId, settings);
    bannedWordsInputDrafts.delete(ctx.from.id);
    await ctx.reply(locale === "zh-CN" ? "✅ 设置成功，点击按钮返回。" : "✅ Saved. Tap the button to return.", {
      parse_mode: "HTML",
      reply_markup: bannedWordsDoneKeyboard(draft.chatId, locale)
    });
    return true;
  }

  const words = text ? parseBannedWordsInput(text) : [];
  if (!words.length) {
    const prompt = draft.stage === "add"
      ? bannedWordsAddPromptText(locale)
      : await bannedWordsDeletePromptText(draft.chatId, locale);
    await ctx.reply(prompt, { parse_mode: "HTML", reply_markup: bannedWordsCancelKeyboard(draft.chatId, locale) });
    return true;
  }

  if (draft.stage === "add") {
    const added = await addBannedWords(draft.chatId, words);
    bannedWordsInputDrafts.delete(ctx.from.id);
    await ctx.reply(bannedWordsSavedText(added, locale), {
      parse_mode: "HTML",
      reply_markup: bannedWordsDoneKeyboard(draft.chatId, locale)
    });
    return true;
  }

  const deleted = await deleteBannedWordsByPattern(draft.chatId, words);
  bannedWordsInputDrafts.delete(ctx.from.id);
  await ctx.reply(bannedWordsDeletedText(deleted, locale), {
    parse_mode: "HTML",
    reply_markup: bannedWordsDoneKeyboard(draft.chatId, locale)
  });
  return true;
}

async function finalizeAutoReplyRule(
  ctx: Context,
  locale: Locale,
  draft: AutoReplyInputDraft
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
  if (draft.buttons?.length) rule.buttons = draft.buttons;

  settings.rules.push(rule);
  autoReplyInputDrafts.delete(ctx.from.id);
  await saveAutoReplySettings(draft.chatId, settings);
  await ctx.reply(locale === "zh-CN" ? "✅ 设置成功，点击按钮返回。" : "✅ Saved. Tap the button to return.", {
    parse_mode: "HTML",
    reply_markup: autoReplyDoneKeyboard(draft.chatId, locale)
  });
}

function parseAutoReplyKeyword(input: string) {
  const value = input.trim();
  if (!value) return null;

  const prefix = value[0];
  const keyword = prefix === "-" || prefix === "*" ? value.slice(1).trim() : value;
  if (!keyword) return null;

  return {
    keyword: keyword.slice(0, 80)
  } as const;
}

function normalizeAutoReplyKeywordName(input: string) {
  const value = input.trim();
  if (!value) return "";
  const prefix = value[0];
  return (prefix === "-" || prefix === "*" ? value.slice(1) : value).trim().slice(0, 80);
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

async function handleWelcomeInputMessage(ctx: Context, locale: Locale) {
  if (!ctx.from || ctx.chat?.type !== "private") return false;
  const draft = welcomeInputDrafts.get(ctx.from.id);
  if (!draft) return false;

  if (!(await ensureControlPermissionForChatId(ctx, draft.chatId, locale))) {
    welcomeInputDrafts.delete(ctx.from.id);
    return true;
  }

  const settings = await getWelcomeSettings(draft.chatId);

  if (draft.field === "media") {
    const media = extractPublishMedia(ctx.message);
    if (!media) {
      await ctx.reply(welcomeInputPromptText("media", settings, locale), {
        parse_mode: "HTML",
        reply_markup: welcomeInputKeyboard(draft.chatId, "media", locale)
      });
      return true;
    }

    settings.mediaKind = media.kind;
    settings.mediaFileId = media.fileId;
    welcomeInputDrafts.delete(ctx.from.id);
    await saveWelcomeSettings(draft.chatId, settings);
    await ctx.reply(welcomeInputSavedText(locale), {
      parse_mode: "HTML",
      reply_markup: welcomeSavedKeyboard(draft.chatId, locale)
    });
    return true;
  }

  const text = getMessageText(ctx.message);
  if (!text) {
    await ctx.reply(welcomeInputPromptText(draft.field, settings, locale), {
      parse_mode: "HTML",
      reply_markup: welcomeInputKeyboard(draft.chatId, draft.field, locale)
    });
    return true;
  }

  if (draft.field === "button") {
    const buttons = parseScheduledButtonLayout(text);
    const replyKeyboard = buttons.length ? undefined : parseReplyKeyboardLayout(text);
    if (!buttons.length && !replyKeyboard?.length) {
      await ctx.reply(welcomeInputPromptText("button", settings, locale), {
        parse_mode: "HTML",
        reply_markup: welcomeInputKeyboard(draft.chatId, "button", locale)
      });
      return true;
    }
    settings.buttons = buttons.length ? buttons : undefined;
    settings.replyKeyboard = replyKeyboard;
    settings.buttonText = buttons[0]?.[0]?.text ?? "";
    settings.buttonUrl = buttons[0]?.[0]?.url ?? "";
  } else {
    settings.text = text.slice(0, 4000);
  }

  welcomeInputDrafts.delete(ctx.from.id);
  await saveWelcomeSettings(draft.chatId, settings);
  await ctx.reply(welcomeInputSavedText(locale), {
    parse_mode: "HTML",
    reply_markup: welcomeSavedKeyboard(draft.chatId, locale)
  });
  return true;
}

async function handleInviteLinkInputMessage(ctx: Context, locale: Locale) {
  if (!ctx.from || ctx.chat?.type !== "private") return false;
  const draft = inviteLinkInputDrafts.get(ctx.from.id);
  if (!draft) return false;

  if (!(await ensureControlPermissionForChatId(ctx, draft.chatId, locale))) {
    inviteLinkInputDrafts.delete(ctx.from.id);
    return true;
  }

  const text = getMessageText(ctx.message);
  const value = text ? parseNonNegativeInteger(text) : null;
  const maxValue = draft.field === "expireDays" ? 365 : draft.field === "memberLimit" ? 99_999 : Number.MAX_SAFE_INTEGER;

  if (value === null || value > maxValue || (draft.field === "resetUserId" && value <= 0)) {
    const retryText = locale === "zh-CN"
      ? (draft.field === "resetUserId" ? "请输入正确的用户 ID。" : `请输入 0-${maxValue} 之间的整数。`)
      : (draft.field === "resetUserId" ? "Send a valid user ID." : `Send an integer from 0 to ${maxValue}.`);
    await ctx.reply(`${retryText}\n\n${inviteLinkInputPromptText(draft.field, locale)}`, {
      parse_mode: "HTML",
      reply_markup: inviteLinkInputKeyboard(draft.chatId, locale)
    });
    return true;
  }

  if (draft.field === "resetUserId") {
    const result = await resetInviteLinksForTelegramUser(ctx, draft.chatId, value);
    inviteLinkInputDrafts.delete(ctx.from.id);
    await ctx.reply(inviteLinkResetResultText(result, value, locale), {
      parse_mode: "HTML",
      reply_markup: inviteLinkSavedKeyboard(draft.chatId, locale)
    });
    return true;
  }

  const settings = await getInviteLinkSettings(draft.chatId);
  if (draft.field === "expireDays") {
    settings.expireSeconds = value * 86400;
  } else {
    settings.memberLimit = value;
  }

  inviteLinkInputDrafts.delete(ctx.from.id);
  await saveInviteLinkSettings(draft.chatId, settings);
  await ctx.reply(inviteLinkInputSavedText(locale), {
    parse_mode: "HTML",
    reply_markup: inviteLinkSavedKeyboard(draft.chatId, locale)
  });
  return true;
}

function parseNonNegativeInteger(input: string) {
  const value = input.trim();
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
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

function isPublishMediaKind(value: unknown): value is PublishMediaKind {
  return value === "photo" || value === "video" || value === "animation" || value === "sticker";
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
  const sourceItems = input
    .split(/\r?\n/)
    .flatMap((line) => line.split("&&").map((item) => item.trim()).filter(Boolean));
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

  return rows.flat().length === sourceItems.length ? rows : [];
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

function parseReplyKeyboardLayout(input: string) {
  const rows = input
    .split(/\r?\n/)
    .map((line) =>
      line
        .split("&&")
        .map((item) => item.replace(/^#[prg]\s*/i, "").trim())
        .filter(Boolean)
    )
    .filter((row) => row.length > 0);

  return rows.length ? rows : undefined;
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
  if (query.query.startsWith("member_stats:")) {
    await handleMemberStatsInlineQuery(ctx);
    return;
  }

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

  if (isConfigurationFeature(feature)) {
    const allowed = await canConfigureChat(ctx, chat, ctx.from?.id ?? 0).catch(() => false);
    if (!allowed) {
      await ctx.answerCallbackQuery({
        text: locale === "zh-CN"
          ? "只有符合控制权限的管理员可以设置机器人。"
          : "Only permitted admins can configure the bot.",
        show_alert: true
      }).catch(() => undefined);
      return;
    }
  }

  rememberSelectedChatForModules(ctx.from?.id, chat.id);

  if (feature === "block") {
    const settings = await getBlocklistSettings(chatId);
    await editOrReply(ctx, blocklistText(settings, locale), blocklistKeyboard(chatId, locale));
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
    await editOrReply(ctx, autoReplyText(settings, locale, config.botUsername), autoReplyKeyboard(chatId, settings, locale));
    return;
  }

  if (feature === "banned_words") {
    await openBannedWordsPanel(ctx, locale, chat);
    return;
  }

  if (feature === "commands") {
    await openGroupCommandsHome(ctx, locale, chat);
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

  if (feature === "speech_check") {
    await openSpeechCheckMenu(ctx, locale);
    return;
  }

  if (feature === "anti_spam") {
    await openAntiSpamMenu(ctx, locale, chat);
    return;
  }

  if (feature === "night_mode") {
    await openNightModeMenu(ctx, locale);
    return;
  }

  if (feature === "scheduled") {
    await openScheduledMessagePanel(ctx, locale, chat);
    return;
  }

  if (feature === "stats") {
    await openGroupStatsPanel(ctx, locale, chat);
    return;
  }

  if (feature === "member_stats") {
    await openMemberStatsPanel(ctx, locale, chat);
    return;
  }

  if (feature === "members") {
    await openGroupMembersPanel(ctx, locale, chat);
    return;
  }

  if (feature === "publish") {
    await renderPublishHome(ctx, locale);
    return;
  }

  if (feature === "permissions") {
    await openControlPermissionsPanel(ctx, locale, chat);
    return;
  }

  if (feature === "invite") {
    await openInviteLinkPanel(ctx, locale, chat);
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

  if (feature === "import") {
    await openImportConfigPanel(ctx, locale, chat);
    return;
  }

  if (feature === "schedule" || feature === "sync") {
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

async function handleImportConfigCallback(ctx: Context) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const locale = await getLocale(ctx);
  const [, action, targetChatId] = ctx.callbackQuery?.data?.split(":") ?? [];
  if (!action || !targetChatId) return;

  const targetChat = await prisma.chat.findUnique({ where: { id: targetChatId } });
  if (!targetChat) {
    await editOrReply(ctx, locale === "zh-CN" ? "找不到该管理对象。" : "Managed chat not found.", homeKeyboard(locale));
    return;
  }

  if (action === "back") {
    if (ctx.from) importConfigDrafts.delete(ctx.from.id);
    await editOrReply(ctx, chatPanelText(targetChat, locale), chatPanelKeyboard(targetChat.id, chatPanelScope(targetChat), locale));
    return;
  }

  if (action === "cancel") {
    if (ctx.from) importConfigDrafts.delete(ctx.from.id);
    await openImportConfigPanel(ctx, locale, targetChat);
    return;
  }

  if (action !== "start" || !ctx.from) return;

  const ownerUserId = await getCurrentDbUserId(ctx.from.id);
  if (!ownerUserId || targetChat.ownerUserId !== ownerUserId) {
    await editOrReply(ctx, importConfigOwnerOnlyText(locale), importConfigKeyboard(targetChat.id, chatPanelScope(targetChat), locale));
    return;
  }

  clearUserInputState(ctx.from.id);
  importConfigDrafts.set(ctx.from.id, { targetChatId: targetChat.id });
  await editOrReply(ctx, importConfigPromptText(targetChat, locale), importConfigCancelKeyboard(targetChat.id, chatPanelScope(targetChat), locale));
}

async function handleImportConfigInputMessage(ctx: Context, locale: Locale) {
  if (!ctx.from) return false;
  const draft = importConfigDrafts.get(ctx.from.id);
  if (!draft) return false;

  const targetChat = await prisma.chat.findUnique({ where: { id: draft.targetChatId } });
  const message = ctx.message;
  const text = message && "text" in message ? message.text?.trim() ?? "" : "";
  const sourceTelegramChatId = parseImportSourceTelegramChatId(text);
  if (!sourceTelegramChatId) {
    await ctx.reply(importConfigInvalidSourceText(locale), {
      parse_mode: "HTML",
      reply_markup: importConfigCancelKeyboard(draft.targetChatId, targetChat ? chatPanelScope(targetChat) : "group", locale)
    });
    return true;
  }

  const [sourceChat, ownerUserId] = await Promise.all([
    prisma.chat.findFirst({
      where: {
        telegramChatId: sourceTelegramChatId,
        status: ChatStatus.ACTIVE
      }
    }),
    getCurrentDbUserId(ctx.from.id)
  ]);

  if (!targetChat) {
    importConfigDrafts.delete(ctx.from.id);
    await ctx.reply(locale === "zh-CN" ? "找不到当前管理对象，请重新打开管理菜单。" : "Managed chat not found. Reopen the management menu.");
    return true;
  }

  if (!sourceChat) {
    await ctx.reply(importConfigSourceNotFoundText(locale), {
      parse_mode: "HTML",
      reply_markup: importConfigCancelKeyboard(targetChat.id, chatPanelScope(targetChat), locale)
    });
    return true;
  }

  if (sourceChat.id === targetChat.id) {
    await ctx.reply(importConfigSameChatText(locale), {
      parse_mode: "HTML",
      reply_markup: importConfigCancelKeyboard(targetChat.id, chatPanelScope(targetChat), locale)
    });
    return true;
  }

  if (chatPanelScope(sourceChat) !== chatPanelScope(targetChat)) {
    await ctx.reply(importConfigTypeMismatchText(locale), {
      parse_mode: "HTML",
      reply_markup: importConfigCancelKeyboard(targetChat.id, chatPanelScope(targetChat), locale)
    });
    return true;
  }

  if (!ownerUserId || targetChat.ownerUserId !== ownerUserId || sourceChat.ownerUserId !== ownerUserId) {
    await ctx.reply(importConfigOwnerOnlyText(locale), {
      parse_mode: "HTML",
      reply_markup: importConfigCancelKeyboard(targetChat.id, chatPanelScope(targetChat), locale)
    });
    return true;
  }

  const result = await importChatConfiguration(sourceChat.id, targetChat.id);
  importConfigDrafts.delete(ctx.from.id);
  await ctx.reply(importConfigSuccessText(sourceChat, targetChat, result, locale), {
    parse_mode: "HTML",
    reply_markup: importConfigDoneKeyboard(targetChat.id, chatPanelScope(targetChat), locale)
  });
  return true;
}

async function openImportConfigPanel(ctx: Context, locale: Locale, chat: PrismaChat) {
  await editOrReply(ctx, importConfigPanelText(chat, locale), importConfigKeyboard(chat.id, chatPanelScope(chat), locale));
}

function importConfigPanelText(chat: PrismaChat, locale: Locale) {
  const chatId = chat.telegramChatId.toString();
  return locale === "zh-CN"
    ? [
        "📋 <b>导入配置</b>",
        "",
        "导入其他群组或频道的设置，使用此功能快速复制其他群组的设置项",
        "",
        `当前群组ID: <code>${escapeHtml(chatId)}</code>`,
        "",
        "⚠️ 只有拉入bot的创建者可以使用该操作",
        "⚠️ [夜间模式] 不支持复制"
      ].join("\n")
    : [
        "📋 <b>Import Config</b>",
        "",
        "Import settings from another managed group or channel.",
        "",
        `Current chat ID: <code>${escapeHtml(chatId)}</code>`,
        "",
        "⚠️ Only the user who added the bot can use this action.",
        "⚠️ Night mode is not copied."
      ].join("\n");
}

function importConfigKeyboard(chatId: string, scope: "group" | "channel", locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "导入配置" : "Import config", `import_config:start:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `menu:chat:${scope}:${chatId}`);
}

function importConfigCancelKeyboard(chatId: string, scope: "group" | "channel", locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "取消" : "Cancel", `import_config:cancel:${chatId}`)
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `menu:chat:${scope}:${chatId}`);
}

function importConfigDoneKeyboard(chatId: string, scope: "group" | "channel", locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "返回群组设置" : "Back to settings", `menu:chat:${scope}:${chatId}`);
}

function importConfigPromptText(chat: PrismaChat, locale: Locale) {
  const currentId = chat.telegramChatId.toString();
  return locale === "zh-CN"
    ? [
        "📋 <b>导入配置</b>",
        "",
        `当前群组ID: <code>${escapeHtml(currentId)}</code>`,
        "",
        "请发送要复制配置的来源群组/频道 ID。",
        "示例: <code>-1001234567890</code>",
        "",
        "导入会覆盖当前群组已有配置；夜间模式不会复制。"
      ].join("\n")
    : [
        "📋 <b>Import Config</b>",
        "",
        `Current chat ID: <code>${escapeHtml(currentId)}</code>`,
        "",
        "Send the source group/channel ID to copy from.",
        "Example: <code>-1001234567890</code>",
        "",
        "Importing overwrites current settings. Night mode is not copied."
      ].join("\n");
}

function importConfigInvalidSourceText(locale: Locale) {
  return locale === "zh-CN"
    ? "来源 ID 格式不正确，请发送类似 <code>-1001234567890</code> 的群组/频道 ID。"
    : "Invalid source ID. Send a group/channel ID like <code>-1001234567890</code>.";
}

function importConfigSourceNotFoundText(locale: Locale) {
  return locale === "zh-CN"
    ? "未找到这个已绑定的来源群组/频道，请确认机器人已在来源群组中并完成绑定。"
    : "Source chat was not found. Make sure the bot is added and the chat is bound.";
}

function importConfigOwnerOnlyText(locale: Locale) {
  return locale === "zh-CN"
    ? "只有拉入 bot 的创建者可以导入配置，并且来源和目标都必须由同一个创建者绑定。"
    : "Only the user who added the bot can import config, and the same user must own both source and target chats.";
}

function importConfigSameChatText(locale: Locale) {
  return locale === "zh-CN" ? "不能从当前群组导入到自身。" : "You cannot import from the same chat.";
}

function importConfigTypeMismatchText(locale: Locale) {
  return locale === "zh-CN"
    ? "来源和当前管理对象类型不一致。群组只能导入群组配置，频道只能导入频道配置。"
    : "Source and target types do not match. Groups can import from groups; channels can import from channels.";
}

function importConfigSuccessText(
  sourceChat: PrismaChat,
  targetChat: PrismaChat,
  result: { settings: number; moderationRules: number },
  locale: Locale
) {
  const sourceTitle = escapeHtml(sourceChat.title ?? sourceChat.username ?? sourceChat.telegramChatId.toString());
  const targetTitle = escapeHtml(targetChat.title ?? targetChat.username ?? targetChat.telegramChatId.toString());
  return locale === "zh-CN"
    ? [
        "✅ <b>导入完成</b>",
        "",
        `来源: <b>${sourceTitle}</b>`,
        `目标: <b>${targetTitle}</b>`,
        "",
        `已导入配置项: <b>${result.settings}</b>`,
        `已导入违禁词规则: <b>${result.moderationRules}</b>`,
        "",
        "夜间模式未复制。"
      ].join("\n")
    : [
        "✅ <b>Import complete</b>",
        "",
        `Source: <b>${sourceTitle}</b>`,
        `Target: <b>${targetTitle}</b>`,
        "",
        `Settings imported: <b>${result.settings}</b>`,
        `Banned-word rules imported: <b>${result.moderationRules}</b>`,
        "",
        "Night mode was not copied."
      ].join("\n");
}

function parseImportSourceTelegramChatId(input: string) {
  const match = input.match(/-?\d{5,}/);
  if (!match?.[0]) return null;
  try {
    return BigInt(match[0]);
  } catch {
    return null;
  }
}

function chatPanelScope(chat: PrismaChat): "group" | "channel" {
  return chat.type === "CHANNEL" ? "channel" : "group";
}

async function getCurrentDbUserId(telegramUserId: number) {
  const user = await prisma.user.findUnique({
    where: { telegramUserId: BigInt(telegramUserId) },
    select: { id: true }
  });
  return user?.id ?? null;
}

async function importChatConfiguration(sourceChatId: string, targetChatId: string) {
  const [sourceSettings, sourceRules] = await Promise.all([
    prisma.setting.findMany({
      where: {
        chatId: sourceChatId,
        key: { in: [...importableSettingKeys] }
      }
    }),
    prisma.moderationRule.findMany({
      where: { chatId: sourceChatId },
      select: {
        ruleType: true,
        pattern: true,
        action: true,
        enabled: true
      }
    })
  ]);

  const settings = sourceSettings
    .map((setting) => {
      const value = sanitizeImportedSettingValue(setting.key, setting.value);
      return value === undefined ? null : { key: setting.key, value };
    })
    .filter((setting): setting is { key: string; value: Prisma.InputJsonValue } => Boolean(setting));

  await prisma.$transaction(async (tx) => {
    await tx.setting.deleteMany({
      where: {
        chatId: targetChatId,
        key: { in: [...importableSettingKeys] }
      }
    });

    if (settings.length) {
      await tx.setting.createMany({
        data: settings.map((setting) => ({
          chatId: targetChatId,
          key: setting.key,
          value: setting.value
        }))
      });
    }

    await tx.moderationRule.deleteMany({ where: { chatId: targetChatId } });
    if (sourceRules.length) {
      await tx.moderationRule.createMany({
        data: sourceRules.map((rule) => ({
          chatId: targetChatId,
          ruleType: rule.ruleType,
          pattern: rule.pattern,
          action: rule.action,
          enabled: rule.enabled
        }))
      });
    }
  });

  return {
    settings: settings.length,
    moderationRules: sourceRules.length
  };
}

function sanitizeImportedSettingValue(key: string, value: Prisma.JsonValue): Prisma.InputJsonValue | undefined {
  if (!importableSettingKeySet.has(key)) return undefined;
  const cloned = cloneJsonValue(value);

  if (key === "welcome" && isRecord(cloned)) {
    const record = cloned as Record<string, unknown>;
    const { lastMessageIds: _lastMessageIds, ...rest } = record;
    return settingsToJson(rest);
  }

  if (key === "member_stats" && isRecord(cloned)) {
    const record = cloned as Record<string, unknown>;
    return settingsToJson({
      enabled: typeof record.enabled === "boolean" ? record.enabled : defaultMemberStatsSettings.enabled
    });
  }

  return cloned;
}

function cloneJsonValue(value: Prisma.JsonValue): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
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

async function handleNightModeCallback(ctx: Context) {
  const locale = await getLocale(ctx);
  const key = ctx.callbackQuery?.data?.replace("night_mode:", "");
  if (!key) return;
  await handleNightModeAction(ctx, locale, key);
}

async function handleSpeechCheckCallback(ctx: Context) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const locale = await getLocale(ctx);
  const key = ctx.callbackQuery?.data?.replace("speech_check:", "");
  if (!key) return;
  await handleSpeechCheckAction(ctx, locale, key);
}

async function handleInviteLinkCallback(ctx: Context) {
  const locale = await getLocale(ctx);
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const [, action, chatId, value] = data.split(":");
  if (!action || !chatId) return;

  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!chat) {
    await ctx.answerCallbackQuery().catch(() => undefined);
    await editOrReply(ctx, locale === "zh-CN" ? "找不到该群组。" : "Managed group not found.", homeKeyboard(locale));
    return;
  }

  if (!(await ensureControlPermissionAccess(ctx, chat, locale))) return;

  const settings = await getInviteLinkSettings(chatId);

  if (action === "status") settings.enabled = value === "on";
  if (action === "notify") settings.notify = value === "on";
  if (action === "approval") settings.createsJoinRequest = value === "on";

  if (["status", "notify", "approval"].includes(action)) {
    await ctx.answerCallbackQuery().catch(() => undefined);
    await saveInviteLinkSettings(chatId, settings);
    await openInviteLinkPanel(ctx, locale, chat);
    return;
  }

  if ((action === "expire" || action === "limit") && ctx.from) {
    await ctx.answerCallbackQuery().catch(() => undefined);
    clearUserInputState(ctx.from.id);
    const field: InviteLinkInputField = action === "expire" ? "expireDays" : "memberLimit";
    inviteLinkInputDrafts.set(ctx.from.id, { chatId, field });
    await editOrReply(ctx, inviteLinkInputPromptText(field, locale), inviteLinkInputKeyboard(chatId, locale));
    return;
  }

  if (action === "cancel" && ctx.from) {
    await ctx.answerCallbackQuery().catch(() => undefined);
    inviteLinkInputDrafts.delete(ctx.from.id);
    await openInviteLinkPanel(ctx, locale, chat);
    return;
  }

  if (action === "export") {
    if (await exportInviteLinkData(ctx, locale, chat)) {
      await openInviteLinkPanel(ctx, locale, chat);
    }
    return;
  }

  if (action === "clear") {
    await ctx.answerCallbackQuery().catch(() => undefined);
    await editOrReply(ctx, inviteLinkClearConfirmText(locale), inviteLinkClearConfirmKeyboard(chatId, locale));
    return;
  }

  if (action === "clear_confirm") {
    await ctx.answerCallbackQuery().catch(() => undefined);
    await clearInviteLinksAndData(ctx, chat);
    await openInviteLinkPanel(ctx, locale, chat);
    return;
  }

  if (action === "reset") {
    await ctx.answerCallbackQuery().catch(() => undefined);
    if (!ctx.from) return;
    clearUserInputState(ctx.from.id);
    inviteLinkInputDrafts.set(ctx.from.id, { chatId, field: "resetUserId" });
    await editOrReply(ctx, inviteLinkInputPromptText("resetUserId", locale), inviteLinkInputKeyboard(chatId, locale));
    return;
  }

  await ctx.answerCallbackQuery().catch(() => undefined);

}

async function handleGroupStatsCallback(ctx: Context) {
  const locale = await getLocale(ctx);
  const [, actionToken, chatId] = ctx.callbackQuery?.data?.split(":") ?? [];
  const action = actionToken ? normalizeGroupStatsAction(actionToken) : undefined;
  if (!action || !chatId) {
    await ctx.answerCallbackQuery().catch(() => undefined);
    return;
  }

  if (action === "noop") {
    await ctx.answerCallbackQuery({
      text: locale === "zh-CN" ? "请选择下面的统计项" : "Choose a stats item below"
    }).catch(() => undefined);
    return;
  }

  await ctx.answerCallbackQuery().catch(() => undefined);

  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!chat) {
    await editOrReply(ctx, locale === "zh-CN" ? "未找到这个已绑定群组。" : "That bound group was not found.", homeKeyboard(locale));
    return;
  }

  if (action === "home") {
    await openGroupStatsPanel(ctx, locale, chat);
    return;
  }

  const text = await renderGroupStatsActionText(chat.id, action, locale);
  await editOrReply(ctx, text, groupStatsKeyboard(chat.id, locale));
}

async function handleMemberStatsCallback(ctx: Context) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const locale = await getLocale(ctx);
  const [, action, chatId, value] = ctx.callbackQuery?.data?.split(":") ?? [];
  if (!action || !chatId || action === "noop") return;

  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!chat) {
    await editOrReply(ctx, locale === "zh-CN" ? "未找到这个已绑定群组。" : "That bound group was not found.", homeKeyboard(locale));
    return;
  }

  const allowed = await canConfigureChat(ctx, chat, ctx.from?.id ?? 0).catch(() => false);
  if (!allowed) {
    await ctx.answerCallbackQuery({
      text: locale === "zh-CN"
        ? "只有符合控制权限的管理员可以设置机器人。"
        : "Only permitted admins can configure the bot.",
      show_alert: true
    }).catch(() => undefined);
    return;
  }

  let settings = await getMemberStatsSettings(chat.id);
  if (action === "toggle") {
    settings.enabled = value === "on";
    await saveMemberStatsSettings(chat.id, settings);
    settings = await maybeRecordMemberCountSnapshot(ctx, chat, settings);
  } else if (action === "view") {
    const days = value === "31" ? 31 : 7;
    settings = await maybeRecordMemberCountSnapshot(ctx, chat, settings);
    await sendMemberStatsReport(ctx, chat, settings, days, locale);
    return;
  } else if (action === "close") {
    await ctx.deleteMessage().catch(() => undefined);
    return;
  }

  await editOrReply(ctx, memberStatsText(settings, locale), memberStatsKeyboard(chat, settings, locale));
}

async function handleGroupMembersCallback(ctx: Context) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const locale = await getLocale(ctx);
  const [, action, key, chatId] = ctx.callbackQuery?.data?.split(":") ?? [];
  if (!action || !chatId || action === "noop") return;

  const chat = await ensureControlPermissionForChatId(ctx, chatId, locale);
  if (!chat) return;

  const settings = await getGroupMembersSettings(chat.id);
  if (action === "toggle") {
    if (key === "nickname") settings.watchNicknameChange = !settings.watchNicknameChange;
    if (key === "username") settings.watchUsernameChange = !settings.watchUsernameChange;
    if (key === "unpin_linked_channel") settings.unpinLinkedChannelMessages = !settings.unpinLinkedChannelMessages;
    await saveGroupMembersSettings(chat.id, settings);
  }

  await editOrReply(ctx, groupMembersText(settings, locale), groupMembersKeyboard(chat, settings, locale));
}

async function handleControlPermissionsCallback(ctx: Context) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const locale = await getLocale(ctx);
  const parts = ctx.callbackQuery?.data?.split(":") ?? [];
  const mode = controlPermissionModeFromCallbackToken(parts[1]);
  const chatId = parts[2];
  if (!chatId || !isControlPermissionMode(mode)) return;

  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!chat) {
    await editOrReply(ctx, locale === "zh-CN" ? "找不到该管理对象。" : "Managed chat not found.", homeKeyboard(locale));
    return;
  }

  if (!(await ensureControlPermissionAccess(ctx, chat, locale))) return;
  await setControlPermissionMode(chat.id, mode);
  await openControlPermissionsPanel(ctx, locale, chat);
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

async function ensureControlPermissionAccess(ctx: Context, chat: PrismaChat, locale: Locale) {
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

async function ensureControlPermissionForChatId(ctx: Context, chatId: string, locale: Locale) {
  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!chat) {
    await editOrReply(ctx, locale === "zh-CN" ? "找不到该管理对象。" : "Managed chat not found.", homeKeyboard(locale));
    return null;
  }
  return await ensureControlPermissionAccess(ctx, chat, locale) ? chat : null;
}

function isConfigurationFeature(feature: string) {
  return [
    "permissions",
    "block",
    "welcome",
    "join_verify",
    "auto_delete",
    "auto_reply",
    "banned_words",
    "commands",
    "new_member_limit",
    "open_close",
    "adult_check",
    "speech_check",
    "anti_spam",
    "scheduled",
    "invite",
    "giveaway",
    "member_stats",
    "members"
  ].includes(feature);
}

async function openControlPermissionsPanel(ctx: Context, locale: Locale, chat: PrismaChat) {
  const scope = chat.type === "CHANNEL" ? "channel" : "group";
  const mode = await getControlPermissionMode(chat.id);
  const report = await getBotPermissionReport(ctx, Number(chat.telegramChatId)).catch(() => null);
  await editOrReply(ctx, controlPermissionsText(mode, report, locale), controlPermissionsKeyboard(chat.id, scope, mode, locale));
}

async function openGroupCommandsHome(ctx: Context, locale: Locale, chat: PrismaChat) {
  await editOrReply(ctx, groupCommandsHomeText(locale), groupCommandsHomeKeyboard(chat.id, locale));
}

async function openBannedWordsPanel(ctx: Context, locale: Locale, chat: PrismaChat) {
  const settings = await getBannedWordsSettings(chat.id);
  const count = await countBannedWords(chat.id);
  await editOrReply(ctx, bannedWordsText(settings, count, locale), bannedWordsKeyboard(chat.id, settings, locale));
}

function controlPermissionsText(
  mode: ControlPermissionMode,
  report: Awaited<ReturnType<typeof getBotPermissionReport>> | null,
  locale: Locale
) {
  const title = locale === "zh-CN" ? "<b>⚙️ 控制权限</b>" : "<b>⚙️ Permissions</b>";
  const selected = controlPermissionModeLabel(mode, locale);
  const reportText = report
    ? report.canManageBaseFeatures
      ? (locale === "zh-CN" ? "Bot 权限检查通过。" : "Bot permission check passed.")
      : `${locale === "zh-CN" ? "缺少权限：" : "Missing permissions:"}\n${report.missingPermissions.join("\n")}`
    : (locale === "zh-CN" ? "无法读取 Bot 权限。" : "Could not read Bot permissions.");

  return [
    title,
    "",
    locale === "zh-CN"
      ? "你可以指定哪些管理员能够设置机器人。"
      : "Choose which administrators can configure the bot.",
    "",
    `${locale === "zh-CN" ? "当前模式：" : "Current mode:"} ${selected}`,
    "",
    locale === "zh-CN"
      ? "提示：如果权限未生效，请切换按钮后重新勾选。"
      : "Tip: if permissions do not take effect, switch the button and select again.",
    "",
    reportText
  ].join("\n");
}

function controlPermissionsKeyboard(chatId: string, scope: "group" | "channel", mode: ControlPermissionMode, locale: Locale) {
  const selected = (active: boolean, label: string) => (active ? `✅${label}` : label);
  const labels = {
    allAdmins: locale === "zh-CN" ? "所有管理" : "All admins",
    promote: locale === "zh-CN" ? "拥有添加管理员权限" : "Can promote members",
    creator: locale === "zh-CN" ? "仅创建者" : "Creator only",
    restrict: locale === "zh-CN" ? "拥有封禁权限" : "Can restrict members",
    back: locale === "zh-CN" ? "返回" : "Back"
  };

  return new InlineKeyboard()
    .text(selected(mode === "all_admins", labels.allAdmins), `control_permissions:${controlPermissionCallbackTokens.all_admins}:${chatId}`)
    .row()
    .text(selected(mode === "can_promote_members", labels.promote), `control_permissions:${controlPermissionCallbackTokens.can_promote_members}:${chatId}`)
    .row()
    .text(selected(mode === "creator", labels.creator), `control_permissions:${controlPermissionCallbackTokens.creator}:${chatId}`)
    .row()
    .text(selected(mode === "can_restrict_members", labels.restrict), `control_permissions:${controlPermissionCallbackTokens.can_restrict_members}:${chatId}`)
    .row()
    .text(labels.back, `menu:chat:${scope}:${chatId}`);
}

function controlPermissionModeLabel(mode: ControlPermissionMode, locale: Locale) {
  if (locale === "zh-CN") {
    if (mode === "all_admins") return "所有管理";
    if (mode === "can_promote_members") return "拥有添加管理员权限";
    if (mode === "creator") return "仅创建者";
    return "拥有封禁权限";
  }

  if (mode === "all_admins") return "All admins";
  if (mode === "can_promote_members") return "Can promote members";
  if (mode === "creator") return "Creator only";
  return "Can restrict members";
}

async function openInviteLinkPanel(ctx: Context, locale: Locale, chat: PrismaChat) {
  const settings = await getInviteLinkSettings(chat.id);
  const stats = await getInviteLinkStats(chat.id);
  await editOrReply(ctx, inviteLinkText(chat, settings, stats, locale), inviteLinkKeyboard(chat.id, settings, locale));
}

async function openGiveawayPanel(ctx: Context, locale: Locale, chat: PrismaChat) {
  const [created, drawn, active, draft, cancelled] = await prisma.$transaction([
    prisma.giveaway.count({ where: { chatId: chat.id } }),
    prisma.giveaway.count({ where: { chatId: chat.id, status: GiveawayStatus.DRAWN } }),
    prisma.giveaway.count({ where: { chatId: chat.id, status: GiveawayStatus.ACTIVE } }),
    prisma.giveaway.count({ where: { chatId: chat.id, status: GiveawayStatus.DRAFT } }),
    prisma.giveaway.count({ where: { chatId: chat.id, status: GiveawayStatus.CANCELLED } })
  ]);

  await editOrReply(
    ctx,
    giveawayPanelText(chat, { created, drawn, pending: active + draft, cancelled }, locale),
    giveawayPanelKeyboard(chat.id, locale)
  );
}

function giveawayPanelText(
  chat: PrismaChat,
  stats: { created: number; drawn: number; pending: number; cancelled: number },
  locale: Locale
) {
  const title = escapeHtml(chat.title ?? chat.username ?? String(chat.telegramChatId));
  return locale === "zh-CN"
    ? [
        `<b>🎁[ ${title} ]抽奖</b>`,
        "",
        `创建的抽奖次数:<b>${stats.created}</b>`,
        "",
        `已开奖:<b>${stats.drawn}</b>       未开奖:<b>${stats.pending}</b>       取消:<b>${stats.cancelled}</b>`
      ].join("\n")
    : [
        `<b>🎁 [ ${title} ] Giveaways</b>`,
        "",
        `Created: <b>${stats.created}</b>`,
        "",
        `Drawn: <b>${stats.drawn}</b>       Pending: <b>${stats.pending}</b>       Cancelled: <b>${stats.cancelled}</b>`
      ].join("\n");
}

function giveawayPanelKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "➕ 发起抽奖活动" : "➕ Create giveaway", `giveaway:create:${chatId}`)
    .text(locale === "zh-CN" ? "📃 创建的抽奖记录" : "📃 Giveaway records", `giveaway:records:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "⚙ 抽奖设置" : "⚙ Giveaway settings", `giveaway:settings:${chatId}`)
    .text(locale === "zh-CN" ? "🏠 返回首页" : "🏠 Home", "menu:home");
}

function giveawayBackKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `chat_feature:giveaway:${chatId}`)
    .text(locale === "zh-CN" ? "🏠 返回首页" : "🏠 Home", "menu:home");
}

async function openGiveawayRecordsPanel(ctx: Context, locale: Locale, chat: PrismaChat) {
  const giveaways = await prisma.giveaway.findMany({
    where: { chatId: chat.id },
    include: { _count: { select: { entries: true } } },
    orderBy: { createdAt: "desc" },
    take: 10
  });

  const lines = giveaways.length
    ? giveaways.map((item, index) => [
        `${index + 1}. <b>${escapeHtml(item.title)}</b>`,
        `${locale === "zh-CN" ? "奖品" : "Prize"}: ${escapeHtml(item.prize)}`,
        `${locale === "zh-CN" ? "状态" : "Status"}: ${giveawayStatusLabel(item.status, locale)}    ${locale === "zh-CN" ? "参与" : "Entries"}: ${item._count.entries}`,
        `${locale === "zh-CN" ? "开奖时间" : "Draw at"}: ${formatDateTimeForDisplay(item.drawAt)}`
      ].join("\n"))
    : [locale === "zh-CN" ? "暂无抽奖记录。" : "No giveaway records yet."];

  await editOrReply(
    ctx,
    [
      locale === "zh-CN" ? "<b>📃 创建的抽奖记录</b>" : "<b>📃 Giveaway records</b>",
      "",
      ...lines
    ].join("\n\n"),
    giveawayBackKeyboard(chat.id, locale)
  );
}

async function openGiveawaySettingsPanel(ctx: Context, locale: Locale, chat: PrismaChat) {
  await editOrReply(
    ctx,
    locale === "zh-CN"
      ? [
          "<b>⚙ 抽奖设置</b>",
          "",
          "当前抽奖使用默认规则：用户点击按钮参与，到开奖时间自动随机开奖。",
          "后续可在这里接入参与门槛、积分消耗和开奖提醒等配置。"
        ].join("\n")
      : [
          "<b>⚙ Giveaway settings</b>",
          "",
          "Giveaways currently use the default rule: users join by button and winners are drawn automatically at the draw time.",
          "Join requirements, point cost and reminders can be wired here later."
        ].join("\n"),
    giveawayBackKeyboard(chat.id, locale)
  );
}

function giveawayStatusLabel(status: GiveawayStatus, locale: Locale) {
  if (locale === "zh-CN") {
    if (status === GiveawayStatus.ACTIVE) return "未开奖";
    if (status === GiveawayStatus.DRAFT) return "草稿";
    if (status === GiveawayStatus.DRAWN) return "已开奖";
    return "取消";
  }

  if (status === GiveawayStatus.ACTIVE) return "Pending";
  if (status === GiveawayStatus.DRAFT) return "Draft";
  if (status === GiveawayStatus.DRAWN) return "Drawn";
  return "Cancelled";
}

async function openPointsPanel(ctx: Context, locale: Locale, chat: PrismaChat) {
  if (ctx.from) pointsInputDrafts.delete(ctx.from.id);
  const settings = await getPointsSettings(chat.id);
  await editOrReply(ctx, pointsPanelText(settings, locale), pointsKeyboard(chat.id, settings, locale));
}

async function openPointsRulePanel(ctx: Context, locale: Locale, chat: PrismaChat, rule: "sign" | "speech" | "invite") {
  const settings = await getPointsSettings(chat.id);
  await editOrReply(ctx, pointsRuleText(settings, rule, locale), pointsRuleKeyboard(chat.id, settings, rule, locale));
}

async function openPointsAdjustPanel(ctx: Context, locale: Locale, chat: PrismaChat) {
  await editOrReply(
    ctx,
    locale === "zh-CN"
      ? [
          "Ⓜ️ 积分",
          "",
          "增加或者减少用户积分",
          "",
          "💡 群组内命令回复用户可以增减积分",
          "",
          "在群组中回复成员消息发送：",
          "<code>/points 10</code> 增加 10 积分",
          "<code>/points @xxx 10</code> @某人增加10积分",
          "<code>/points -10</code> 扣除 10 积分",
          "",
          "<code>/points_rank</code> 积分排名",
          "",
          "👉 <b>请输入 用户名 或 用户ID</b>"
        ].join("\n")
      : [
          "Ⓜ️ Points",
          "",
          "Add or deduct user points.",
          "",
          "Reply to a member in the group with:",
          "<code>/points 10</code> to add 10 points",
          "<code>/points @xxx 10</code> to add 10 points to @xxx",
          "<code>/points -10</code> to deduct 10 points",
          "",
          "<code>/points_rank</code> points ranking",
          "",
          "👉 <b>Send a username or user ID</b>"
        ].join("\n"),
    pointsBackKeyboard(chat.id, locale)
  );
  if (ctx.from) {
    clearUserInputState(ctx.from.id);
    pointsInputDrafts.set(ctx.from.id, { chatId: chat.id, kind: "adjust_user" });
  }
}

async function openPointsExchangePanel(ctx: Context, locale: Locale, chat: PrismaChat) {
  const settings = await getPointExchangeSettings(chat.id);
  await editOrReply(
    ctx,
    pointExchangeText(settings, locale),
    pointExchangeKeyboard(chat.id, settings, locale)
  );
}

async function openPointAliasInputPanel(ctx: Context, locale: Locale, chat: PrismaChat, command: Extract<GroupCommandKey, "points" | "points_rank">) {
  const settings = await getGroupCommandSettings(chat.id);
  if (ctx.from) {
    clearUserInputState(ctx.from.id);
    pointsInputDrafts.set(ctx.from.id, { chatId: chat.id, kind: "alias", command });
  }
  await editOrReply(
    ctx,
    pointAliasInputText(settings.aliases[command], command, locale),
    pointsBackKeyboard(chat.id, locale)
  );
}

async function openExchangeKeywordInputPanel(ctx: Context, locale: Locale, chat: PrismaChat) {
  if (ctx.from) {
    clearUserInputState(ctx.from.id);
    pointsInputDrafts.set(ctx.from.id, { chatId: chat.id, kind: "exchange_keyword" });
  }
  await editOrReply(ctx, exchangeKeywordInputText(locale), new InlineKeyboard().text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `points:exchange:${chat.id}`));
}

async function openProductsPanel(ctx: Context, locale: Locale, chat: PrismaChat) {
  const settings = await getPointExchangeSettings(chat.id);
  await editOrReply(ctx, productsText(locale), productsKeyboard(chat.id, settings, locale));
}

async function openProductPanel(ctx: Context, locale: Locale, chat: PrismaChat, productId: string) {
  const settings = await getPointExchangeSettings(chat.id);
  const product = settings.products.find((item) => item.id === productId);
  if (!product) {
    await openProductsPanel(ctx, locale, chat);
    return;
  }
  await editOrReply(ctx, productText(product, locale), productKeyboard(chat.id, product, locale));
}

async function handleBlocklistCallback(ctx: Context) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const locale = await getLocale(ctx);
  const parts = ctx.callbackQuery?.data?.split(":") ?? [];
  const action = parts[1];
  if (!action) return;

  if (action === "back") {
    const chatId = parts[2];
    if (!chatId) return;
    const chat = await ensureControlPermissionForChatId(ctx, chatId, locale);
    if (!chat) return;
    const settings = await getBlocklistSettings(chat.id);
    await editOrReply(ctx, blocklistText(settings, locale), blocklistKeyboard(chat.id, locale));
    return;
  }

  if (action === "menu") {
    const panel = parts[2];
    const chatId = parts[3];
    if (!panel || !chatId) return;
    const chat = await ensureControlPermissionForChatId(ctx, chatId, locale);
    if (!chat) return;
    const settings = await getBlocklistSettings(chat.id);
    await renderBlocklistPanel(ctx, chat.id, panel, settings, locale);
    return;
  }

  if (action === "toggle") {
    const key = parts[2];
    const legacyChatId = parts[3];
    if (!key || !legacyChatId) return;
    const chat = await ensureControlPermissionForChatId(ctx, legacyChatId, locale);
    if (!chat) return;
    const legacySettings = await getBlocklistSettings(legacyChatId);
    if (key in legacySettings && typeof legacySettings[key as keyof BlocklistSettings] === "boolean") {
      const typedKey = key as keyof Pick<BlocklistSettings, "blockBots" | "banAfterLeave" | "blockFlashJoinLeave" | "blockFollowerRaid">;
      legacySettings[typedKey] = !legacySettings[typedKey];
      if (typedKey === "blockBots") legacySettings.blockBotPunishment = legacySettings.blockBots ? "ban" : "off";
      await saveBlocklistSettings(legacyChatId, legacySettings);
    }
    await editOrReply(ctx, blocklistText(legacySettings, locale), blocklistKeyboard(legacyChatId, locale));
    return;
  }

  const chatId = parts[2];
  const value = parts[3];
  if (!chatId) return;
  const chat = await ensureControlPermissionForChatId(ctx, chatId, locale);
  if (!chat) return;
  const settings = await getBlocklistSettings(chatId);

  if (action === "bot" && isBlocklistBotPunishment(value)) {
    settings.blockBotPunishment = value;
    settings.blockBots = value !== "off";
    await saveBlocklistSettings(chatId, settings);
    await editOrReply(ctx, blocklistBotText(settings, locale), blocklistBotKeyboard(chatId, settings, locale));
    return;
  }

  if (action === "leave" && (value === "off" || value === "ban")) {
    settings.banAfterLeave = value === "ban";
    await saveBlocklistSettings(chatId, settings);
    await editOrReply(ctx, blocklistLeaveText(settings, locale), blocklistLeaveKeyboard(chatId, settings, locale));
    return;
  }
}

async function renderBlocklistPanel(
  ctx: Context,
  chatId: string,
  panel: string,
  settings: BlocklistSettings,
  locale: Locale
) {
  if (panel === "bots") {
    await editOrReply(ctx, blocklistBotText(settings, locale), blocklistBotKeyboard(chatId, settings, locale));
    return;
  }
  if (panel === "leave") {
    await editOrReply(ctx, blocklistLeaveText(settings, locale), blocklistLeaveKeyboard(chatId, settings, locale));
    return;
  }
  if (panel === "flash") {
    await editOrReply(ctx, blocklistFlashText(locale), blocklistPremiumKeyboard(chatId, locale));
    return;
  }
  if (panel === "raid") {
    await editOrReply(ctx, blocklistRaidText(locale), blocklistPremiumKeyboard(chatId, locale));
  }
}

async function handleWelcomeCallback(ctx: Context) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const locale = await getLocale(ctx);
  const data = ctx.callbackQuery?.data;
  const [, action, chatId, value] = data?.split(":") ?? [];
  if (!action || !chatId || action === "noop") return;

  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!chat) {
    await editOrReply(ctx, locale === "zh-CN" ? "未找到这个已绑定群组。" : "That bound group was not found.", homeKeyboard(locale));
    return;
  }

  if (!(await ensureControlPermissionAccess(ctx, chat, locale))) return;

  const settings = await getWelcomeSettings(chatId);

  if (action === "toggle") {
    settings.enabled = !settings.enabled;
    await saveWelcomeSettings(chatId, settings);
    await editOrReply(ctx, welcomeText(settings, locale), welcomeKeyboard(chatId, settings, locale));
    return;
  }

  if (action === "status" && (value === "on" || value === "off")) {
    settings.enabled = value === "on";
    await saveWelcomeSettings(chatId, settings);
    await editOrReply(ctx, welcomeText(settings, locale), welcomeKeyboard(chatId, settings, locale));
    return;
  }

  if (action === "delete_after") {
    settings.deleteAfterMinutes = clampNumber(Number(value ?? 0), 0, 1440);
    await saveWelcomeSettings(chatId, settings);
    await editOrReply(ctx, welcomeText(settings, locale), welcomeKeyboard(chatId, settings, locale));
    return;
  }

  if (action === "delete_last") {
    await deleteStoredWelcomeMessages(ctx, chat, settings);
    settings.lastMessageIds = [];
    await saveWelcomeSettings(chatId, settings);
    await editOrReply(ctx, welcomeText(settings, locale), welcomeKeyboard(chatId, settings, locale));
    return;
  }

  if (action === "preview") {
    if (!ctx.from) return;
    await sendWelcomePreview(ctx, chat, ctx.from, settings, locale);
    return;
  }

  if (action === "edit" && isWelcomeInputField(value)) {
    if (!ctx.from) return;
    clearUserInputState(ctx.from.id);
    welcomeInputDrafts.set(ctx.from.id, { chatId, field: value });
    await editOrReply(ctx, welcomeInputPromptText(value, settings, locale), welcomeInputKeyboard(chatId, value, locale));
    return;
  }

  if (action === "clear" && isWelcomeInputField(value)) {
    clearWelcomeField(settings, value);
    await saveWelcomeSettings(chatId, settings);
    await editOrReply(ctx, welcomeText(settings, locale), welcomeKeyboard(chatId, settings, locale));
    return;
  }

  await editOrReply(ctx, welcomeText(settings, locale), welcomeKeyboard(chatId, settings, locale));
}

async function handleJoinVerifyCallback(ctx: Context) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const parts = ctx.callbackQuery?.data?.split(":") ?? [];
  const action = parts[1];
  const value = parts[2];
  const chatId = parts[3] ?? (
    action === "toggle" || action === "approval" || action === "noop" ? value : undefined
  );
  if (!action || !chatId) return;

  const locale = await getLocale(ctx);
  if (!(await ensureControlPermissionForChatId(ctx, chatId, locale))) return;

  const settings = await getJoinVerifySettings(chatId);
  let changed = false;

  if (action === "status" && (value === "on" || value === "off")) {
    settings.enabled = value === "on";
    changed = true;
  } else if (action === "approval" && (value === "on" || value === "off")) {
    settings.adminApproval = value === "on";
    changed = true;
  } else if (action === "mode" && isJoinVerifyMode(value)) {
    settings.mode = value;
    changed = true;
  } else if (action === "duration" && (value === "1" || value === "5" || value === "10")) {
    settings.durationMinutes = Number(value);
    changed = true;
  } else if (action === "punishment" && (value === "mute" || value === "kick")) {
    settings.punishment = value;
    changed = true;
  } else if (action === "toggle") {
    settings.enabled = !settings.enabled;
    changed = true;
  } else if (action === "approval" && parts[3] === undefined) {
    settings.adminApproval = !settings.adminApproval;
    changed = true;
  }

  if (changed) {
    await saveSetting(chatId, "join_verify", settingsToJson(settings));
  }

  await editOrReply(ctx, joinVerifyText(settings, locale), joinVerifyKeyboard(chatId, settings, locale));
}

async function handleAutoDeleteCallback(ctx: Context) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const data = ctx.callbackQuery?.data;
  const parts = data?.split(":") ?? [];
  const action = parts[1];
  const chatId = action === "set" ? parts[4] : parts[3] ?? parts[2];
  if (!action || !chatId || action === "noop") return;

  const locale = await getLocale(ctx);
  if (!(await ensureControlPermissionForChatId(ctx, chatId, locale))) return;

  const settings = await getAutoDeleteSettings(chatId);
  if (action === "set" && isAutoDeleteEventKey(parts[2]) && (parts[3] === "on" || parts[3] === "off")) {
    settings[parts[2]] = parts[3] === "on";
  } else if (action === "toggle") {
    const enabled = !autoDeleteEventKeys.some((key) => settings[key]);
    for (const key of autoDeleteEventKeys) settings[key] = enabled;
  } else if (action === "seconds" && parts[2]) {
    settings.seconds = clampNumber(Number(parts[2]), 0, 86400);
  }
  settings.enabled = autoDeleteEventKeys.some((key) => settings[key]);
  await saveSetting(chatId, "auto_delete", settingsToJson(settings));

  await editOrReply(ctx, autoDeleteText(settings, locale), autoDeleteKeyboard(chatId, settings, locale));
}

async function handleAutoReplyCallback(ctx: Context, config: AppConfig) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const parts = data.split(":");
  const action = parts[1];
  if (!action) return;

  const draft = ctx.from ? autoReplyInputDrafts.get(ctx.from.id) : undefined;
  let chatId: string | undefined;
  let value: string | undefined;
  if (action === "cancel" || action === "skip_buttons") {
    chatId = draft?.chatId ?? parts[2] ?? (ctx.from ? autoReplySelectedChats.get(ctx.from.id) : undefined);
  } else if (action === "trigger") {
    if (parts[2] === "exact" || parts[2] === "contains") {
      chatId = draft?.chatId;
      value = parts[2];
    } else {
      chatId = parts[2];
      value = parts[3];
    }
  } else {
    chatId = parts[2];
    value = parts[3];
  }
  if (!chatId) return;

  const locale = await getLocale(ctx);
  if (!(await ensureControlPermissionForChatId(ctx, chatId, locale))) return;

  const settings = await getAutoReplySettings(chatId);

  if (action === "cancel") {
    if (ctx.from) autoReplyInputDrafts.delete(ctx.from.id);
    await editOrReply(ctx, autoReplyText(settings, locale, config.botUsername), autoReplyKeyboard(chatId, settings, locale));
    return;
  }

  if (action === "noop") return;

  if (action === "toggle") {
    settings.enabled = value !== "off";
    await saveAutoReplySettings(chatId, settings);
    await editOrReply(ctx, autoReplyText(settings, locale, config.botUsername), autoReplyKeyboard(chatId, settings, locale));
    return;
  }

  if (action === "delete_after") {
    settings.deleteAfterMinutes = clampNumber(Number(value ?? 0), 0, 1440);
    await saveAutoReplySettings(chatId, settings);
    await editOrReply(ctx, autoReplyText(settings, locale, config.botUsername), autoReplyKeyboard(chatId, settings, locale));
    return;
  }

  if (action === "delete_previous") {
    settings.deletePreviousMessage = value === "on";
    await saveAutoReplySettings(chatId, settings);
    await editOrReply(ctx, autoReplyText(settings, locale, config.botUsername), autoReplyKeyboard(chatId, settings, locale));
    return;
  }

  if (action === "skip_buttons") {
    if (!ctx.from) return;
    const draft = autoReplyInputDrafts.get(ctx.from.id);
    if (!draft || draft.chatId !== chatId || draft.stage !== "buttons") return;
    delete draft.buttons;
    draft.stage = "trigger";
    await editOrReply(ctx, autoReplyTriggerPromptText(locale), autoReplyTriggerKeyboard(chatId, locale));
    return;
  }

  if (action === "trigger" && (value === "exact" || value === "contains")) {
    if (!ctx.from) return;
    const draft = autoReplyInputDrafts.get(ctx.from.id);
    if (!draft || draft.chatId !== chatId || draft.stage !== "trigger") return;
    draft.matchType = value;
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
    if (!ctx.from) return;
    clearUserInputState(ctx.from.id);
    autoReplyInputDrafts.set(ctx.from.id, { chatId, stage: "delete" });
    await editOrReply(ctx, autoReplyDeletePromptText(settings, locale), autoReplyCancelKeyboard(chatId, locale));
    return;
  }

  if (action === "delete_rule" && value) {
    settings.rules = settings.rules.filter((rule) => rule.id !== value);
    await saveAutoReplySettings(chatId, settings);
    await editOrReply(ctx, autoReplyText(settings, locale, config.botUsername), autoReplyKeyboard(chatId, settings, locale));
  }
}

async function handleBannedWordsCallback(ctx: Context) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const parts = ctx.callbackQuery?.data?.split(":") ?? [];
  const action = parts[1];
  const chatId = parts[2];
  const value = parts[3];
  if (!action || !chatId) return;

  const locale = await getLocale(ctx);
  const chat = await ensureControlPermissionForChatId(ctx, chatId, locale);
  if (!chat) return;

  if (action === "cancel") {
    if (ctx.from) bannedWordsInputDrafts.delete(ctx.from.id);
    await openBannedWordsPanel(ctx, locale, chat);
    return;
  }

  if (action === "noop") return;

  const settings = await getBannedWordsSettings(chatId);

  if (action === "status" && (value === "on" || value === "off")) {
    settings.enabled = value === "on";
    await saveBannedWordsSettings(chatId, settings);
    await openBannedWordsPanel(ctx, locale, chat);
    return;
  }

  if (action === "notice") {
    await editOrReply(ctx, bannedWordsNoticeText(locale), bannedWordsNoticeKeyboard(chatId, settings, locale));
    return;
  }

  if (action === "notice_delay") {
    const seconds = clampNumber(Number(value ?? defaultBannedWordsSettings.noticeDeleteSeconds), -1, 43200);
    settings.noticeDeleteSeconds = seconds;
    settings.deleteNotice = seconds >= 0;
    await saveBannedWordsSettings(chatId, settings);
    await editOrReply(ctx, bannedWordsNoticeText(locale), bannedWordsNoticeKeyboard(chatId, settings, locale));
    return;
  }

  if (action === "punishment") {
    if (isBannedWordsPunishment(value)) {
      settings.punishment = value;
      await saveBannedWordsSettings(chatId, settings);
    }
    await editOrReply(ctx, bannedWordsPunishmentText(settings, locale), bannedWordsPunishmentKeyboard(chatId, settings, locale));
    return;
  }

  if (action === "warning_limit") {
    settings.warningLimit = clampNumber(Number(value ?? settings.warningLimit), 1, 5);
    await saveBannedWordsSettings(chatId, settings);
    await editOrReply(ctx, bannedWordsPunishmentText(settings, locale), bannedWordsPunishmentKeyboard(chatId, settings, locale));
    return;
  }

  if (action === "warn_action" && isBannedWordsFinalPunishment(value)) {
    settings.warningPunishment = value;
    await saveBannedWordsSettings(chatId, settings);
    await editOrReply(ctx, bannedWordsPunishmentText(settings, locale), bannedWordsPunishmentKeyboard(chatId, settings, locale));
    return;
  }

  if (action === "mute_duration") {
    if (!ctx.from) return;
    clearUserInputState(ctx.from.id);
    bannedWordsInputDrafts.set(ctx.from.id, { chatId, stage: "mute_duration" });
    await editOrReply(ctx, bannedWordsMuteDurationPromptText(settings, locale), bannedWordsMuteDurationKeyboard(chatId, locale));
    return;
  }

  if (action === "mute_forever") {
    settings.muteMinutes = 0;
    await saveBannedWordsSettings(chatId, settings);
    await editOrReply(ctx, bannedWordsPunishmentText(settings, locale), bannedWordsPunishmentKeyboard(chatId, settings, locale));
    return;
  }

  if (action === "add") {
    if (!ctx.from) return;
    clearUserInputState(ctx.from.id);
    bannedWordsInputDrafts.set(ctx.from.id, { chatId, stage: "add" });
    await editOrReply(ctx, bannedWordsAddPromptText(locale), bannedWordsCancelKeyboard(chatId, locale));
    return;
  }

  if (action === "list") {
    await editOrReply(ctx, await bannedWordsListText(chatId, locale), bannedWordsListKeyboard(chatId, locale));
    return;
  }

  if (action === "delete") {
    if (!ctx.from) return;
    const rules = await listBannedWordRules(chatId, 100);
    if (!rules.length) {
      await ctx.answerCallbackQuery({ text: locale === "zh-CN" ? "暂无可删除的违禁词。" : "No banned words to delete." }).catch(() => undefined);
      return;
    }
    clearUserInputState(ctx.from.id);
    bannedWordsInputDrafts.set(ctx.from.id, { chatId, stage: "delete" });
    await editOrReply(ctx, await bannedWordsDeletePromptText(chatId, locale), bannedWordsDeleteKeyboard(chatId, rules, locale));
    return;
  }

  if (action === "delete_rule" && value) {
    await prisma.moderationRule.deleteMany({
      where: { id: value, chatId, ruleType: RuleType.KEYWORD }
    });
    await editOrReply(ctx, await bannedWordsListText(chatId, locale), bannedWordsListKeyboard(chatId, locale));
  }
}


async function handleGroupCommandsCallback(ctx: Context) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const locale = await getLocale(ctx);
  const [, action, chatId, value] = ctx.callbackQuery?.data?.split(":") ?? [];
  if (!action || !chatId) return;

  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!chat) {
    await editOrReply(ctx, locale === "zh-CN" ? "找不到该管理对象。" : "Managed chat not found.", homeKeyboard(locale));
    return;
  }

  if (!(await ensureControlPermissionAccess(ctx, chat, locale))) return;

  if (action === "home") {
    if (ctx.from) groupCommandAliasInputDrafts.delete(ctx.from.id);
    await openGroupCommandsHome(ctx, locale, chat);
    return;
  }

  if (action === "list") {
    if (ctx.from) groupCommandAliasInputDrafts.delete(ctx.from.id);
    const settings = await getGroupCommandSettings(chatId);
    await editOrReply(ctx, groupCommandsText(settings, locale), groupCommandsKeyboard(chatId, settings, locale));
    return;
  }

  if (action === "aliases") {
    if (ctx.from) groupCommandAliasInputDrafts.delete(ctx.from.id);
    const settings = await getGroupCommandSettings(chatId);
    await editOrReply(ctx, groupCommandAliasesText(settings, locale), groupCommandsAliasKeyboard(chatId, settings, locale));
    return;
  }

  if (action === "alias" && isGroupCommandKey(value)) {
    if (ctx.from) groupCommandAliasInputDrafts.delete(ctx.from.id);
    const settings = await getGroupCommandSettings(chatId);
    await editOrReply(ctx, groupCommandAliasDetailText(settings, value, locale), groupCommandAliasDetailKeyboard(chatId, value, locale));
    return;
  }

  if ((action === "alias_add" || action === "alias_delete") && isGroupCommandKey(value)) {
    if (!ctx.from) return;
    clearUserInputState(ctx.from.id);
    groupCommandAliasInputDrafts.set(ctx.from.id, { chatId, command: value, mode: action === "alias_delete" ? "delete" : "add" });
    await editOrReply(
      ctx,
      groupCommandAliasInputPromptText(action === "alias_delete" ? "delete" : "add", value, locale),
      groupCommandAliasInputKeyboard(chatId, value, locale)
    );
    return;
  }

  if (action === "toggle" && isGroupCommandKey(value)) {
    const settings = await getGroupCommandSettings(chatId);
    settings.commands[value] = !settings.commands[value];
    await saveGroupCommandSettings(chatId, settings);
    await editOrReply(ctx, groupCommandsText(settings, locale), groupCommandsKeyboard(chatId, settings, locale));
  }
}

async function handlePointsCallback(ctx: Context) {
  const locale = await getLocale(ctx);
  const [, action, chatId, value, rawNext] = ctx.callbackQuery?.data?.split(":") ?? [];
  if (!action || !chatId) return;
  if (action === "noop" || action === "exchange_noop" || action === "product_noop") {
    await ctx.answerCallbackQuery().catch(() => undefined);
    return;
  }
  if (action !== "exchange_redeem") {
    await ctx.answerCallbackQuery().catch(() => undefined);
  }

  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!chat) {
    await editOrReply(ctx, locale === "zh-CN" ? "找不到该管理对象。" : "Managed chat not found.", homeKeyboard(locale));
    return;
  }

  if (ctx.from) pointsInputDrafts.delete(ctx.from.id);

  if (action === "exchange_redeem" && value) {
    await handlePointExchangeRedeem(ctx, locale, chat, value);
    return;
  }

  if (!(await ensureControlPermissionAccess(ctx, chat, locale))) return;

  if (action === "alias" && (value === "points" || value === "points_rank")) {
    await openPointAliasInputPanel(ctx, locale, chat, value);
    return;
  }

  if (action === "status") {
    const settings = await getPointsSettings(chatId);
    settings.enabled = value === "on";
    await savePointsSettings(chatId, settings);
    await openPointsPanel(ctx, locale, chat);
    return;
  }

  if (action === "delete_sign") {
    const settings = await getPointsSettings(chatId);
    settings.deleteSignInMessage = value === "on";
    await savePointsSettings(chatId, settings);
    await openPointsPanel(ctx, locale, chat);
    return;
  }

  if (action === "rule" && (value === "sign" || value === "speech" || value === "invite")) {
    await openPointsRulePanel(ctx, locale, chat, value);
    return;
  }

  if (action === "set" && isPointsRuleField(value)) {
    const nextValue = Number(rawNext);
    if (!Number.isInteger(nextValue)) return;
    const settings = await getPointsSettings(chatId);
    setPointsRuleField(settings, value, nextValue);
    await savePointsSettings(chatId, settings);
    await openPointsRulePanel(ctx, locale, chat, pointsRuleForField(value));
    return;
  }

  if (action === "adjust") {
    await openPointsAdjustPanel(ctx, locale, chat);
    return;
  }

  if (action === "exchange") {
    await openPointsExchangePanel(ctx, locale, chat);
    return;
  }

  if (action === "exchange_status") {
    const settings = await getPointExchangeSettings(chatId);
    settings.enabled = value === "on";
    await savePointExchangeSettings(chatId, settings);
    await openPointsExchangePanel(ctx, locale, chat);
    return;
  }

  if (action === "exchange_keyword") {
    await openExchangeKeywordInputPanel(ctx, locale, chat);
    return;
  }

  if (action === "products") {
    await openProductsPanel(ctx, locale, chat);
    return;
  }

  if (action === "product_add") {
    const settings = await getPointExchangeSettings(chatId);
    const product = createPointProduct();
    settings.products.push(product);
    await savePointExchangeSettings(chatId, settings);
    await openProductPanel(ctx, locale, chat, product.id);
    return;
  }

  if (action === "product" && value) {
    await openProductPanel(ctx, locale, chat, value);
    return;
  }

  if (action === "product_listed" && value) {
    const settings = await getPointExchangeSettings(chatId);
    const product = settings.products.find((item) => item.id === value);
    if (product) {
      product.listed = rawNext === "on";
      await savePointExchangeSettings(chatId, settings);
    }
    await openProductPanel(ctx, locale, chat, value);
    return;
  }

  if (action === "product_edit" && value && rawNext) {
    const kind = pointProductInputKind(rawNext);
    if (!kind || !ctx.from) return;
    clearUserInputState(ctx.from.id);
    pointsInputDrafts.set(ctx.from.id, { chatId, kind, productId: value });
    await editOrReply(ctx, productInputPromptText(kind, locale), new InlineKeyboard().text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `points:product:${chatId}:${value}`));
    return;
  }

  if (action === "product_codes" && value) {
    const settings = await getPointExchangeSettings(chatId);
    const product = settings.products.find((item) => item.id === value);
    await editOrReply(
      ctx,
      pointProductCodesText(product, locale),
      new InlineKeyboard().text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `points:product:${chatId}:${value}`)
    );
    return;
  }

  if (action === "exchange_records") {
    await editOrReply(ctx, await pointExchangeRecordsText(chatId, locale), new InlineKeyboard().text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `points:exchange:${chatId}`));
    return;
  }

  if (action === "clear") {
    await editOrReply(
      ctx,
      locale === "zh-CN"
        ? "Ⓜ️ 积分\n\n🚨🚨 请注意，即将清空该群所有积分数据，操作不可恢复，是否继续："
        : "Ⓜ️ Points\n\n🚨 This will clear all point data for this group and cannot be recovered. Continue?",
      pointsConfirmClearKeyboard(chatId, locale)
    );
    return;
  }

  if (action === "clear_confirm") {
    await prisma.$transaction([
      prisma.chatPointTransaction.deleteMany({ where: { chatId } }),
      prisma.chatPointBalance.deleteMany({ where: { chatId } })
    ]);
    await openPointsPanel(ctx, locale, chat);
  }
}

async function handlePointsInputMessage(ctx: Context, config: AppConfig, locale: Locale) {
  if (!ctx.from) return false;
  const draft = pointsInputDrafts.get(ctx.from.id);
  if (!draft) return false;

  const chat = await ensureControlPermissionForChatId(ctx, draft.chatId, locale);
  if (!chat) {
    pointsInputDrafts.delete(ctx.from.id);
    return true;
  }

  const text = getMessageText(ctx.message)?.trim() ?? "";
  if (!text) {
    await ctx.reply(pointsInputInvalidText(locale), { parse_mode: "HTML", reply_markup: pointsBackKeyboard(draft.chatId, locale) });
    return true;
  }

  if (draft.kind === "alias") {
    const aliases = parseGroupCommandAliases(text);
    if (!aliases.length) {
      await ctx.reply(pointAliasInputText([], draft.command, locale), { parse_mode: "HTML", reply_markup: pointsBackKeyboard(draft.chatId, locale) });
      return true;
    }
    const settings = await getGroupCommandSettings(draft.chatId);
    const normalized = new Set(aliases.map(normalizeGroupCommandAlias));
    for (const item of groupCommandDefinitions) {
      if (item.key === draft.command) continue;
      settings.aliases[item.key] = settings.aliases[item.key].filter((itemAlias) => !normalized.has(normalizeGroupCommandAlias(itemAlias)));
    }
    settings.aliases[draft.command] = aliases;
    await saveGroupCommandSettings(draft.chatId, settings);
    pointsInputDrafts.delete(ctx.from.id);
    await ctx.reply(pointAliasSavedText(locale), { parse_mode: "HTML", reply_markup: pointsBackKeyboard(draft.chatId, locale) });
    return true;
  }

  if (draft.kind === "exchange_keyword") {
    const settings = await getPointExchangeSettings(draft.chatId);
    settings.keyword = text.slice(0, 32);
    await savePointExchangeSettings(draft.chatId, settings);
    pointsInputDrafts.delete(ctx.from.id);
    await ctx.reply(locale === "zh-CN" ? "兑换关键词已更新。" : "Exchange keyword updated.", {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `points:exchange:${draft.chatId}`)
    });
    return true;
  }

  if (draft.kind === "adjust_user") {
    const target = await findPointTargetUser(chat.id, text);
    if (!target) {
      await ctx.reply(locale === "zh-CN" ? "找不到该用户，请输入已在本群产生记录的用户名或用户ID。" : "User not found. Send a username or user ID already known in this group.", {
        parse_mode: "HTML",
        reply_markup: pointsBackKeyboard(draft.chatId, locale)
      });
      return true;
    }
    pointsInputDrafts.set(ctx.from.id, { chatId: draft.chatId, kind: "adjust_amount", targetUserId: target.id });
    await ctx.reply(pointAdjustAmountPromptText(target, locale), {
      parse_mode: "HTML",
      reply_markup: pointsBackKeyboard(draft.chatId, locale)
    });
    return true;
  }

  if (draft.kind === "adjust_amount") {
    const delta = Number(text);
    if (!Number.isInteger(delta) || delta === 0) {
      await ctx.reply(locale === "zh-CN" ? "请输入非 0 整数，例如 <code>10</code> 或 <code>-10</code>。" : "Send a non-zero integer, for example <code>10</code> or <code>-10</code>.", {
        parse_mode: "HTML",
        reply_markup: pointsBackKeyboard(draft.chatId, locale)
      });
      return true;
    }
    const actor = await upsertTelegramUser(ctx.from, config.defaultTimezone);
    const balance = await addPoints(draft.chatId, draft.targetUserId, delta, PointTransactionType.MANUAL, null, actor.id);
    pointsInputDrafts.delete(ctx.from.id);
    await ctx.reply(locale === "zh-CN" ? `已调整，当前积分：${balance}` : `Adjusted. Current points: ${balance}`, {
      parse_mode: "HTML",
      reply_markup: pointsBackKeyboard(draft.chatId, locale)
    });
    return true;
  }

  const settings = await getPointExchangeSettings(draft.chatId);
  const product = settings.products.find((item) => item.id === draft.productId);
  if (!product) {
    pointsInputDrafts.delete(ctx.from.id);
    await openProductsPanel(ctx, locale, chat);
    return true;
  }

  if (draft.kind === "product_name") {
    product.name = text.slice(0, 64);
  } else if (draft.kind === "product_cost") {
    const cost = parseNonNegativeInteger(text);
    if (cost === null || cost <= 0) {
      await ctx.reply(productInputPromptText(draft.kind, locale), { parse_mode: "HTML", reply_markup: new InlineKeyboard().text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `points:product:${draft.chatId}:${draft.productId}`) });
      return true;
    }
    product.cost = clampNumber(cost, 1, 1000000);
  } else if (draft.kind === "product_daily_limit") {
    const dailyLimit = parseNonNegativeInteger(text);
    if (dailyLimit === null) {
      await ctx.reply(productInputPromptText(draft.kind, locale), { parse_mode: "HTML", reply_markup: new InlineKeyboard().text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `points:product:${draft.chatId}:${draft.productId}`) });
      return true;
    }
    product.dailyLimit = clampNumber(dailyLimit, 0, 1000000);
  } else if (draft.kind === "product_codes") {
    product.codes = parsePointProductCodes(text);
  }

  await savePointExchangeSettings(draft.chatId, settings);
  pointsInputDrafts.delete(ctx.from.id);
  await ctx.reply(locale === "zh-CN" ? "商品设置已更新。" : "Product updated.", {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard().text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `points:product:${draft.chatId}:${draft.productId}`)
  });
  return true;
}

async function handleGroupCommandAliasInputMessage(ctx: Context, locale: Locale) {
  if (!ctx.from) return false;
  const draft = groupCommandAliasInputDrafts.get(ctx.from.id);
  if (!draft) return false;

  const chat = await ensureControlPermissionForChatId(ctx, draft.chatId, locale);
  if (!chat) {
    groupCommandAliasInputDrafts.delete(ctx.from.id);
    return true;
  }

  const text = getMessageText(ctx.message);
  const aliases = text ? parseGroupCommandAliases(text) : [];
  if (!aliases.length) {
    await ctx.reply(groupCommandAliasInputPromptText(draft.mode, draft.command, locale), {
      parse_mode: "HTML",
      reply_markup: groupCommandAliasInputKeyboard(draft.chatId, draft.command, locale)
    });
    return true;
  }

  const settings = await getGroupCommandSettings(draft.chatId);
  const current = new Set(settings.aliases[draft.command].map(normalizeGroupCommandAlias));
  let changed = 0;
  if (draft.mode === "add") {
    for (const alias of aliases) {
      const normalized = normalizeGroupCommandAlias(alias);
      if (!normalized) continue;
      for (const item of groupCommandDefinitions) {
        if (item.key !== draft.command) {
          settings.aliases[item.key] = settings.aliases[item.key].filter((itemAlias) => normalizeGroupCommandAlias(itemAlias) !== normalized);
        }
      }
      if (!current.has(normalized)) {
        current.add(normalized);
        changed += 1;
      }
    }
  } else {
    for (const alias of aliases) {
      if (current.delete(normalizeGroupCommandAlias(alias))) changed += 1;
    }
  }

  const nextAliases = [...current].filter(Boolean).sort((a, b) => a.localeCompare(b));
  settings.aliases[draft.command] = nextAliases;
  await saveGroupCommandSettings(draft.chatId, settings);
  groupCommandAliasInputDrafts.delete(ctx.from.id);
  await ctx.reply(groupCommandAliasSavedText(changed, draft.mode, locale), {
    parse_mode: "HTML",
    reply_markup: groupCommandAliasDetailKeyboard(chat.id, draft.command, locale)
  });
  return true;
}

async function handleIncomingMessage(ctx: Context, config: AppConfig) {
  const message = ctx.message;
  if (!message || !ctx.chat) return;

  const chat = await getActiveChatByTelegramId(ctx.chat.id);
  if (chat && ctx.from && isGroupLike(ctx.chat)) {
    await recordMessageStat(chat.id, ctx.from, config.defaultTimezone);
    await maybeRecordMemberCountSnapshot(ctx, chat);
  }

  if (chat) {
    await maybeHandleGroupMembersMessage(ctx, chat, message);
  }

  if ("new_chat_members" in message && message.new_chat_members?.length) {
    if (chat) await maybeAutoDelete(ctx, chat.id, message);
    await handleNewChatMembers(ctx, config, message.new_chat_members);
    return;
  }

  if ("left_chat_member" in message && message.left_chat_member) {
    if (chat) await maybeAutoDelete(ctx, chat.id, message);
    await handleBlocklistLeftChatMember(ctx, message.left_chat_member);
    if (chat) await recordStatsEvent(chat.id, ChatStatsEventType.LEAVE, ctx.from, message.left_chat_member, config.defaultTimezone);
    if (chat) await recordInviteLeave(chat.id, message.left_chat_member);
    return;
  }

  if (chat) {
    if (await maybeHandleGroupCommandAlias(ctx, config, chat, message)) return;
    if (await handleAntiSpamMessage(ctx, chat, message, await getLocale(ctx))) return;
    if (await maybeHandleBannedWords(ctx, chat, message)) return;
    if (await maybeHandlePointExchangeKeyword(ctx, chat, message)) return;
    await maybeRewardSpeechPoints(ctx, config, chat, message);
    await maybeSendAutoReply(ctx, chat.id, message);
    await maybeAutoDelete(ctx, chat.id, message);
  }
}

async function maybeHandleGroupMembersMessage(ctx: Context, chat: PrismaChat, message: Message) {
  if (!ctx.chat || !isGroupLike(ctx.chat)) return;

  const settings = await getGroupMembersSettings(chat.id);
  if (ctx.from && !ctx.from.is_bot) {
    await maybeNotifyMemberProfileChange(ctx, chat, ctx.from, settings);
  }

  if (settings.unpinLinkedChannelMessages) {
    await maybeUnpinLinkedChannelMessage(ctx, message);
  }
}

async function handleNewChatMembers(ctx: Context, config: AppConfig, members: User[]) {
  if (!ctx.chat || !isGroupLike(ctx.chat)) return;

  const chat = await getActiveChatByTelegramId(ctx.chat.id);
  if (!chat) return;

  const joinVerify = await getJoinVerifySettings(chat.id);
  if (!joinVerify.enabled) {
    await handleNewMemberLimitNewChatMembers(ctx);
  }

  for (const member of members) {
    await upsertTelegramUser(member, config.defaultTimezone).catch(() => undefined);
    await recordStatsEvent(chat.id, ChatStatsEventType.JOIN, ctx.from, member, config.defaultTimezone);
    await recordInviteJoin(ctx, chat, member);

    const blocked = await handleBlocklistNewMember(ctx, chat, member);
    if (blocked) continue;

    if (joinVerify.enabled && !member.is_bot) {
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
    await applyBlocklistBotAdderPunishment(ctx, chat, member, settings);
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

  if (settings.blockBotPunishment !== "off" && request.from.is_bot) {
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

async function applyBlocklistBotAdderPunishment(
  ctx: Context,
  chat: PrismaChat,
  botUser: User,
  settings: BlocklistSettings
) {
  const actor = ctx.from;
  if (!actor || actor.id === botUser.id || actor.is_bot || settings.blockBotPunishment === "off") return;

  const telegramChatId = Number(chat.telegramChatId);
  if (settings.blockBotPunishment === "warn") {
    await ctx.api.sendMessage(
      telegramChatId,
      `${displayName(actor)} 添加了机器人 ${displayName(botUser)}，已警告。`,
      { parse_mode: "HTML" }
    ).catch(() => undefined);
    return;
  }

  if (settings.blockBotPunishment === "mute") {
    await muteUser(ctx, telegramChatId, actor.id, 60);
    return;
  }

  if (settings.blockBotPunishment === "kick") {
    await kickUser(ctx, telegramChatId, actor.id);
    return;
  }

  await banUser(ctx, telegramChatId, actor.id);
}

async function handleVerificationCallback(ctx: Context) {
  const parts = ctx.callbackQuery?.data?.split(":") ?? [];
  const chatId = Number(parts[1]);
  const userId = Number(parts[2]);
  const answer = parts[3];

  if (!ctx.from || ctx.from.id !== userId || !Number.isFinite(chatId) || !answer) {
    await ctx.answerCallbackQuery({ text: "This verification is not for you.", show_alert: true }).catch(() => undefined);
    return;
  }

  const key = verificationKey(chatId, userId);
  const pending = pendingVerifications.get(key);
  const stored = pending ? null : await getStoredJoinVerification(chatId, userId);
  if (!pending && !stored) {
    await ctx.answerCallbackQuery({ text: "Verification expired.", show_alert: true }).catch(() => undefined);
    return;
  }

  if (stored && stored.expiresAt.getTime() <= Date.now()) {
    await expireStoredJoinVerification(ctx.api, stored);
    await ctx.answerCallbackQuery({ text: "Verification expired.", show_alert: true }).catch(() => undefined);
    return;
  }

  const expectedAnswer = pending?.answer ?? stored?.answer ?? "button";
  if (expectedAnswer !== answer) {
    await ctx.answerCallbackQuery({ text: "验证答案不正确，请重试。", show_alert: true }).catch(() => undefined);
    return;
  }

  if (pending) clearTimeout(pending.timeout);
  pendingVerifications.delete(key);
  await deleteStoredJoinVerification(chatId, userId);
  await restoreVerifiedMember(ctx.api, chatId, userId);
  await ctx.api.deleteMessage(chatId, pending?.messageId ?? stored?.messageId ?? 0).catch(() => undefined);
  await ctx.answerCallbackQuery({ text: "验证通过" }).catch(() => undefined);
  await sendWelcomeAfterVerification(ctx, chatId, userId);
}

async function startJoinVerification(ctx: Context, chat: PrismaChat, member: User, settings: JoinVerifySettings) {
  const telegramChatId = Number(chat.telegramChatId);
  const challenge = createJoinVerificationChallenge(settings.mode);
  await ctx.api.restrictChatMember(telegramChatId, member.id, noChatPermissions()).catch(() => undefined);

  const sent = await ctx.api.sendMessage(
    telegramChatId,
    [
      `${displayName(member)}，请在 ${settings.durationMinutes} 分钟内完成进群验证。`,
      challenge.prompt
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: joinVerificationKeyboard(telegramChatId, member.id, challenge)
    }
  );

  const key = verificationKey(telegramChatId, member.id);
  const existing = pendingVerifications.get(key);
  if (existing) clearTimeout(existing.timeout);
  const expiresAt = new Date(Date.now() + settings.durationMinutes * 60 * 1000);

  let stored: StoredJoinVerification;
  try {
    stored = await upsertStoredJoinVerification(chat, telegramChatId, member.id, sent.message_id, settings, challenge, expiresAt);
  } catch (error) {
    console.error("Failed to store join verification", { chatId: chat.id, userId: member.id, error });
    await restoreVerifiedMember(ctx.api, telegramChatId, member.id);
    await ctx.api.deleteMessage(telegramChatId, sent.message_id).catch(() => undefined);
    return;
  }

  const timeout = setTimeout(() => {
    pendingVerifications.delete(key);
    void expireStoredJoinVerification(ctx.api, stored);
  }, Math.max(0, expiresAt.getTime() - Date.now()));

  pendingVerifications.set(key, {
    chatId: telegramChatId,
    userId: member.id,
    messageId: sent.message_id,
    timeout,
    answer: challenge.answer
  });
}

function joinVerificationKeyboard(chatId: number, userId: number, challenge: JoinVerificationChallenge) {
  const keyboard = new InlineKeyboard();
  challenge.choices.forEach((choice, index) => {
    keyboard.text(choice.label, `verify:${chatId}:${userId}:${choice.value}`);
    if ((index + 1) % 3 === 0 && index + 1 < challenge.choices.length) keyboard.row();
  });
  return keyboard;
}

async function recoverPendingJoinVerifications(api: TelegramApi) {
  try {
    const rows = await listStoredJoinVerifications();
    await Promise.all(rows.map(async (row) => {
      if (row.expiresAt.getTime() <= Date.now()) {
        await expireStoredJoinVerification(api, row);
        return;
      }
      trackStoredJoinVerification(api, row);
    }));
  } catch (error) {
    console.error("Failed to recover join verifications", error);
  }
}

function trackStoredJoinVerification(api: TelegramApi, row: StoredJoinVerification) {
  const telegramChatId = Number(row.telegramChatId);
  const telegramUserId = Number(row.telegramUserId);
  const key = verificationKey(telegramChatId, telegramUserId);
  const existing = pendingVerifications.get(key);
  if (existing) clearTimeout(existing.timeout);

  const timeout = setTimeout(() => {
    pendingVerifications.delete(key);
    void expireStoredJoinVerification(api, row);
  }, Math.max(0, row.expiresAt.getTime() - Date.now()));

  pendingVerifications.set(key, {
    chatId: telegramChatId,
    userId: telegramUserId,
    messageId: row.messageId,
    timeout,
    answer: row.answer
  });
}

async function upsertStoredJoinVerification(
  chat: PrismaChat,
  telegramChatId: number,
  telegramUserId: number,
  messageId: number,
  settings: JoinVerifySettings,
  challenge: JoinVerificationChallenge,
  expiresAt: Date
) {
  const id = joinVerificationRecordId(chat.id, telegramUserId);
  const rows = await prisma.$queryRaw<StoredJoinVerification[]>`
    INSERT INTO "join_verifications" (
      "id",
      "chat_id",
      "telegram_chat_id",
      "telegram_user_id",
      "message_id",
      "mode",
      "answer",
      "punishment",
      "expires_at",
      "updated_at"
    )
    VALUES (
      ${id},
      ${chat.id},
      ${BigInt(telegramChatId)},
      ${BigInt(telegramUserId)},
      ${messageId},
      ${settings.mode},
      ${challenge.answer},
      ${settings.punishment},
      ${expiresAt},
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("chat_id", "telegram_user_id") DO UPDATE SET
      "telegram_chat_id" = EXCLUDED."telegram_chat_id",
      "message_id" = EXCLUDED."message_id",
      "mode" = EXCLUDED."mode",
      "answer" = EXCLUDED."answer",
      "punishment" = EXCLUDED."punishment",
      "expires_at" = EXCLUDED."expires_at",
      "updated_at" = CURRENT_TIMESTAMP
    RETURNING
      "id",
      "chat_id" AS "chatId",
      "telegram_chat_id" AS "telegramChatId",
      "telegram_user_id" AS "telegramUserId",
      "message_id" AS "messageId",
      "mode",
      "answer",
      "punishment",
      "expires_at" AS "expiresAt"
  `;
  const row = normalizeStoredJoinVerification(rows[0]);
  if (!row) throw new Error("Stored join verification was not returned");
  return row;
}

async function listStoredJoinVerifications() {
  const rows = await prisma.$queryRaw<StoredJoinVerification[]>`
    SELECT
      "id",
      "chat_id" AS "chatId",
      "telegram_chat_id" AS "telegramChatId",
      "telegram_user_id" AS "telegramUserId",
      "message_id" AS "messageId",
      "mode",
      "answer",
      "punishment",
      "expires_at" AS "expiresAt"
    FROM "join_verifications"
  `;
  return rows.map(normalizeStoredJoinVerification).filter((row): row is StoredJoinVerification => Boolean(row));
}

async function getStoredJoinVerification(telegramChatId: number, telegramUserId: number) {
  const rows = await prisma.$queryRaw<StoredJoinVerification[]>`
    SELECT
      "id",
      "chat_id" AS "chatId",
      "telegram_chat_id" AS "telegramChatId",
      "telegram_user_id" AS "telegramUserId",
      "message_id" AS "messageId",
      "mode",
      "answer",
      "punishment",
      "expires_at" AS "expiresAt"
    FROM "join_verifications"
    WHERE "telegram_chat_id" = ${BigInt(telegramChatId)}
      AND "telegram_user_id" = ${BigInt(telegramUserId)}
    LIMIT 1
  `;
  return normalizeStoredJoinVerification(rows[0]);
}

async function deleteStoredJoinVerification(telegramChatId: number, telegramUserId: number) {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    DELETE FROM "join_verifications"
    WHERE "telegram_chat_id" = ${BigInt(telegramChatId)}
      AND "telegram_user_id" = ${BigInt(telegramUserId)}
    RETURNING "id"
  `;
  return rows.length > 0;
}

async function deleteStoredJoinVerificationById(id: string) {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    DELETE FROM "join_verifications"
    WHERE "id" = ${id}
    RETURNING "id"
  `;
  return rows.length > 0;
}

function normalizeStoredJoinVerification(row: StoredJoinVerification | undefined) {
  if (!row || !isJoinVerifyPunishment(row.punishment)) return null;
  return row;
}

async function expireStoredJoinVerification(api: TelegramApi, row: StoredJoinVerification) {
  const deleted = await deleteStoredJoinVerificationById(row.id).catch((error) => {
    console.error("Failed to delete expired join verification", { id: row.id, error });
    return false;
  });
  if (!deleted) return;

  const telegramChatId = Number(row.telegramChatId);
  const telegramUserId = Number(row.telegramUserId);
  const key = verificationKey(telegramChatId, telegramUserId);
  const pending = pendingVerifications.get(key);
  if (pending) clearTimeout(pending.timeout);
  pendingVerifications.delete(key);
  await punishUnverifiedMember(api, telegramChatId, telegramUserId, row.punishment);
  await api.deleteMessage(telegramChatId, row.messageId).catch(() => undefined);
}

async function sendWelcomeAfterVerification(ctx: Context, telegramChatId: number, telegramUserId: number) {
  const chat = await getActiveChatByTelegramId(telegramChatId);
  if (!chat) return;
  const welcome = await getWelcomeSettings(chat.id);
  if (!welcome.enabled) return;

  const member = await ctx.api.getChatMember(telegramChatId, telegramUserId).catch(() => null);
  const user = member?.user;
  if (!user) return;
  await sendWelcome(ctx, chat, user, welcome);
}

async function restoreVerifiedMember(api: TelegramApi, chatId: number, userId: number) {
  const permissions = await resolveDefaultMemberPermissions(api, chatId);
  await api.restrictChatMember(chatId, userId, permissions, { until_date: 0 }).catch((error) => {
    console.error("Failed to restore verified member permissions", { chatId, userId, error });
  });
}

async function resolveDefaultMemberPermissions(api: TelegramApi, chatId: number) {
  const chat = await api.getChat(chatId).catch(() => null);
  const permissions = chat && "permissions" in chat ? chat.permissions : undefined;
  return defaultMemberPermissions(permissions);
}

function defaultMemberPermissions(permissions: ChatPermissions | undefined): ChatPermissions {
  return {
    can_send_messages: permissions?.can_send_messages ?? true,
    can_send_audios: permissions?.can_send_audios ?? true,
    can_send_documents: permissions?.can_send_documents ?? true,
    can_send_photos: permissions?.can_send_photos ?? true,
    can_send_videos: permissions?.can_send_videos ?? true,
    can_send_video_notes: permissions?.can_send_video_notes ?? true,
    can_send_voice_notes: permissions?.can_send_voice_notes ?? true,
    can_send_polls: permissions?.can_send_polls ?? true,
    can_send_other_messages: permissions?.can_send_other_messages ?? true,
    can_add_web_page_previews: permissions?.can_add_web_page_previews ?? true,
    can_change_info: permissions?.can_change_info ?? false,
    can_invite_users: permissions?.can_invite_users ?? true,
    can_pin_messages: permissions?.can_pin_messages ?? false,
    can_manage_topics: permissions?.can_manage_topics ?? true
  };
}

async function punishUnverifiedMember(api: TelegramApi, chatId: number, userId: number, punishment: JoinVerifySettings["punishment"]) {
  if (punishment === "mute") {
    const untilDate = Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000);
    await api.restrictChatMember(chatId, userId, noChatPermissions(), { until_date: untilDate }).catch(() => undefined);
    return;
  }
  if (punishment === "ban") {
    await api.banChatMember(chatId, userId).catch((error) => {
      console.error("Failed to ban member", { chatId, userId, error });
    });
    return;
  }
  await api.banChatMember(chatId, userId).catch(() => undefined);
  await api.unbanChatMember(chatId, userId, { only_if_banned: true }).catch(() => undefined);
}

async function sendWelcome(ctx: Context, chat: PrismaChat, member: User, settings: WelcomeSettings) {
  const telegramChatId = Number(chat.telegramChatId);
  const sentMessages = await sendWelcomeMessages(ctx, telegramChatId, chat, member, settings).catch(() => []);
  if (!sentMessages.length) return;

  settings.lastMessageIds = sentMessages.map((message) => message.message_id);
  await saveWelcomeSettings(chat.id, settings).catch((error) => {
    console.error("Failed to store welcome message IDs", error);
  });
  scheduleWelcomeMessageDeletion(ctx, telegramChatId, settings, settings.lastMessageIds);
}

async function sendWelcomePreview(ctx: Context, chat: PrismaChat, member: User, settings: WelcomeSettings, locale: Locale) {
  if (!ctx.chat) return;
  if (!settings.text.trim() && !settings.mediaFileId) {
    await ctx.reply(
      locale === "zh-CN" ? "请先设置文本内容或媒体后再预览。" : "Set text content or media before previewing."
    );
    return;
  }

  const sentMessages = await sendWelcomeMessages(ctx, ctx.chat.id, chat, member, settings).catch(() => []);
  if (!sentMessages.length) {
    await ctx.reply(locale === "zh-CN" ? "预览发送失败，请检查媒体或 Bot 权限。" : "Preview failed. Check the media or bot permissions.");
    return;
  }
  scheduleWelcomeMessageDeletion(ctx, ctx.chat.id, settings, sentMessages.map((message) => message.message_id));
}

async function sendWelcomeMessages(
  ctx: Context,
  telegramChatId: number,
  chat: PrismaChat,
  member: User,
  settings: WelcomeSettings
): Promise<Message[]> {
  const text = renderWelcomeMessageText(chat, member, settings.text);
  const replyMarkup = welcomeReplyMarkup(settings);
  const sentMessages: Message[] = [];

  if (settings.mediaKind === "photo" && settings.mediaFileId) {
    sentMessages.push(await ctx.api.sendPhoto(telegramChatId, settings.mediaFileId, {
      ...(text ? { caption: text, parse_mode: "HTML" } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    }));
    return sentMessages;
  }

  if (settings.mediaKind === "video" && settings.mediaFileId) {
    sentMessages.push(await ctx.api.sendVideo(telegramChatId, settings.mediaFileId, {
      ...(text ? { caption: text, parse_mode: "HTML" } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    }));
    return sentMessages;
  }

  if (settings.mediaKind === "animation" && settings.mediaFileId) {
    sentMessages.push(await ctx.api.sendAnimation(telegramChatId, settings.mediaFileId, {
      ...(text ? { caption: text, parse_mode: "HTML" } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    }));
    return sentMessages;
  }

  if (settings.mediaKind === "sticker" && settings.mediaFileId) {
    sentMessages.push(await ctx.api.sendSticker(telegramChatId, settings.mediaFileId, {
      ...(!text && replyMarkup ? { reply_markup: replyMarkup } : {})
    }));
    if (text) {
      sentMessages.push(await ctx.api.sendMessage(telegramChatId, text, {
        parse_mode: "HTML",
        ...(replyMarkup ? { reply_markup: replyMarkup } : {})
      }));
    }
    return sentMessages;
  }

  if (!text) return sentMessages;
  sentMessages.push(await ctx.api.sendMessage(telegramChatId, text, {
    parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  }));
  return sentMessages;
}

function renderWelcomeMessageText(chat: PrismaChat, member: User, template: string) {
  const name = displayName(member);
  const username = member.username ? `@${escapeHtml(member.username)}` : name;
  const mention = `<a href="tg://user?id=${member.id}">${name}</a>`;
  const groupName = escapeHtml(chat.title ?? "this group");
  return template
    .replaceAll("{NAME}", name)
    .replaceAll("{MENTION}", mention)
    .replaceAll("{GROUPNAME}", groupName)
    .replaceAll("{name}", name)
    .replaceAll("{username}", username)
    .replaceAll("{chat}", groupName);
}

function welcomeReplyMarkup(settings: WelcomeSettings) {
  const buttonsKeyboard = autoReplyInlineKeyboard(settings.buttons);
  if (buttonsKeyboard) return buttonsKeyboard;
  if (settings.buttonText && settings.buttonUrl) return new InlineKeyboard().url(settings.buttonText, settings.buttonUrl);
  if (settings.replyKeyboard?.length) {
    return {
      keyboard: settings.replyKeyboard,
      resize_keyboard: true
    };
  }
  return undefined;
}

function scheduleWelcomeMessageDeletion(ctx: Context, telegramChatId: number, settings: WelcomeSettings, messageIds: number[]) {
  if (settings.deleteAfterMinutes <= 0) return;
  setTimeout(() => {
    for (const messageId of messageIds) {
      void ctx.api.deleteMessage(telegramChatId, messageId).catch(() => undefined);
    }
  }, settings.deleteAfterMinutes * 60 * 1000);
}

async function deleteStoredWelcomeMessages(ctx: Context, chat: PrismaChat, settings: WelcomeSettings) {
  if (!settings.lastMessageIds.length) return;
  await Promise.all(
    settings.lastMessageIds.map((messageId) =>
      ctx.api.deleteMessage(Number(chat.telegramChatId), messageId).catch(() => undefined)
    )
  );
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

async function handleCancelCommand(ctx: Context, config: AppConfig) {
  const locale = await getLocale(ctx);
  if (ctx.from) clearUserInputState(ctx.from.id);
  await ctx.reply(mainMenuText(locale, ctx.from?.first_name, config.botUsername), {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboard(locale)
  });
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

async function maybeHandleGroupCommandAlias(ctx: Context, config: AppConfig, chat: PrismaChat, message: Message) {
  if (!ctx.chat || !isGroupLike(ctx.chat) || !ctx.from) return false;
  const alias = extractGroupCommandAlias(message);
  if (!alias) return false;

  const settings = await getGroupCommandSettings(chat.id);
  const matched = groupCommandDefinitions.find((item) =>
    settings.aliases[item.key].some((itemAlias) => normalizeGroupCommandAlias(itemAlias) === alias)
  );
  if (!matched) return false;

  if (matched.key === "link") await handleInviteLinkCommand(ctx, config);
  if (matched.key === "sign_in") await handleSignInCommand(ctx, config);
  if (matched.key === "points_rank") await handlePointsRankCommand(ctx);
  if (matched.key === "points") await handlePointsCommand(ctx, config);
  if (matched.key === "stat") await handleStatsCommand(ctx, config, 1);
  if (matched.key === "stat_week") await handleStatsCommand(ctx, config, 7);
  if (matched.key === "stats") await handleStatsCommand(ctx, config, 30);
  if (matched.key === "lottery") await handleLotteryCommand(ctx);
  return true;
}

async function ensureGroupCommandEnabled(ctx: Context, chat: PrismaChat, key: GroupCommandKey, locale: Locale) {
  const settings = await getGroupCommandSettings(chat.id);
  if (settings.commands[key]) return true;

  const definition = groupCommandDefinitions.find((item) => item.key === key);
  await ctx.reply(
    locale === "zh-CN"
      ? `该群组已关闭 ${definition?.command ?? `/${key}`} 命令。`
      : `${definition?.command ?? `/${key}`} is disabled in this group.`
  ).catch(() => undefined);
  return false;
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

  if (!(await ensureGroupCommandEnabled(ctx, chat, "link", locale))) return;

  const settings = await getInviteLinkSettings(chat.id);
  if (!settings.enabled) {
    await ctx.reply(locale === "zh-CN" ? "邀请链接生成功能未开启。" : "Invite link generation is disabled.");
    return;
  }

  const user = await upsertTelegramUser(ctx.from, config.defaultTimezone);
  const link = await getOrCreateInviteLink(ctx, chat, user.id, settings);
  if (!link) {
    await ctx.reply(locale === "zh-CN" ? "无法创建邀请链接，请确认 Bot 拥有邀请用户权限。" : "Could not create an invite link. Check bot permissions.");
    return;
  }

  const inviteCount = await prisma.inviteJoin.count({
    where: {
      chatId: chat.id,
      inviteLink: { is: { creatorUserId: user.id } }
    }
  });

  await ctx.reply(
    [
      locale === "zh-CN" ? "🔗 <b>你的邀请链接</b>" : "🔗 <b>Your invite link</b>",
      link.inviteLink,
      "",
      `${locale === "zh-CN" ? "有效邀请人数" : "Valid invites"}: ${inviteCount}`
    ].join("\n"),
    { parse_mode: "HTML" }
  );
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

  if (!(await ensureGroupCommandEnabled(ctx, chat, "sign_in", locale))) return;

  const settings = await getPointsSettings(chat.id);
  if (!settings.enabled || settings.signInPoints <= 0) {
    await ctx.reply(locale === "zh-CN" ? "本群积分功能未开启。" : "Points are disabled in this group.");
    return;
  }

  const user = await upsertTelegramUser(ctx.from, config.defaultTimezone);
  const statDate = formatDate(new Date());
  const referenceKey = `sign_in:${chat.id}:${user.id}:${statDate}`;
  const balance = await addPoints(chat.id, user.id, settings.signInPoints, PointTransactionType.SIGN_IN, referenceKey, null, statDate);
  const sent = await ctx.reply(locale === "zh-CN" ? `签到成功，当前积分：${balance}` : `Signed in. Current points: ${balance}`);
  if (settings.deleteSignInMessage) {
    scheduleTelegramMessageDelete(ctx, ctx.chat.id, sent.message_id, settings.deleteSignInSeconds);
    if (ctx.message?.message_id) scheduleTelegramMessageDelete(ctx, ctx.chat.id, ctx.message.message_id, settings.deleteSignInSeconds);
  }
}

async function handlePointsRankCommand(ctx: Context) {
  const locale = await getLocale(ctx);
  if (!ctx.chat || !isGroupLike(ctx.chat)) return;
  const chat = await getActiveChatByTelegramId(ctx.chat.id);
  if (!chat) {
    await ctx.reply(locale === "zh-CN" ? "请先绑定该群组。" : "Bind this group first.");
    return;
  }

  if (!(await ensureGroupCommandEnabled(ctx, chat, "points_rank", locale))) return;

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

  if (!(await ensureGroupCommandEnabled(ctx, chat, "points", locale))) return;

  const replyUser = "reply_to_message" in ctx.message! ? ctx.message!.reply_to_message?.from : undefined;
  const text = "text" in ctx.message! ? ctx.message!.text ?? "" : "";
  const parts = text.split(/\s+/).filter(Boolean);
  const targetInput = !replyUser && parts.length >= 3 ? parts[1] : undefined;
  const rawDelta = targetInput ? parts[2] : parts[1];

  if (!replyUser && !targetInput && !rawDelta) {
    const user = await upsertTelegramUser(ctx.from, config.defaultTimezone);
    const current = await prisma.chatPointBalance.findUnique({ where: { chatId_userId: { chatId: chat.id, userId: user.id } } });
    await ctx.reply(locale === "zh-CN" ? `当前积分：${current?.balance ?? 0}` : `Current points: ${current?.balance ?? 0}`);
    return;
  }

  const isAdmin = await isUserChatAdmin(ctx, ctx.chat.id, ctx.from.id).catch(() => false);
  if (!isAdmin) {
    await ctx.reply(locale === "zh-CN" ? "只有管理员可以增减积分。" : "Only admins can adjust points.");
    return;
  }

  const delta = Number(rawDelta);
  if (!Number.isInteger(delta)) {
    await ctx.reply(locale === "zh-CN" ? "请回复用户消息并发送 /points 数字，或发送 /points @用户名 数字。" : "Reply to a user and send /points number, or send /points @username number.");
    return;
  }

  const user = replyUser
    ? await upsertTelegramUser(replyUser, config.defaultTimezone)
    : targetInput ? await findPointTargetUser(chat.id, targetInput) : null;
  if (!user) {
    await ctx.reply(locale === "zh-CN" ? "找不到该用户。" : "User not found.");
    return;
  }
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

  const commandKey: GroupCommandKey = days === 1 ? "stat" : days === 7 ? "stat_week" : "stats";
  if (!(await ensureGroupCommandEnabled(ctx, chat, commandKey, locale))) return;

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

  if (!(await ensureGroupCommandEnabled(ctx, chat, "lottery", locale))) return;

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

async function handleGiveawayCallback(ctx: Context, config: AppConfig) {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const parts = ctx.callbackQuery?.data?.split(":") ?? [];
  const action = parts[1];
  const chatId = action === "type" || action === "draw" ? parts[3] : parts[2];
  if (!action || !chatId || action === "join") return;

  const locale = await getLocale(ctx);
  const chat = await ensureControlPermissionForChatId(ctx, chatId, locale);
  if (!chat) return;

  if (action === "create") {
    if (!ctx.from) return;
    clearUserInputState(ctx.from.id);
    await editOrReply(ctx, giveawayTypeSelectText(chat, locale), giveawayTypeSelectKeyboard(chatId, locale));
    return;
  }

  if (action === "types") {
    if (ctx.from) giveawayInputDrafts.delete(ctx.from.id);
    await editOrReply(ctx, giveawayTypeSelectText(chat, locale), giveawayTypeSelectKeyboard(chatId, locale));
    return;
  }

  if (action === "type" && isGiveawayCreateType(parts[2])) {
    if (parts[2] !== "common") {
      await editOrReply(ctx, giveawayTypeUnavailableText(parts[2], locale), giveawayTypeSelectKeyboard(chatId, locale));
      return;
    }
    if (ctx.from) giveawayInputDrafts.delete(ctx.from.id);
    await editOrReply(ctx, commonGiveawayDrawModeText(locale), commonGiveawayDrawModeKeyboard(chatId, locale));
    return;
  }

  if (action === "draw" && isGiveawayDrawMode(parts[2])) {
    if (!ctx.from) return;
    clearUserInputState(ctx.from.id);
    if (parts[2] === "full") {
      giveawayInputDrafts.set(ctx.from.id, { chatId, type: "common", drawMode: "full", stage: "target_count" });
      await editOrReply(ctx, commonGiveawayTargetCountPromptText(locale), giveawayCreateCancelKeyboard(chatId, locale));
      return;
    }
    giveawayInputDrafts.set(ctx.from.id, { chatId, type: "common", drawMode: "timed", stage: "draw_at" });
    await editOrReply(ctx, commonGiveawayDrawAtPromptText(locale), giveawayCreateCancelKeyboard(chatId, locale));
    return;
  }

  if (action === "cancel") {
    if (ctx.from) giveawayInputDrafts.delete(ctx.from.id);
    await openGiveawayPanel(ctx, locale, chat);
    return;
  }

  if (action === "records") {
    await openGiveawayRecordsPanel(ctx, locale, chat);
    return;
  }

  if (action === "settings") {
    await openGiveawaySettingsPanel(ctx, locale, chat);
    return;
  }

  await openGiveawayPanel(ctx, locale, chat);
}

async function handleGiveawayInputMessage(ctx: Context, config: AppConfig, locale: Locale) {
  if (!ctx.from) return false;
  const draft = giveawayInputDrafts.get(ctx.from.id);
  if (!draft) return false;

  const chat = await ensureControlPermissionForChatId(ctx, draft.chatId, locale);
  if (!chat) {
    giveawayInputDrafts.delete(ctx.from.id);
    return true;
  }

  const text = ctx.message && "text" in ctx.message ? ctx.message.text ?? "" : "";

  if (draft.stage === "target_count") {
    const targetCount = Number(text.trim());
    if (!Number.isSafeInteger(targetCount) || targetCount < 1 || targetCount > 100000) {
      await ctx.reply(locale === "zh-CN" ? "参与人数必须是 1 到 100000 的整数。" : "Participant count must be an integer from 1 to 100000.", {
        parse_mode: "HTML",
        reply_markup: giveawayCreateCancelKeyboard(draft.chatId, locale)
      });
      return true;
    }
    draft.targetCount = targetCount;
    draft.stage = "details";
    await ctx.reply(commonGiveawayDetailsPromptText(draft, locale), {
      parse_mode: "HTML",
      reply_markup: giveawayCreateCancelKeyboard(draft.chatId, locale)
    });
    return true;
  }

  if (draft.stage === "draw_at") {
    const drawAt = parseGiveawayDrawAt(text);
    if (!drawAt || drawAt.getTime() <= Date.now()) {
      await ctx.reply(
        locale === "zh-CN"
          ? "开奖时间必须是未来时间，格式：<code>2026-08-03 17:45:24</code>，也支持 <code>30分钟</code>、<code>2小时</code>。"
          : "Draw time must be in the future, for example <code>2026-08-03 17:45:24</code>, <code>30 minutes</code>, or <code>2 hours</code>.",
        {
          parse_mode: "HTML",
          reply_markup: giveawayCreateCancelKeyboard(draft.chatId, locale)
        }
      );
      return true;
    }
    draft.drawAt = drawAt;
    draft.stage = "details";
    await ctx.reply(commonGiveawayDetailsPromptText(draft, locale), {
      parse_mode: "HTML",
      reply_markup: giveawayCreateCancelKeyboard(draft.chatId, locale)
    });
    return true;
  }

  const parsed = parseCommonGiveawayDetailsInput(text, locale);
  if (!parsed.value) {
    await ctx.reply(parsed.error, {
      parse_mode: "HTML",
      reply_markup: giveawayCreateCancelKeyboard(draft.chatId, locale)
    });
    return true;
  }

  const drawAt = draft.drawMode === "timed" && draft.drawAt ? draft.drawAt : fallbackFullGiveawayDrawAt();
  const joinRequirements: Prisma.InputJsonObject = {
    type: draft.type,
    entry: "keyword",
    keyword: parsed.value.keyword,
    drawMode: draft.drawMode ?? "timed",
    ...(draft.targetCount ? { targetCount: draft.targetCount } : {})
  };
  const creator = await upsertTelegramUser(ctx.from, config.defaultTimezone);
  const giveaway = await prisma.giveaway.create({
    data: {
      chatId: chat.id,
      title: parsed.value.title,
      prize: parsed.value.prize,
      winnersCount: parsed.value.winnersCount,
      joinRequirements,
      drawAt,
      status: GiveawayStatus.ACTIVE,
      createdBy: creator.id
    }
  });

  if (draft.drawMode === "timed") {
    await enqueueGiveawayDraw(giveaway.id, giveaway.drawAt);
  }
  await prisma.auditLog.create({
    data: {
      chatId: chat.id,
      actorUserId: creator.id,
      action: "giveaway.created",
      targetType: "giveaway",
      targetId: giveaway.id,
      metadata: {
        title: giveaway.title,
        prize: giveaway.prize,
        winnersCount: giveaway.winnersCount,
        keyword: parsed.value.keyword,
        drawMode: draft.drawMode,
        targetCount: draft.targetCount,
        drawAt: giveaway.drawAt.toISOString()
      }
    }
  });

  const announced = await sendGiveawayAnnouncement(ctx, chat, giveaway, locale).then(() => true).catch(() => false);
  giveawayInputDrafts.delete(ctx.from.id);

  await ctx.reply(
    [
      locale === "zh-CN" ? "抽奖活动已创建。" : "Giveaway created.",
      announced
        ? (locale === "zh-CN" ? "已发送参与按钮到目标群/频道。" : "The join button has been posted to the target chat.")
        : (locale === "zh-CN" ? "未能发送到目标群/频道，请检查 Bot 发送消息权限；用户仍可通过 /lottery 参与。" : "Could not post to the target chat. Check bot send-message permission; users can still join with /lottery.")
    ].join("\n"),
    { reply_markup: giveawayBackKeyboard(chat.id, locale) }
  );
  return true;
}

function giveawayTypeSelectText(chat: PrismaChat, locale: Locale) {
  const title = escapeHtml(chat.title ?? chat.username ?? String(chat.telegramChatId));
  return locale === "zh-CN"
    ? [
        `🎁 <b>${title} 发起抽奖</b>`,
        "",
        "🔥 <b>通用抽奖:</b>群员在群内回复指定关键词参与抽奖",
        "",
        "Ⓜ️ <b>积分抽奖:</b>群员在群内点击按钮，消耗积分抽奖",
        "",
        "🥰 <b>群活跃抽奖:</b>根据活跃排名抽奖，或达到活跃度参与随机抽奖",
        "",
        "🪁 <b>邀请人数抽奖:</b>群成员用专属链接拉人进群，到指定人数后参与抽奖",
        "",
        "🙋‍♂️ <b>指定群报道抽奖:</b>A群成员进入B群回复指定关键词参与抽奖",
        "",
        "🎰 <b>娱乐抽奖:</b>水果机、摇骰子、飞镖、保龄球...",
        "",
        "<b>选择抽奖类型:</b>"
      ].join("\n")
    : [
        `🎁 <b>${title} Create Giveaway</b>`,
        "",
        "🔥 <b>General:</b> members reply with a keyword in the group to join.",
        "",
        "Ⓜ️ <b>Points:</b> members spend points to join by button.",
        "",
        "🥰 <b>Activity:</b> draw from activity ranking or activity-qualified members.",
        "",
        "🪁 <b>Invites:</b> members join after inviting enough users with their own links.",
        "",
        "🙋‍♂️ <b>Report-in:</b> members from group A reply with a keyword in group B.",
        "",
        "🎰 <b>Fun:</b> slots, dice, darts, bowling...",
        "",
        "<b>Choose giveaway type:</b>"
      ].join("\n");
}

function giveawayTypeSelectKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "🔥通用抽奖" : "🔥 General", `giveaway:type:common:${chatId}`)
    .text(locale === "zh-CN" ? "Ⓜ️积分抽奖" : "Ⓜ️ Points", `giveaway:type:points:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "🥰群活跃抽奖" : "🥰 Activity", `giveaway:type:active:${chatId}`)
    .text(locale === "zh-CN" ? "🪁邀请人数抽奖" : "🪁 Invites", `giveaway:type:invite:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "🙋‍♂️指定群报道抽奖" : "🙋‍♂️ Report-in", `giveaway:type:report:${chatId}`)
    .text(locale === "zh-CN" ? "🎰娱乐抽奖" : "🎰 Fun", `giveaway:type:fun:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `chat_feature:giveaway:${chatId}`);
}

function commonGiveawayDrawModeText(locale: Locale) {
  return locale === "zh-CN"
    ? [
        "🎁创建<b>通用抽奖</b>",
        "",
        "抽奖:群员在群内回复指定关键词参与抽奖",
        "",
        "选择开奖方式:"
      ].join("\n")
    : [
        "🎁 Create <b>General Giveaway</b>",
        "",
        "Members reply with a keyword in the group to join.",
        "",
        "Choose draw mode:"
      ].join("\n");
}

function commonGiveawayDrawModeKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "满人开奖" : "Draw when full", `giveaway:draw:full:${chatId}`)
    .text(locale === "zh-CN" ? "定时开奖" : "Scheduled draw", `giveaway:draw:timed:${chatId}`)
    .row()
    .text(locale === "zh-CN" ? "🔙返回选择抽奖类型" : "🔙 Back to types", `giveaway:types:${chatId}`);
}

function giveawayTypeUnavailableText(type: GiveawayCreateType, locale: Locale) {
  const label = giveawayCreateTypeLabel(type, locale);
  return locale === "zh-CN"
    ? [
        `<b>${label}</b>`,
        "",
        "该抽奖类型的配置流程暂未接入。当前已接入可用闭环：通用抽奖。"
      ].join("\n")
    : [
        `<b>${label}</b>`,
        "",
        "This giveaway type is not wired yet. General giveaways are available now."
      ].join("\n");
}

function giveawayCreateTypeLabel(type: GiveawayCreateType, locale: Locale) {
  const labels: Record<GiveawayCreateType, { zh: string; en: string }> = {
    common: { zh: "🔥通用抽奖", en: "🔥 General giveaway" },
    points: { zh: "Ⓜ️积分抽奖", en: "Ⓜ️ Points giveaway" },
    active: { zh: "🥰群活跃抽奖", en: "🥰 Activity giveaway" },
    invite: { zh: "🪁邀请人数抽奖", en: "🪁 Invite giveaway" },
    report: { zh: "🙋‍♂️指定群报道抽奖", en: "🙋‍♂️ Report-in giveaway" },
    fun: { zh: "🎰娱乐抽奖", en: "🎰 Fun giveaway" }
  };
  return locale === "zh-CN" ? labels[type].zh : labels[type].en;
}

function commonGiveawayTargetCountPromptText(locale: Locale) {
  return locale === "zh-CN"
    ? [
        "🎁创建<b>通用抽奖</b>  ( <code>/cancel</code> 命令返回首页)",
        "",
        "👉 请回复参与多少人后开奖:"
      ].join("\n")
    : [
        "🎁 Create <b>General Giveaway</b>  (send <code>/cancel</code> to return home)",
        "",
        "👉 Send how many participants are needed before drawing:"
      ].join("\n");
}

function commonGiveawayDrawAtPromptText(locale: Locale) {
  return locale === "zh-CN"
    ? [
        "请回复<strong>开奖时间:</strong>",
        "格式:年-月-日 时:分",
        "例如:<code>2026-08-03 17:45:24</code>"
      ].join("\n")
    : [
        "Send the <strong>draw time:</strong>",
        "Format: year-month-day hour:minute",
        "Example:<code>2026-08-03 17:45:24</code>"
      ].join("\n");
}

function commonGiveawayDetailsPromptText(draft: GiveawayInputDraft, locale: Locale) {
  const modeLine = draft.drawMode === "full"
    ? (locale === "zh-CN" ? `满 <b>${draft.targetCount}</b> 人开奖` : `Draw when <b>${draft.targetCount}</b> members join`)
    : `${locale === "zh-CN" ? "开奖时间" : "Draw at"}: <b>${formatDateTimeForDisplay(draft.drawAt ?? new Date())}</b>`;
  return locale === "zh-CN"
    ? [
        "🎁创建<b>通用抽奖</b>",
        "",
        modeLine,
        "",
        "请按以下格式发送：",
        "<code>标题 | 奖品 | 中奖人数 | 参与关键词</code>",
        "",
        "示例：",
        "<code>测试抽奖 | 100U | 1 | 抽奖</code>"
      ].join("\n")
    : [
        "🎁 Create <b>General Giveaway</b>",
        "",
        modeLine,
        "",
        "Send in this format:",
        "<code>Title | Prize | Winners | Join keyword</code>",
        "",
        "Example:",
        "<code>Test giveaway | 100U | 1 | lucky</code>"
      ].join("\n");
}

function giveawayCreateCancelKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "🔙 返回" : "🔙 Back", `giveaway:cancel:${chatId}`);
}

function parseCommonGiveawayDetailsInput(input: string, locale: Locale): {
  value?: { title: string; prize: string; winnersCount: number; keyword: string };
  error: string;
} {
  const error = locale === "zh-CN"
    ? [
        "格式不正确，请按以下格式发送：",
        "<code>标题 | 奖品 | 中奖人数 | 参与关键词</code>"
      ].join("\n")
    : [
        "Invalid format. Send in this format:",
        "<code>Title | Prize | Winners | Join keyword</code>"
      ].join("\n");
  const parts = input.split("|").map((item) => item.trim());
  if (parts.length !== 4) return { error };

  const [title = "", prize = "", winnersRaw = "", keyword = ""] = parts;
  if (!title || title.length > 255) {
    return { error: locale === "zh-CN" ? "标题不能为空，且不能超过 255 个字符。" : "Title is required and must be 255 characters or fewer." };
  }
  if (!prize || prize.length > 255) {
    return { error: locale === "zh-CN" ? "奖品不能为空，且不能超过 255 个字符。" : "Prize is required and must be 255 characters or fewer." };
  }

  const winnersCount = Number(winnersRaw);
  if (!Number.isSafeInteger(winnersCount) || winnersCount < 1 || winnersCount > 100) {
    return { error: locale === "zh-CN" ? "中奖人数必须是 1 到 100 的整数。" : "Winners must be an integer from 1 to 100." };
  }
  if (!keyword || keyword.length > 64 || keyword.includes("|")) {
    return { error: locale === "zh-CN" ? "参与关键词不能为空，且不能超过 64 个字符。" : "Join keyword is required and must be 64 characters or fewer." };
  }

  return { value: { title, prize, winnersCount, keyword }, error: "" };
}

function parseGiveawayDrawAt(input: string) {
  const durationMinutes = parseScheduleDurationMinutes(input);
  if (durationMinutes) return new Date(Date.now() + durationMinutes * 60_000);
  return parseScheduleDateTime(input);
}

function fallbackFullGiveawayDrawAt() {
  const date = new Date();
  date.setFullYear(date.getFullYear() + 10);
  return date;
}

function isGiveawayCreateType(value: string | undefined): value is GiveawayCreateType {
  return value === "common"
    || value === "points"
    || value === "active"
    || value === "invite"
    || value === "report"
    || value === "fun";
}

function isGiveawayDrawMode(value: string | undefined): value is GiveawayDrawMode {
  return value === "full" || value === "timed";
}

async function sendGiveawayAnnouncement(
  ctx: Context,
  chat: PrismaChat,
  giveaway: { id: string; title: string; prize: string; winnersCount: number; drawAt: Date; joinRequirements?: Prisma.JsonValue | null },
  locale: Locale
) {
  const requirements = getCommonGiveawayRequirements(giveaway.joinRequirements);
  const options = requirements
    ? { parse_mode: "HTML" as const }
    : {
        parse_mode: "HTML" as const,
        reply_markup: new InlineKeyboard().text(locale === "zh-CN" ? "🎁 参与抽奖" : "🎁 Join giveaway", `giveaway:join:${giveaway.id}`)
      };
  await ctx.api.sendMessage(
    Number(chat.telegramChatId),
    giveawayAnnouncementText(giveaway, requirements, locale),
    options
  );
}

function giveawayAnnouncementText(
  giveaway: { title: string; prize: string; winnersCount: number; drawAt: Date },
  requirements: CommonGiveawayRequirements | null,
  locale: Locale
) {
  const drawLine = requirements?.drawMode === "full" && requirements.targetCount
    ? (locale === "zh-CN" ? `满 <b>${requirements.targetCount}</b> 人自动开奖` : `Draws when <b>${requirements.targetCount}</b> members join`)
    : `${locale === "zh-CN" ? "开奖时间" : "Draw at"}: <b>${formatDateTimeForDisplay(giveaway.drawAt)}</b>`;
  const joinLine = requirements
    ? (
        locale === "zh-CN"
          ? `回复关键词 <code>${escapeHtml(requirements.keyword)}</code> 参与抽奖。`
          : `Reply with <code>${escapeHtml(requirements.keyword)}</code> to join.`
      )
    : (locale === "zh-CN" ? "点击下方按钮参与抽奖。" : "Tap the button below to join.");

  return locale === "zh-CN"
    ? [
        `🎁 <b>${escapeHtml(giveaway.title)}</b>`,
        "",
        `奖品: <b>${escapeHtml(giveaway.prize)}</b>`,
        `中奖人数: <b>${giveaway.winnersCount}</b>`,
        drawLine,
        "",
        joinLine
      ].join("\n")
    : [
        `🎁 <b>${escapeHtml(giveaway.title)}</b>`,
        "",
        `Prize: <b>${escapeHtml(giveaway.prize)}</b>`,
        `Winners: <b>${giveaway.winnersCount}</b>`,
        drawLine,
        "",
        joinLine
      ].join("\n");
}

function getCommonGiveawayRequirements(value: Prisma.JsonValue | null | undefined): CommonGiveawayRequirements | null {
  if (!isRecord(value)) return null;
  if (value.type !== "common" || value.entry !== "keyword") return null;
  if (typeof value.keyword !== "string" || !value.keyword.trim()) return null;
  const drawMode = typeof value.drawMode === "string" ? value.drawMode : undefined;
  if (!isGiveawayDrawMode(drawMode)) return null;
  const targetCount = Number(value.targetCount);
  return {
    type: "common",
    entry: "keyword",
    keyword: value.keyword.trim(),
    drawMode,
    ...(Number.isSafeInteger(targetCount) && targetCount > 0 ? { targetCount } : {})
  };
}

async function handleGiveawayKeywordEntry(ctx: Context, config: AppConfig, locale: Locale) {
  if (!ctx.chat || !ctx.from || !isGroupLike(ctx.chat)) return false;
  const message = ctx.message;
  if (!message) return false;
  const messageText = (getMessageText(message) ?? "").trim();
  if (!messageText) return false;

  const chat = await getActiveChatByTelegramId(ctx.chat.id);
  if (!chat) return false;

  const giveaways = await prisma.giveaway.findMany({
    where: { chatId: chat.id, status: GiveawayStatus.ACTIVE },
    orderBy: { createdAt: "desc" },
    take: 50
  });
  const matched = giveaways.filter((giveaway) => {
    const requirements = getCommonGiveawayRequirements(giveaway.joinRequirements);
    return requirements?.keyword === messageText;
  });
  if (!matched.length) return false;

  const user = await upsertTelegramUser(ctx.from, config.defaultTimezone);
  for (const giveaway of matched) {
    await prisma.giveawayEntry.upsert({
      where: { giveawayId_userId: { giveawayId: giveaway.id, userId: user.id } },
      create: { giveawayId: giveaway.id, userId: user.id },
      update: { isValid: true }
    });
    await maybeDrawGiveawayWhenFull(ctx, giveaway.id, locale);
  }

  await ctx.reply(
    matched.length === 1
      ? (locale === "zh-CN" ? "已参与抽奖。" : "Joined the giveaway.")
      : (locale === "zh-CN" ? `已参与 ${matched.length} 个抽奖。` : `Joined ${matched.length} giveaways.`)
  ).catch(() => undefined);
  return true;
}

async function maybeDrawGiveawayWhenFull(ctx: Context, giveawayId: string, locale: Locale) {
  const giveaway = await prisma.giveaway.findUnique({
    where: { id: giveawayId },
    select: { joinRequirements: true }
  });
  const requirements = getCommonGiveawayRequirements(giveaway?.joinRequirements);
  if (requirements?.drawMode !== "full" || !requirements.targetCount) return;

  const count = await prisma.giveawayEntry.count({ where: { giveawayId, isValid: true } });
  if (count < requirements.targetCount) return;
  await drawGiveawayNow(ctx, giveawayId, locale);
}

async function drawGiveawayNow(ctx: Context, giveawayId: string, locale: Locale) {
  const giveaway = await prisma.giveaway.findUnique({
    where: { id: giveawayId },
    include: {
      chat: true,
      entries: {
        where: { isValid: true },
        include: { user: true },
        orderBy: { joinedAt: "asc" }
      }
    }
  });
  if (!giveaway || giveaway.status !== GiveawayStatus.ACTIVE) return;

  const winners = pickGiveawayWinners(giveaway.entries, giveaway.winnersCount);
  const drawResult: Prisma.InputJsonObject = {
    drawnAt: new Date().toISOString(),
    entryCount: giveaway.entries.length,
    winnerCount: winners.length,
    winnerUserIds: winners.map((entry) => entry.userId),
    winnerTelegramUserIds: winners.map((entry) => entry.user.telegramUserId.toString()),
    trigger: "target_count"
  };

  const updated = await prisma.giveaway.updateMany({
    where: { id: giveaway.id, status: GiveawayStatus.ACTIVE },
    data: {
      status: GiveawayStatus.DRAWN,
      drawResult
    }
  });
  if (updated.count === 0) return;

  await cancelGiveawayDrawJob(giveaway.id);
  await prisma.auditLog.create({
    data: {
      chatId: giveaway.chatId,
      action: "giveaway.drawn",
      targetType: "giveaway",
      targetId: giveaway.id,
      metadata: drawResult
    }
  });

  await ctx.api.sendMessage(
    Number(giveaway.chat.telegramChatId),
    buildGiveawayDrawMessage(giveaway.title, giveaway.prize, winners.map((entry) => entry.user), locale),
    { parse_mode: "HTML" }
  ).catch(() => undefined);
}

function pickGiveawayWinners<T>(entries: T[], winnersCount: number) {
  const shuffled = [...entries];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled.slice(0, Math.max(0, Math.min(winnersCount, shuffled.length)));
}

function buildGiveawayDrawMessage(title: string, prize: string, winners: PrismaUser[], locale: Locale) {
  const header = locale === "zh-CN"
    ? [
        `🎁 <b>${escapeHtml(title)}</b>`,
        "",
        `奖品: <b>${escapeHtml(prize)}</b>`
      ]
    : [
        `🎁 <b>${escapeHtml(title)}</b>`,
        "",
        `Prize: <b>${escapeHtml(prize)}</b>`
      ];

  if (!winners.length) {
    return [
      ...header,
      "",
      locale === "zh-CN" ? "本次抽奖没有有效参与者，已自动结束。" : "No valid participants. The giveaway has ended."
    ].join("\n");
  }

  return [
    ...header,
    "",
    locale === "zh-CN" ? "<b>中奖用户:</b>" : "<b>Winners:</b>",
    ...winners.map((user, index) => `${index + 1}. ${mentionPrismaUser(user)}`)
  ].join("\n");
}

function mentionPrismaUser(user: PrismaUser) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim()
    || user.username
    || user.telegramUserId.toString();
  return `<a href="tg://user?id=${user.telegramUserId.toString()}">${escapeHtml(name)}</a>`;
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
  await maybeDrawGiveawayWhenFull(ctx, id, await getLocale(ctx));
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
  const raw = await getSettingRecord(chatId, "welcome");
  const rawText = typeof raw.text === "string" ? raw.text : undefined;
  const buttons = parseAutoReplyButtons(raw.buttons);
  const replyKeyboard = parseSavedReplyKeyboard(raw.replyKeyboard);
  return {
    ...defaultWelcomeSettings,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : defaultWelcomeSettings.enabled,
    text: rawText ? (rawText === legacyDefaultWelcomeText ? defaultWelcomeSettings.text : rawText) : defaultWelcomeSettings.text,
    deleteAfterMinutes: clampNumber(Number(raw.deleteAfterMinutes ?? defaultWelcomeSettings.deleteAfterMinutes), 0, 1440),
    mediaKind: isPublishMediaKind(raw.mediaKind) ? raw.mediaKind : undefined,
    mediaFileId: typeof raw.mediaFileId === "string" ? raw.mediaFileId : undefined,
    buttonText: typeof raw.buttonText === "string" ? raw.buttonText : "",
    buttonUrl: typeof raw.buttonUrl === "string" ? raw.buttonUrl : "",
    buttons,
    replyKeyboard,
    lastMessageIds: Array.isArray(raw.lastMessageIds)
      ? raw.lastMessageIds.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)
      : []
  } as WelcomeSettings;
}

async function saveWelcomeSettings(chatId: string, settings: WelcomeSettings) {
  await saveSetting(chatId, "welcome", settingsToJson(settings));
}

async function getBlocklistSettings(chatId: string) {
  const raw = await getSettingRecord(chatId, "blocklist");
  const blockBotPunishment = isBlocklistBotPunishment(raw.blockBotPunishment)
    ? raw.blockBotPunishment
    : raw.blockBots === true ? "ban" : defaultBlocklistSettings.blockBotPunishment;
  return {
    blockBots: blockBotPunishment !== "off",
    blockBotPunishment,
    banAfterLeave: typeof raw.banAfterLeave === "boolean" ? raw.banAfterLeave : defaultBlocklistSettings.banAfterLeave,
    blockFlashJoinLeave: typeof raw.blockFlashJoinLeave === "boolean" ? raw.blockFlashJoinLeave : defaultBlocklistSettings.blockFlashJoinLeave,
    blockFollowerRaid: typeof raw.blockFollowerRaid === "boolean" ? raw.blockFollowerRaid : defaultBlocklistSettings.blockFollowerRaid,
    flashWindowSeconds: clampNumber(Number(raw.flashWindowSeconds ?? defaultBlocklistSettings.flashWindowSeconds), 10, 3600),
    raidWindowSeconds: clampNumber(Number(raw.raidWindowSeconds ?? defaultBlocklistSettings.raidWindowSeconds), 10, 3600),
    raidJoinThreshold: clampNumber(Number(raw.raidJoinThreshold ?? defaultBlocklistSettings.raidJoinThreshold), 3, 100)
  } as BlocklistSettings;
}

async function saveBlocklistSettings(chatId: string, settings: BlocklistSettings) {
  await saveSetting(chatId, "blocklist", settingsToJson({
    blockBots: settings.blockBotPunishment !== "off",
    blockBotPunishment: settings.blockBotPunishment,
    banAfterLeave: settings.banAfterLeave,
    blockFlashJoinLeave: settings.blockFlashJoinLeave,
    blockFollowerRaid: settings.blockFollowerRaid,
    flashWindowSeconds: settings.flashWindowSeconds,
    raidWindowSeconds: settings.raidWindowSeconds,
    raidJoinThreshold: settings.raidJoinThreshold
  }));
}

async function getInviteLinkSettings(chatId: string) {
  const raw = await getSettingRecord(chatId, "invite_links");
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : defaultInviteLinkSettings.enabled,
    notify: typeof raw.notify === "boolean" ? raw.notify : defaultInviteLinkSettings.notify,
    createsJoinRequest: typeof raw.createsJoinRequest === "boolean"
      ? raw.createsJoinRequest
      : defaultInviteLinkSettings.createsJoinRequest,
    expireSeconds: clampNumber(Number(raw.expireSeconds ?? defaultInviteLinkSettings.expireSeconds), 0, 31_536_000),
    memberLimit: clampNumber(Number(raw.memberLimit ?? defaultInviteLinkSettings.memberLimit), 0, 99_999)
  } as InviteLinkSettings;
}

async function saveInviteLinkSettings(chatId: string, settings: InviteLinkSettings) {
  await saveSetting(chatId, "invite_links", settingsToJson(settings));
}

async function getInviteLinkStats(chatId: string) {
  const [activeLinks, totalInvites] = await Promise.all([
    prisma.inviteLink.count({
      where: { chatId, revokedAt: null }
    }),
    prisma.inviteJoin.count({
      where: { chatId, inviteLinkId: { not: null } }
    })
  ]);

  return { activeLinks, totalInvites };
}

async function getOrCreateInviteLink(ctx: Context, chat: PrismaChat, creatorUserId: string, settings: InviteLinkSettings) {
  const now = new Date();
  const existing = await prisma.inviteLink.findFirst({
    where: {
      chatId: chat.id,
      creatorUserId,
      revokedAt: null,
      OR: [
        { expireAt: null },
        { expireAt: { gt: now } }
      ]
    },
    orderBy: { createdAt: "desc" }
  });
  if (existing) return existing;

  const created = await createTelegramInviteLink(ctx, chat, settings).catch(() => null);
  if (!created) return null;

  return prisma.inviteLink.upsert({
    where: { inviteLink: created.invite_link },
    create: inviteLinkCreateData(chat.id, creatorUserId, created),
    update: {
      expireAt: created.expire_date ? new Date(created.expire_date * 1000) : null,
      memberLimit: created.member_limit ?? null,
      createsJoinRequest: Boolean(created.creates_join_request),
      revokedAt: created.is_revoked ? new Date() : null
    }
  });
}

async function createTelegramInviteLink(ctx: Context, chat: PrismaChat, settings: InviteLinkSettings) {
  const options: {
    name: string;
    expire_date?: number;
    member_limit?: number;
    creates_join_request?: boolean;
  } = {
    name: `dx-${ctx.from?.id ?? "user"}-${Date.now()}`.slice(0, 32)
  };

  if (settings.expireSeconds > 0) {
    options.expire_date = Math.floor(Date.now() / 1000) + settings.expireSeconds;
  }
  if (settings.createsJoinRequest) {
    options.creates_join_request = true;
  } else if (settings.memberLimit > 0) {
    options.member_limit = settings.memberLimit;
  }

  return ctx.api.createChatInviteLink(Number(chat.telegramChatId), options);
}

function inviteLinkCreateData(chatId: string, creatorUserId: string, link: ChatInviteLink) {
  return {
    chatId,
    creatorUserId,
    inviteLink: link.invite_link,
    expireAt: link.expire_date ? new Date(link.expire_date * 1000) : null,
    memberLimit: link.member_limit ?? null,
    createsJoinRequest: Boolean(link.creates_join_request),
    revokedAt: link.is_revoked ? new Date() : null
  };
}

async function exportInviteLinkData(ctx: Context, locale: Locale, chat: PrismaChat) {
  if (!ctx.chat) return false;

  const [links, joins] = await Promise.all([
    prisma.inviteLink.findMany({
      where: { chatId: chat.id },
      include: { creator: true, _count: { select: { joins: true } } },
      orderBy: { createdAt: "desc" }
    }),
    prisma.inviteJoin.findMany({
      where: { chatId: chat.id },
      include: { user: true, inviteLink: { include: { creator: true } } },
      orderBy: { joinedAt: "desc" }
    })
  ]);

  if (!links.length && !joins.length) {
    await ctx.answerCallbackQuery({
      text: locale === "zh-CN" ? "暂无邀请数据" : "No invite data yet.",
      show_alert: true
    }).catch(() => undefined);
    return false;
  }

  await ctx.answerCallbackQuery().catch(() => undefined);

  const rows = [
    [
      "section",
      "invite_link",
      "creator_telegram_id",
      "creator_username",
      "invite_count",
      "invitee_telegram_id",
      "invitee_username",
      "joined_at",
      "left_at",
      "expire_at",
      "member_limit",
      "revoked_at"
    ],
    ...links.map((link) => [
      "link",
      link.inviteLink,
      link.creator.telegramUserId.toString(),
      link.creator.username ?? "",
      String(link._count.joins),
      "",
      "",
      "",
      "",
      link.expireAt?.toISOString() ?? "",
      link.memberLimit?.toString() ?? "",
      link.revokedAt?.toISOString() ?? ""
    ]),
    ...joins.map((join) => [
      "join",
      join.inviteLink?.inviteLink ?? "",
      join.inviteLink?.creator.telegramUserId.toString() ?? "",
      join.inviteLink?.creator.username ?? "",
      "",
      join.user.telegramUserId.toString(),
      join.user.username ?? "",
      join.joinedAt.toISOString(),
      join.leftAt?.toISOString() ?? "",
      "",
      "",
      ""
    ])
  ];

  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  const fileName = `invite-links-${chat.telegramChatId.toString()}-${formatDate(new Date())}.csv`;
  await ctx.api.sendDocument(
    ctx.chat.id,
    new InputFile(Buffer.from(csv, "utf8"), fileName),
    { caption: locale === "zh-CN" ? "邀请链接数据导出" : "Invite link data export" }
  );
  return true;
}

async function resetInviteLinks(ctx: Context, chat: PrismaChat) {
  const links = await prisma.inviteLink.findMany({
    where: { chatId: chat.id, revokedAt: null },
    select: { id: true, inviteLink: true }
  });

  const revokedAt = new Date();
  for (const link of links) {
    await ctx.api.revokeChatInviteLink(Number(chat.telegramChatId), link.inviteLink).catch(() => undefined);
    await prisma.inviteLink.update({
      where: { id: link.id },
      data: { revokedAt }
    });
  }
}

async function resetInviteLinksForTelegramUser(ctx: Context, chatId: string, telegramUserId: number) {
  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!chat) return { foundUser: false, revokedLinks: 0, deletedInvites: 0 };

  const user = await prisma.user.findUnique({ where: { telegramUserId: BigInt(telegramUserId) } });
  if (!user) return { foundUser: false, revokedLinks: 0, deletedInvites: 0 };

  const links = await prisma.inviteLink.findMany({
    where: { chatId, creatorUserId: user.id },
    select: { id: true, inviteLink: true, revokedAt: true }
  });
  const linkIds = links.map((link) => link.id);
  if (!linkIds.length) return { foundUser: true, revokedLinks: 0, deletedInvites: 0 };

  let revokedLinks = 0;
  for (const link of links) {
    if (!link.revokedAt) {
      await ctx.api.revokeChatInviteLink(Number(chat.telegramChatId), link.inviteLink).catch(() => undefined);
      revokedLinks += 1;
    }
  }

  const deleted = await prisma.inviteJoin.deleteMany({
    where: { chatId, inviteLinkId: { in: linkIds } }
  });
  await prisma.inviteLink.deleteMany({
    where: { id: { in: linkIds } }
  });

  return { foundUser: true, revokedLinks, deletedInvites: deleted.count };
}

async function clearInviteLinksAndData(ctx: Context, chat: PrismaChat) {
  const links = await prisma.inviteLink.findMany({
    where: { chatId: chat.id },
    select: { inviteLink: true, revokedAt: true }
  });

  for (const link of links) {
    if (!link.revokedAt) {
      await ctx.api.revokeChatInviteLink(Number(chat.telegramChatId), link.inviteLink).catch(() => undefined);
    }
  }

  await prisma.inviteJoin.deleteMany({ where: { chatId: chat.id } });
  await prisma.inviteLink.deleteMany({ where: { chatId: chat.id } });
}

async function maybeSendInviteNotice(ctx: Context, chat: PrismaChat, member: User, creatorUserId: string) {
  const settings = await getInviteLinkSettings(chat.id);
  if (!settings.notify || !ctx.chat) return;

  const inviter = await prisma.user.findUnique({ where: { id: creatorUserId } });
  const count = await prisma.inviteJoin.count({
    where: {
      chatId: chat.id,
      inviteLink: { is: { creatorUserId } }
    }
  });

  await ctx.reply(
    [
      `🔗 ${displayName(member)} 通过邀请链接进群`,
      `邀请人: ${escapeHtml(inviter ? displayPrismaUser(inviter) : creatorUserId)}`,
      `有效邀请数: ${count}`
    ].join("\n"),
    { parse_mode: "HTML" }
  ).catch(() => undefined);
}

function inviteLinkText(chat: PrismaChat, settings: InviteLinkSettings, stats: Awaited<ReturnType<typeof getInviteLinkStats>>, locale: Locale) {
  const title = escapeHtml(chat.title ?? chat.username ?? String(chat.telegramChatId));
  if (locale !== "zh-CN") {
    return [
      `🔗 <b>[ ${title} ] Invite Link Generation</b>`,
      "",
      "When enabled, group members can use <code>/link</code> to generate a personal invite link and check invite stats.",
      "",
      "Anti-cheat:",
      "└ Only the first group join counts. Leaving and rejoining through another link will not move the invite credit.",
      "",
      `┌Status: ${settings.enabled ? "✅On" : "❌Off"}`,
      `├Link expiration: ${formatInviteExpire(settings.expireSeconds, locale)}`,
      `└Max invite members: ${settings.memberLimit || "Unlimited"}`,
      "",
      "Stats:",
      `┌Generated links: ${stats.activeLinks}`,
      `└Total invites: ${stats.totalInvites}`
    ].join("\n");
  }

  return [
    `🔗 <b>[ ${title} ]邀请链接生成</b>`,
    "",
    "开启后群组中成员使用 <code>/link</code> 指令自动生成链接和查询邀请统计",
    "",
    "防作弊:",
    "└ 只有第一次进群视为有效邀请数，退群再用其他人的链接加群不计算邀请数",
    "",
    `┌状态: ${settings.enabled ? "✅开启" : "❌关闭"}`,
    `├链接过期时间: ${formatInviteExpire(settings.expireSeconds, locale)}`,
    `└最大邀请人数: ${settings.memberLimit || "无限制"}`,
    "",
    "统计:",
    `┌已生成链接数: ${stats.activeLinks}`,
    `└总邀请人数: ${stats.totalInvites}`
  ].join("\n");
}

function formatInviteExpire(seconds: number, locale: Locale) {
  if (seconds <= 0) return locale === "zh-CN" ? "无限制" : "Unlimited";
  if (seconds % 86400 === 0) {
    const days = seconds / 86400;
    return locale === "zh-CN" ? `${days}天` : `${days}d`;
  }
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return locale === "zh-CN" ? `${hours}小时` : `${hours}h`;
  }
  return locale === "zh-CN" ? `${seconds}秒` : `${seconds}s`;
}

function inviteLinkInputPromptText(field: InviteLinkInputField, locale: Locale) {
  if (field === "resetUserId") {
    return locale === "zh-CN"
      ? [
          "<strong>重置链接</strong>",
          "",
          "重置某人的邀请链接和邀请数据",
          "",
          '<strong>请输入要重置链接的用户id(群里回复该用户 </strong><a href="tg://bot_command?command=info"><strong>/info</strong></a><strong> 可以查看):</strong>'
        ].join("\n")
      : [
          "<strong>Reset link</strong>",
          "",
          "Reset a user's invite links and invite data.",
          "",
          '<strong>Send the user ID to reset. Reply to that user with </strong><a href="tg://bot_command?command=info"><strong>/info</strong></a><strong> in the group to view it.</strong>'
        ].join("\n");
  }

  if (field === "expireDays") {
    return locale === "zh-CN"
      ? [
          "👉  <strong>请回复链接过期天数(不限制请输入:0)</strong>",
          "",
          "注意:此设置仅应用在新生成的链接中，不会修改已生成的链接"
        ].join("\n")
      : [
          "👉 <strong>Send the invite link expiration in days (send 0 for unlimited)</strong>",
          "",
          "Note: this only applies to newly generated links and will not modify existing links."
        ].join("\n");
  }

  return locale === "zh-CN"
    ? [
        "👉  <strong>请回复生成链接的最大邀请人数(不限制请输入:0)</strong>",
        "",
        "注意:此设置仅应用在新生成的链接中，不会修改已生成的链接"
      ].join("\n")
    : [
        "👉 <strong>Send the maximum invite members for generated links (send 0 for unlimited)</strong>",
        "",
        "Note: this only applies to newly generated links and will not modify existing links."
      ].join("\n");
}

function inviteLinkInputKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `invite:cancel:${chatId}`);
}

function inviteLinkSavedKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard().text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `invite:cancel:${chatId}`);
}

function inviteLinkInputSavedText(locale: Locale) {
  return locale === "zh-CN" ? "✅ 设置成功，点击按钮返回。" : "✅ Saved. Tap the button to return.";
}

function inviteLinkResetResultText(
  result: Awaited<ReturnType<typeof resetInviteLinksForTelegramUser>>,
  telegramUserId: number,
  locale: Locale
) {
  if (!result.foundUser) {
    return locale === "zh-CN"
      ? `未找到用户 ID <code>${telegramUserId}</code>，请确认后重新操作。`
      : `User ID <code>${telegramUserId}</code> was not found. Check it and try again.`;
  }

  if (result.revokedLinks === 0 && result.deletedInvites === 0) {
    return locale === "zh-CN"
      ? `用户 ID <code>${telegramUserId}</code> 暂无可重置的邀请链接和邀请数据。`
      : `User ID <code>${telegramUserId}</code> has no invite links or invite data to reset.`;
  }

  return locale === "zh-CN"
    ? [
        "✅ 重置成功，点击按钮返回。",
        "",
        `用户 ID: <code>${telegramUserId}</code>`,
        `已重置链接: ${result.revokedLinks}`,
        `已清理邀请数据: ${result.deletedInvites}`
      ].join("\n")
    : [
        "✅ Reset complete. Tap the button to return.",
        "",
        `User ID: <code>${telegramUserId}</code>`,
        `Reset links: ${result.revokedLinks}`,
        `Cleared invite records: ${result.deletedInvites}`
      ].join("\n");
}

function inviteLinkClearConfirmText(locale: Locale) {
  return locale === "zh-CN"
    ? "🚨🚨 请注意，即将清空所有邀请链接和邀请数据，操作不可恢复，是否继续"
    : "🚨🚨 This will clear all invite links and invite data. This cannot be undone. Continue?";
}

function inviteLinkClearConfirmKeyboard(chatId: string, locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "🔙返回" : "🔙 Back", `invite:cancel:${chatId}`)
    .text(locale === "zh-CN" ? "❗️确认删除" : "❗️Confirm delete", `invite:clear_confirm:${chatId}`);
}

function csvCell(value: string) {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

async function getAutoDeleteSettings(chatId: string) {
  const raw = await getSettingRecord(chatId, "auto_delete");
  const legacyEnabled = typeof raw.enabled === "boolean" ? raw.enabled : undefined;
  const settings = { ...defaultAutoDeleteSettings };
  for (const key of autoDeleteEventKeys) {
    const rawValue = raw[key];
    settings[key] = typeof rawValue === "boolean" ? rawValue : legacyEnabled ?? defaultAutoDeleteSettings[key];
  }
  settings.seconds = clampNumber(Number(raw.seconds ?? defaultAutoDeleteSettings.seconds), 0, 86400);
  settings.enabled = autoDeleteEventKeys.some((key) => settings[key]);
  return {
    ...settings
  };
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

async function getBannedWordsSettings(chatId: string): Promise<BannedWordsSettings> {
  const raw = await getSettingRecord(chatId, "banned_words");
  const punishment = parseBannedWordsPunishment(raw.punishment);
  const rawNoticeDeleteSeconds = Number(raw.noticeDeleteSeconds);
  const noticeDeleteSeconds = Number.isFinite(rawNoticeDeleteSeconds)
    ? clampNumber(rawNoticeDeleteSeconds, -1, 43200)
    : typeof raw.deleteNotice === "boolean"
      ? (raw.deleteNotice ? defaultBannedWordsSettings.noticeDeleteSeconds : -1)
      : defaultBannedWordsSettings.noticeDeleteSeconds;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : defaultBannedWordsSettings.enabled,
    punishment,
    warningPunishment: isBannedWordsFinalPunishment(raw.warningPunishment)
      ? raw.warningPunishment
      : raw.punishment === "warn_mute"
        ? "mute"
        : defaultBannedWordsSettings.warningPunishment,
    warningLimit: clampNumber(Number(raw.warningLimit ?? defaultBannedWordsSettings.warningLimit), 1, 5),
    muteMinutes: clampNumber(Number(raw.muteMinutes ?? defaultBannedWordsSettings.muteMinutes), 0, 525600),
    deleteNotice: noticeDeleteSeconds >= 0,
    noticeDeleteSeconds
  };
}

async function saveBannedWordsSettings(chatId: string, settings: BannedWordsSettings) {
  await saveSetting(chatId, "banned_words", settingsToJson({
    enabled: settings.enabled,
    punishment: settings.punishment,
    warningPunishment: settings.warningPunishment,
    warningLimit: settings.warningLimit,
    muteMinutes: settings.muteMinutes,
    deleteNotice: settings.noticeDeleteSeconds >= 0,
    noticeDeleteSeconds: settings.noticeDeleteSeconds
  }));
}

async function listBannedWordRules(chatId: string, take = 100) {
  return prisma.moderationRule.findMany({
    where: { chatId, ruleType: RuleType.KEYWORD, enabled: true },
    orderBy: { createdAt: "asc" },
    take,
    select: { id: true, pattern: true }
  });
}

async function countBannedWords(chatId: string) {
  return prisma.moderationRule.count({
    where: { chatId, ruleType: RuleType.KEYWORD, enabled: true }
  });
}

async function addBannedWords(chatId: string, inputWords: string[]) {
  const words = uniqueBannedWords(inputWords);
  if (!words.length) return 0;

  const existing = await prisma.moderationRule.findMany({
    where: { chatId, ruleType: RuleType.KEYWORD },
    select: { pattern: true }
  });
  const existingSet = new Set(existing.map((rule) => normalizeBannedWordForMatch(rule.pattern)));
  const nextWords = words.filter((word) => !existingSet.has(normalizeBannedWordForMatch(word)));
  if (!nextWords.length) return 0;

  await prisma.moderationRule.createMany({
    data: nextWords.map((word) => ({
      chatId,
      ruleType: RuleType.KEYWORD,
      pattern: word,
      action: RuleAction.DELETE_MESSAGE,
      enabled: true
    }))
  });
  return nextWords.length;
}

async function deleteBannedWordsByPattern(chatId: string, inputWords: string[]) {
  const targets = new Set(uniqueBannedWords(inputWords).map(normalizeBannedWordForMatch));
  if (!targets.size) return 0;

  const existing = await prisma.moderationRule.findMany({
    where: { chatId, ruleType: RuleType.KEYWORD },
    select: { id: true, pattern: true }
  });
  const ids = existing
    .filter((rule) => targets.has(normalizeBannedWordForMatch(rule.pattern)))
    .map((rule) => rule.id);
  if (!ids.length) return 0;

  const result = await prisma.moderationRule.deleteMany({
    where: { id: { in: ids }, chatId, ruleType: RuleType.KEYWORD }
  });
  return result.count;
}

async function getGroupCommandSettings(chatId: string): Promise<GroupCommandSettings> {
  const raw = await getSettingRecord(chatId, "group_commands");
  const rawCommands = isRecord(raw.commands) ? raw.commands : {};
  const rawAliases = isRecord(raw.aliases) ? raw.aliases : {};
  const commands = { ...defaultGroupCommandSettings.commands };
  const aliases = { ...defaultGroupCommandSettings.aliases };
  for (const item of groupCommandDefinitions) {
    const rawValue = rawCommands[item.key];
    if (typeof rawValue === "boolean") {
      commands[item.key] = rawValue;
    }
    if (Object.prototype.hasOwnProperty.call(rawAliases, item.key)) {
      aliases[item.key] = parseGroupCommandAliases(rawAliases[item.key]);
    }
  }
  return { commands, aliases };
}

async function saveGroupCommandSettings(chatId: string, settings: GroupCommandSettings) {
  await saveSetting(chatId, "group_commands", settingsToJson({
    commands: settings.commands,
    aliases: settings.aliases
  }));
}

async function getPointsSettings(chatId: string): Promise<PointsSettings> {
  const raw = await getSettingRecord(chatId, "points");
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : defaultPointsSettings.enabled,
    deleteSignInMessage: typeof raw.deleteSignInMessage === "boolean"
      ? raw.deleteSignInMessage
      : defaultPointsSettings.deleteSignInMessage,
    deleteSignInSeconds: clampNumber(Number(raw.deleteSignInSeconds ?? defaultPointsSettings.deleteSignInSeconds), 1, 3600),
    signInPoints: clampNumber(Number(raw.signInPoints ?? defaultPointsSettings.signInPoints), 0, 100000),
    speechPoints: clampNumber(Number(raw.speechPoints ?? defaultPointsSettings.speechPoints), 0, 100000),
    speechDailyLimit: clampNumber(Number(raw.speechDailyLimit ?? defaultPointsSettings.speechDailyLimit), 0, 1000000),
    speechMinLength: clampNumber(Number(raw.speechMinLength ?? defaultPointsSettings.speechMinLength), 0, 1000),
    invitePoints: clampNumber(Number(raw.invitePoints ?? defaultPointsSettings.invitePoints), 0, 100000),
    inviteDailyLimit: clampNumber(Number(raw.inviteDailyLimit ?? defaultPointsSettings.inviteDailyLimit), 0, 1000000)
  };
}

async function savePointsSettings(chatId: string, settings: PointsSettings) {
  await saveSetting(chatId, "points", settingsToJson(settings));
}

async function getPointExchangeSettings(chatId: string): Promise<PointExchangeSettings> {
  const raw = await getSettingRecord(chatId, "point_exchange");
  const products = Array.isArray(raw.products)
    ? raw.products.map(parsePointProduct).filter((item): item is PointProduct => Boolean(item)).slice(0, 100)
    : [];
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : defaultPointExchangeSettings.enabled,
    keyword: typeof raw.keyword === "string" && raw.keyword.trim()
      ? raw.keyword.trim().slice(0, 32)
      : defaultPointExchangeSettings.keyword,
    products
  };
}

async function savePointExchangeSettings(chatId: string, settings: PointExchangeSettings) {
  await saveSetting(chatId, "point_exchange", settingsToJson({
    enabled: settings.enabled,
    keyword: settings.keyword,
    products: settings.products.map((product) => ({
      id: product.id,
      name: product.name,
      cost: product.cost,
      listed: product.listed,
      codes: product.codes,
      soldCount: product.soldCount,
      dailyLimit: product.dailyLimit
    }))
  }));
}

function parsePointProduct(value: unknown): PointProduct | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim().slice(0, 16) : "";
  if (!id) return null;
  const rawCodes = Array.isArray(value.codes) ? value.codes : [];
  return {
    id,
    name: typeof value.name === "string" ? value.name.slice(0, 64) : "",
    cost: clampNumber(Number(value.cost ?? 1), 1, 1000000),
    listed: typeof value.listed === "boolean" ? value.listed : false,
    codes: rawCodes.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()).slice(0, 10000),
    soldCount: clampNumber(Number(value.soldCount ?? 0), 0, 100000000),
    dailyLimit: clampNumber(Number(value.dailyLimit ?? 0), 0, 1000000)
  };
}

function createPointProduct(): PointProduct {
  return {
    id: String(Math.floor(1000 + Math.random() * 9000)),
    name: "",
    cost: 1,
    listed: false,
    codes: [],
    soldCount: 0,
    dailyLimit: 0
  };
}

function isPointsRuleField(value: unknown): value is PointsRuleField {
  return typeof value === "string" && [
    "signInPoints",
    "deleteSignInSeconds",
    "speechPoints",
    "speechDailyLimit",
    "speechMinLength",
    "invitePoints",
    "inviteDailyLimit"
  ].includes(value);
}

function setPointsRuleField(settings: PointsSettings, field: PointsRuleField, value: number) {
  if (field === "signInPoints") settings.signInPoints = clampNumber(value, 0, 100000);
  if (field === "deleteSignInSeconds") settings.deleteSignInSeconds = clampNumber(value, 1, 3600);
  if (field === "speechPoints") settings.speechPoints = clampNumber(value, 0, 100000);
  if (field === "speechDailyLimit") settings.speechDailyLimit = clampNumber(value, 0, 1000000);
  if (field === "speechMinLength") settings.speechMinLength = clampNumber(value, 0, 1000);
  if (field === "invitePoints") settings.invitePoints = clampNumber(value, 0, 100000);
  if (field === "inviteDailyLimit") settings.inviteDailyLimit = clampNumber(value, 0, 1000000);
}

function pointsRuleForField(field: PointsRuleField): "sign" | "speech" | "invite" {
  if (field === "signInPoints" || field === "deleteSignInSeconds") return "sign";
  if (field === "speechPoints" || field === "speechDailyLimit" || field === "speechMinLength") return "speech";
  return "invite";
}

function isGroupCommandKey(value: unknown): value is GroupCommandKey {
  return typeof value === "string" && groupCommandDefinitions.some((item) => item.key === value);
}

function parseGroupCommandAliases(input: unknown): string[] {
  const source = Array.isArray(input)
    ? input.filter((item): item is string => typeof item === "string").join("\n")
    : typeof input === "string" ? input : "";
  if (!source) return [];
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const item of source.split(/[\r\n,，]+/)) {
    const alias = normalizeGroupCommandAlias(item);
    if (!alias || seen.has(alias)) continue;
    seen.add(alias);
    aliases.push(alias);
  }
  return aliases.slice(0, 20);
}

function normalizeGroupCommandAlias(value: string) {
  return value
    .trim()
    .split(/\s+/, 1)[0]
    ?.replace(/^\/+/, "")
    .replace(/@[^@\s]+$/, "")
    .toLocaleLowerCase()
    .slice(0, 32) ?? "";
}

function extractGroupCommandAlias(message: Message) {
  const text = getMessageText(message);
  if (!text) return "";
  return normalizeGroupCommandAlias(text);
}

async function getMemberStatsSettings(chatId: string): Promise<MemberStatsSettings> {
  const raw = await getSettingRecord(chatId, "member_stats");
  const snapshots = Array.isArray(raw.snapshots)
    ? raw.snapshots.map(parseMemberStatsSnapshot).filter((item): item is MemberStatsSnapshot => Boolean(item))
    : [];
  const lastCount = Number(raw.lastCount);

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : defaultMemberStatsSettings.enabled,
    lastCollectedDate: typeof raw.lastCollectedDate === "string" ? raw.lastCollectedDate : undefined,
    lastCount: Number.isInteger(lastCount) && lastCount >= 0 ? lastCount : undefined,
    snapshots
  };
}

async function saveMemberStatsSettings(chatId: string, settings: MemberStatsSettings) {
  await saveSetting(chatId, "member_stats", settingsToJson({
    enabled: settings.enabled,
    lastCollectedDate: settings.lastCollectedDate,
    lastCount: settings.lastCount,
    snapshots: settings.snapshots.slice(-120)
  }));
}

async function getGroupMembersSettings(chatId: string): Promise<GroupMembersSettings> {
  const raw = await getSettingRecord(chatId, "group_members");
  return {
    watchNicknameChange: typeof raw.watchNicknameChange === "boolean"
      ? raw.watchNicknameChange
      : defaultGroupMembersSettings.watchNicknameChange,
    watchUsernameChange: typeof raw.watchUsernameChange === "boolean"
      ? raw.watchUsernameChange
      : defaultGroupMembersSettings.watchUsernameChange,
    unpinLinkedChannelMessages: typeof raw.unpinLinkedChannelMessages === "boolean"
      ? raw.unpinLinkedChannelMessages
      : defaultGroupMembersSettings.unpinLinkedChannelMessages
  };
}

async function saveGroupMembersSettings(chatId: string, settings: GroupMembersSettings) {
  await saveSetting(chatId, "group_members", settingsToJson(settings));
}

function parseMemberStatsSnapshot(value: unknown): MemberStatsSnapshot | null {
  if (!isRecord(value)) return null;
  const count = Number(value.count);
  if (typeof value.date !== "string" || !Number.isInteger(count) || count < 0) return null;
  return {
    date: value.date,
    count,
    collectedAt: typeof value.collectedAt === "string" ? value.collectedAt : new Date().toISOString()
  };
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

function parseSavedReplyKeyboard(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value
    .map((row) => Array.isArray(row)
      ? row
        .map((item) => typeof item === "string" ? item.trim().slice(0, 64) : "")
        .filter(Boolean)
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

async function getJoinVerifySettings(chatId: string): Promise<JoinVerifySettings> {
  const raw = await getSettingRecord(chatId, "join_verify");
  const durationValue = Number(raw.durationMinutes);
  return {
    ...defaultJoinVerifySettings,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : defaultJoinVerifySettings.enabled,
    adminApproval: typeof raw.adminApproval === "boolean" ? raw.adminApproval : defaultJoinVerifySettings.adminApproval,
    mode: isJoinVerifyMode(raw.mode) ? raw.mode : defaultJoinVerifySettings.mode,
    durationMinutes: Number.isFinite(durationValue) && durationValue > 0
      ? clampNumber(durationValue, 1, 24 * 60)
      : defaultJoinVerifySettings.durationMinutes,
    punishment: raw.punishment === "kick" || raw.punishment === "ban" || raw.punishment === "mute"
      ? raw.punishment
      : defaultJoinVerifySettings.punishment
  };
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

async function recordInviteJoin(ctx: Context, chat: PrismaChat, member: User) {
  const inviteLink = extractInviteLink(ctx.message);
  const user = await prisma.user.findUnique({ where: { telegramUserId: BigInt(member.id) } });
  if (!user) return;

  const savedInviteLink = inviteLink
    ? await prisma.inviteLink.findUnique({ where: { inviteLink: inviteLink.invite_link } })
    : null;

  const existing = await prisma.inviteJoin.findUnique({
    where: { chatId_userId: { chatId: chat.id, userId: user.id } }
  });

  if (existing) {
    await prisma.inviteJoin.update({
      where: { id: existing.id },
      data: { leftAt: null }
    });
    return;
  }

  await prisma.inviteJoin.create({
    data: {
      chatId: chat.id,
      userId: user.id,
      inviteLinkId: savedInviteLink?.id ?? null
    }
  });

  if (savedInviteLink) {
    await maybeRewardInvitePoints(chat, savedInviteLink.creatorUserId, user.id);
    await maybeSendInviteNotice(ctx, chat, member, savedInviteLink.creatorUserId);
  }
}

async function maybeRewardInvitePoints(chat: PrismaChat, inviterUserId: string, invitedUserId: string) {
  if (inviterUserId === invitedUserId) return;
  const settings = await getPointsSettings(chat.id);
  if (!settings.enabled || settings.invitePoints <= 0) return;

  const dayKey = formatDate(new Date());
  let delta = settings.invitePoints;
  if (settings.inviteDailyLimit > 0) {
    const earned = await getDailyPointDelta(chat.id, inviterUserId, PointTransactionType.INVITE, dayKey);
    const remaining = settings.inviteDailyLimit - earned;
    if (remaining <= 0) return;
    delta = Math.min(delta, remaining);
  }

  await addPoints(
    chat.id,
    inviterUserId,
    delta,
    PointTransactionType.INVITE,
    `invite:${chat.id}:${inviterUserId}:${invitedUserId}`,
    null,
    dayKey
  );
}

async function recordInviteLeave(chatId: string, member: User) {
  const user = await prisma.user.findUnique({ where: { telegramUserId: BigInt(member.id) } });
  if (!user) return;

  await prisma.inviteJoin.updateMany({
    where: { chatId, userId: user.id, leftAt: null },
    data: { leftAt: new Date() }
  });
}

async function maybeRecordMemberCountSnapshot(ctx: Context, chat: PrismaChat, currentSettings?: MemberStatsSettings) {
  const settings = currentSettings ?? await getMemberStatsSettings(chat.id);
  if (!settings.enabled) return settings;

  const today = formatDate(new Date());
  if (settings.lastCollectedDate === today) return settings;

  const count = await ctx.api.getChatMemberCount(Number(chat.telegramChatId)).catch(() => null);
  if (typeof count !== "number") return settings;

  const snapshot = { date: today, count, collectedAt: new Date().toISOString() };
  const snapshots = settings.snapshots.filter((item) => item.date !== today);
  snapshots.push(snapshot);

  const next = {
    ...settings,
    lastCollectedDate: today,
    lastCount: count,
    snapshots: snapshots.slice(-120)
  };
  await saveMemberStatsSettings(chat.id, next);
  return next;
}

async function maybeAutoDelete(ctx: Context, chatId: string, message: Message) {
  const settings = await getAutoDeleteSettings(chatId);
  const eventKey = autoDeleteEventKey(message);
  if (!eventKey || !settings[eventKey] || !ctx.chat) return;

  const deleteMessage = () => ctx.api.deleteMessage(ctx.chat!.id, message.message_id).catch(() => undefined);
  if (settings.seconds <= 0) {
    await deleteMessage();
    return;
  }

  setTimeout(() => {
    void deleteMessage();
  }, settings.seconds * 1000);
}

async function maybeHandleBannedWords(ctx: Context, chat: PrismaChat, message: Message) {
  if (!ctx.chat || !ctx.from || !isGroupLike(ctx.chat) || ctx.from.is_bot) return false;
  const text = getMessageText(message);
  if (!text) return false;

  const settings = await getBannedWordsSettings(chat.id);
  if (!settings.enabled) return false;

  const isAdmin = await isUserChatAdmin(ctx, Number(chat.telegramChatId), ctx.from.id).catch(() => false);
  if (isAdmin) return false;

  const rules = await listBannedWordRules(chat.id, 500);
  const matched = findMatchedBannedWord(text, rules.map((rule) => rule.pattern));
  if (!matched) return false;

  await ctx.api.deleteMessage(ctx.chat.id, message.message_id).catch((error) => {
    console.error("Failed to delete banned-word message", {
      chatId: chat.id,
      telegramChatId: ctx.chat?.id,
      messageId: message.message_id,
      error
    });
  });

  await applyBannedWordsPunishment(ctx, chat, ctx.from, matched, settings);
  return true;
}

async function applyBannedWordsPunishment(
  ctx: Context,
  chat: PrismaChat,
  user: User,
  matchedWord: string,
  settings: BannedWordsSettings
) {
  const telegramChatId = Number(chat.telegramChatId);
  const name = displayName(user);
  const matched = escapeHtml(matchedWord);

  if (settings.punishment === "delete_only") {
    await sendBannedWordsNotice(ctx, telegramChatId, `${name} 触发违禁词 <code>${matched}</code>，消息已删除。`, settings);
    return;
  }

  if (settings.punishment !== "warn") {
    await applyBannedWordsFinalPunishment(ctx, telegramChatId, user.id, settings.punishment, settings.muteMinutes);
    await sendBannedWordsNotice(
      ctx,
      telegramChatId,
      `${name} 触发违禁词 <code>${matched}</code>，已${bannedWordsFinalPunishmentNoticeLabel(settings.punishment, settings, "zh-CN")}。`,
      settings
    );
    clearBannedWordWarning(chat.id, user.id);
    return;
  }

  const warningCount = incrementBannedWordWarning(chat.id, user.id);
  if (warningCount >= settings.warningLimit) {
    await applyBannedWordsFinalPunishment(ctx, telegramChatId, user.id, settings.warningPunishment, settings.muteMinutes);
    clearBannedWordWarning(chat.id, user.id);
    await sendBannedWordsNotice(
      ctx,
      telegramChatId,
      `${name} 触发违禁词 <code>${matched}</code>，警告已达 ${settings.warningLimit} 次，已${bannedWordsFinalPunishmentNoticeLabel(settings.warningPunishment, settings, "zh-CN")}。`,
      settings
    );
    return;
  }

  await sendBannedWordsNotice(
    ctx,
    telegramChatId,
    `${name} 触发违禁词 <code>${matched}</code>，警告 ${warningCount}/${settings.warningLimit}。`,
    settings
  );
}

async function sendBannedWordsNotice(ctx: Context, telegramChatId: number, text: string, settings: BannedWordsSettings) {
  if (settings.noticeDeleteSeconds < 0) return;
  const sent = await ctx.api.sendMessage(telegramChatId, text, { parse_mode: "HTML" }).catch(() => null);
  if (!sent || settings.noticeDeleteSeconds <= 0) return;
  setTimeout(() => {
    void ctx.api.deleteMessage(telegramChatId, sent.message_id).catch(() => undefined);
  }, settings.noticeDeleteSeconds * 1000);
}

async function muteUser(ctx: Context, chatId: number, userId: number, minutes: number) {
  const untilDate = minutes <= 0 ? 0 : Math.floor((Date.now() + minutes * 60 * 1000) / 1000);
  await ctx.api.restrictChatMember(chatId, userId, noChatPermissions(), { until_date: untilDate }).catch((error) => {
    console.error("Failed to mute member", { chatId, userId, minutes, error });
  });
}

async function applyBannedWordsFinalPunishment(
  ctx: Context,
  chatId: number,
  userId: number,
  punishment: BannedWordsFinalPunishment,
  muteMinutes: number
) {
  if (punishment === "mute") {
    await muteUser(ctx, chatId, userId, muteMinutes);
    return;
  }
  if (punishment === "kick") {
    await kickUser(ctx, chatId, userId);
    return;
  }
  await banUser(ctx, chatId, userId);
}

async function kickUser(ctx: Context, chatId: number, userId: number) {
  await ctx.api.banChatMember(chatId, userId).catch((error) => {
    console.error("Failed to kick member", { chatId, userId, error });
  });
  await ctx.api.unbanChatMember(chatId, userId, { only_if_banned: true }).catch(() => undefined);
}

function incrementBannedWordWarning(chatId: string, userId: number) {
  const key = userChatKey(chatId, userId);
  const now = Date.now();
  const existing = bannedWordWarnings.get(key);
  if (!existing || existing.expiresAt <= now) {
    bannedWordWarnings.set(key, { count: 1, expiresAt: now + 24 * 60 * 60 * 1000 });
    return 1;
  }
  const count = existing.count + 1;
  bannedWordWarnings.set(key, { count, expiresAt: existing.expiresAt });
  return count;
}

function clearBannedWordWarning(chatId: string, userId: number) {
  bannedWordWarnings.delete(userChatKey(chatId, userId));
}

function findMatchedBannedWord(text: string, patterns: string[]) {
  const normalizedText = normalizeBannedWordForMatch(text);
  return patterns.find((pattern) => normalizedText.includes(normalizeBannedWordForMatch(pattern)));
}

function autoDeleteEventKey(message: Message): AutoDeleteEventKey | undefined {
  if ("new_chat_members" in message && message.new_chat_members?.length) return "join";
  if ("left_chat_member" in message && message.left_chat_member) return "leave";
  if ("boost_added" in message && message.boost_added) return "boost";
  if ("pinned_message" in message && message.pinned_message) return "pin";
  if ("new_chat_photo" in message && message.new_chat_photo?.length) return "photo";
  if ("delete_chat_photo" in message && message.delete_chat_photo) return "photo";
  if ("new_chat_title" in message && message.new_chat_title) return "title";
  return undefined;
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

async function maybeHandlePointExchangeKeyword(ctx: Context, chat: PrismaChat, message: Message) {
  if (!ctx.chat || !isGroupLike(ctx.chat)) return false;
  const text = getMessageText(message);
  if (!text) return false;

  const settings = await getPointExchangeSettings(chat.id);
  if (!settings.enabled || text.trim() !== settings.keyword) return false;

  const products = settings.products.filter((item) => item.listed);
  if (!products.length) {
    await ctx.reply("暂无可兑换商品。").catch(() => undefined);
    return true;
  }

  const lines = products.map((product, index) => {
    const name = product.name || "未命名商品";
    return `${index + 1}. ${escapeHtml(name)} - ${product.cost} 积分 - 剩余 ${product.codes.length}`;
  });
  await ctx.reply(["🛒 <b>商品兑换</b>", "", ...lines].join("\n"), {
    parse_mode: "HTML",
    reply_markup: exchangeProductListKeyboard(chat.id, products, "zh-CN")
  });
  return true;
}

async function handlePointExchangeRedeem(ctx: Context, locale: Locale, chat: PrismaChat, productId: string) {
  if (!ctx.from) {
    await ctx.answerCallbackQuery({ text: locale === "zh-CN" ? "无法识别用户。" : "User not found.", show_alert: true }).catch(() => undefined);
    return;
  }

  const settings = await getPointExchangeSettings(chat.id);
  if (!settings.enabled) {
    await ctx.answerCallbackQuery({ text: locale === "zh-CN" ? "商品兑换未开启。" : "Product exchange is disabled.", show_alert: true }).catch(() => undefined);
    return;
  }

  const product = settings.products.find((item) => item.id === productId);
  if (!product || !product.listed) {
    await ctx.answerCallbackQuery({ text: locale === "zh-CN" ? "商品不可兑换。" : "Product unavailable.", show_alert: true }).catch(() => undefined);
    return;
  }
  if (!product.codes.length) {
    await ctx.answerCallbackQuery({ text: locale === "zh-CN" ? "库存不足。" : "Out of stock.", show_alert: true }).catch(() => undefined);
    return;
  }

  const user = await upsertTelegramUser(ctx.from, chat.timezone);
  const balance = await prisma.chatPointBalance.findUnique({ where: { chatId_userId: { chatId: chat.id, userId: user.id } } });
  if ((balance?.balance ?? 0) < product.cost) {
    await ctx.answerCallbackQuery({ text: locale === "zh-CN" ? "积分不足。" : "Not enough points.", show_alert: true }).catch(() => undefined);
    return;
  }

  const dayKey = formatDate(new Date());
  if (product.dailyLimit > 0) {
    const todayCount = await prisma.chatPointTransaction.count({
      where: {
        chatId: chat.id,
        userId: user.id,
        type: PointTransactionType.EXCHANGE,
        dayKey,
        referenceKey: { startsWith: `exchange:${product.id}:` }
      }
    });
    if (todayCount >= product.dailyLimit) {
      await ctx.answerCallbackQuery({ text: locale === "zh-CN" ? "今日兑换次数已达上限。" : "Daily exchange limit reached.", show_alert: true }).catch(() => undefined);
      return;
    }
  }

  const code = product.codes.shift();
  if (!code) return;
  product.soldCount += 1;
  await savePointExchangeSettings(chat.id, settings);
  const currentBalance = await addPoints(
    chat.id,
    user.id,
    -product.cost,
    PointTransactionType.EXCHANGE,
    `exchange:${product.id}:${user.id}:${Date.now()}`,
    null,
    dayKey
  );

  await ctx.answerCallbackQuery({ text: locale === "zh-CN" ? "兑换成功。" : "Redeemed." }).catch(() => undefined);
  await ctx.api.sendMessage(
    ctx.from.id,
    locale === "zh-CN"
      ? [`兑换成功：${escapeHtml(product.name || "未命名商品")}`, `卡密：<code>${escapeHtml(code)}</code>`, `当前积分：${currentBalance}`].join("\n")
      : [`Redeemed: ${escapeHtml(product.name || "Unnamed product")}`, `Code: <code>${escapeHtml(code)}</code>`, `Current points: ${currentBalance}`].join("\n"),
    { parse_mode: "HTML" }
  ).catch(async () => {
    await ctx.reply(locale === "zh-CN" ? "兑换成功，请先私聊机器人 /start 后再领取卡密。" : "Redeemed. Start a private chat with the bot to receive the code.").catch(() => undefined);
  });
}

async function findPointTargetUser(chatId: string, input: string) {
  const value = input.trim().replace(/^@/, "");
  if (!value) return null;

  const userWhere = /^\d+$/.test(value)
    ? { telegramUserId: BigInt(value) }
    : { username: { equals: value, mode: "insensitive" as const } };

  const balance = await prisma.chatPointBalance.findFirst({
    where: {
      chatId,
      user: userWhere
    },
    include: { user: true }
  });
  if (balance?.user) return balance.user;

  return prisma.user.findFirst({ where: userWhere });
}

async function maybeRewardSpeechPoints(ctx: Context, config: AppConfig, chat: PrismaChat, message: Message) {
  if (!ctx.chat || !ctx.from || ctx.from.is_bot) return;
  const text = getMessageText(message);
  if (!text || text.startsWith("/")) return;

  const settings = await getPointsSettings(chat.id);
  if (!settings.enabled || settings.speechPoints <= 0) return;
  if (text.length < settings.speechMinLength) return;

  const user = await upsertTelegramUser(ctx.from, config.defaultTimezone);
  const dayKey = formatDate(new Date());
  let delta = settings.speechPoints;
  if (settings.speechDailyLimit > 0) {
    const earned = await getDailyPointDelta(chat.id, user.id, PointTransactionType.SPEECH, dayKey);
    const remaining = settings.speechDailyLimit - earned;
    if (remaining <= 0) return;
    delta = Math.min(delta, remaining);
  }

  await addPoints(
    chat.id,
    user.id,
    delta,
    PointTransactionType.SPEECH,
    `speech:${chat.id}:${user.id}:${message.message_id}`,
    null,
    dayKey
  );
}

async function addPoints(
  chatId: string,
  userId: string,
  delta: number,
  type: PointTransactionType,
  referenceKey: string | null,
  actorUserId: string | null,
  dayKey: string | null = null
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
        dayKey,
        metadata: {}
      }
    });

    return balance.balance;
  });

  return result;
}

async function getDailyPointDelta(chatId: string, userId: string, type: PointTransactionType, dayKey: string) {
  const result = await prisma.chatPointTransaction.aggregate({
    where: {
      chatId,
      userId,
      type,
      dayKey,
      delta: { gt: 0 }
    },
    _sum: { delta: true }
  });
  return result._sum.delta ?? 0;
}

function scheduleTelegramMessageDelete(ctx: Context, chatId: number, messageId: number, seconds: number) {
  setTimeout(() => {
    void ctx.api.deleteMessage(chatId, messageId).catch(() => undefined);
  }, seconds * 1000);
}

async function openGroupStatsPanel(ctx: Context, locale: Locale, chat: PrismaChat) {
  await editOrReply(ctx, groupStatsHomeText(chat, locale), groupStatsKeyboard(chat.id, locale));
}

async function openMemberStatsPanel(ctx: Context, locale: Locale, chat: PrismaChat) {
  const settings = await maybeRecordMemberCountSnapshot(ctx, chat);
  await editOrReply(ctx, memberStatsText(settings, locale), memberStatsKeyboard(chat, settings, locale));
}

async function openGroupMembersPanel(ctx: Context, locale: Locale, chat: PrismaChat) {
  const settings = await getGroupMembersSettings(chat.id);
  await editOrReply(ctx, groupMembersText(settings, locale), groupMembersKeyboard(chat, settings, locale));
}

async function sendMemberStatsReport(
  ctx: Context,
  chat: PrismaChat,
  settings: MemberStatsSettings,
  days: 7 | 31,
  locale: Locale
) {
  if (ctx.callbackQuery?.message && "photo" in ctx.callbackQuery.message) {
    await ctx.deleteMessage().catch(() => undefined);
  }

  const report = buildMemberStatsReport(chat, settings, days, locale);
  const image = renderMemberStatsChartPng(report.rows);
  const sent = await ctx.replyWithPhoto(new InputFile(image, `member-stats-${chat.telegramChatId}-${days}d.png`), {
    caption: report.caption,
    parse_mode: "HTML",
    reply_markup: memberStatsReportKeyboard(chat.id, days, locale)
  });
  const photoFileId = "photo" in sent ? sent.photo.at(-1)?.file_id : undefined;
  if (photoFileId) {
    memberStatsShareCache.set(memberStatsInlineQuery(chat.id, days), {
      photoFileId,
      caption: report.caption,
      title: chat.title ?? chat.username ?? String(chat.telegramChatId),
      updatedAt: Date.now()
    });
  }
}

async function handleMemberStatsInlineQuery(ctx: Context) {
  const query = ctx.inlineQuery;
  if (!query) return;

  const [, chatId = "", daysValue = "7"] = query.query.split(":");
  const days: 7 | 31 = daysValue === "31" ? 31 : 7;
  const locale = await getLocale(ctx);
  const chat = chatId ? await prisma.chat.findUnique({ where: { id: chatId } }) : null;
  if (!chat) {
    await ctx.answerInlineQuery([], { cache_time: 0, is_personal: true });
    return;
  }

  const settings = await getMemberStatsSettings(chat.id);
  const report = buildMemberStatsReport(chat, settings, days, locale);
  const cache = memberStatsShareCache.get(memberStatsInlineQuery(chat.id, days));
  const title = locale === "zh-CN" ? `人数统计 ${days}天` : `Member stats ${days}d`;
  const description = chat.title ?? chat.username ?? String(chat.telegramChatId);
  const result: InlineQueryResult = cache
    ? {
        type: "photo",
        id: `member-stats-photo-${chat.id}-${days}-${cache.updatedAt}`,
        photo_file_id: cache.photoFileId,
        title,
        description,
        caption: cache.caption,
        parse_mode: "HTML"
      }
    : {
        type: "article",
        id: `member-stats-text-${chat.id}-${days}`,
        title,
        description,
        input_message_content: {
          message_text: report.caption,
          parse_mode: "HTML"
        }
      };

  await ctx.answerInlineQuery([result], {
    cache_time: 0,
    is_personal: true
  });
}

function memberStatsReportKeyboard(chatId: string, days: 7 | 31, locale: Locale) {
  return new InlineKeyboard()
    .text(locale === "zh-CN" ? "一周" : "Week", `member_stats:view:${chatId}:7`)
    .text(locale === "zh-CN" ? "一月" : "Month", `member_stats:view:${chatId}:31`)
    .row()
    .text(locale === "zh-CN" ? "❌关闭" : "❌Close", `member_stats:close:${chatId}`)
    .switchInline(locale === "zh-CN" ? "分享" : "Share", memberStatsInlineQuery(chatId, days));
}

function memberStatsInlineQuery(chatId: string, days: 7 | 31) {
  return `member_stats:${chatId}:${days}`;
}

function buildMemberStatsReport(chat: PrismaChat, settings: MemberStatsSettings, days: 7 | 31, locale: Locale) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const dateKeys = recentDateKeys(days, end);
  const snapshotsByDate = new Map(settings.snapshots.map((item) => [item.date, item]));
  const priorSnapshots = settings.snapshots
    .filter((item) => item.date < (dateKeys[0] ?? ""))
    .sort((a, b) => a.date.localeCompare(b.date));
  let previousCount = priorSnapshots[priorSnapshots.length - 1]?.count ?? 0;
  const rows = dateKeys.map((date) => {
    const count = snapshotsByDate.get(date)?.count ?? 0;
    const delta = count - previousCount;
    const percent = previousCount > 0 ? (delta / previousCount) * 100 : 0;
    previousCount = count;
    return { date, count, delta, percent };
  });
  const title = escapeHtml(chat.title ?? chat.username ?? String(chat.telegramChatId));
  const caption = locale === "zh-CN"
    ? [
        `【${title}】 的统计数据 过去${days}天.`,
        "",
        `<pre>${escapeHtml(rows.map(formatMemberStatsReportRow).join("\n"))}</pre>`
      ].join("\n")
    : [
        `<b>${title}</b> member stats for the last ${days} days.`,
        "",
        `<pre>${escapeHtml(rows.map(formatMemberStatsReportRow).join("\n"))}</pre>`
      ].join("\n");
  return { rows, caption };
}

function formatMemberStatsReportRow(row: { date: string; count: number; delta: number; percent: number }) {
  const sign = row.delta >= 0 ? "+" : "";
  return `${row.date} ${row.count}${sign}${row.delta} ${row.percent.toFixed(1)}%`;
}

function renderMemberStatsChartPng(rows: Array<{ count: number; delta: number }>) {
  const width = 840;
  const height = 420;
  const pixels = new Uint8Array(width * height * 4);
  const setPixel = (x: number, y: number, color: [number, number, number, number]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (Math.floor(y) * width + Math.floor(x)) * 4;
    pixels[offset] = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
    pixels[offset + 3] = color[3];
  };
  const fillRect = (x: number, y: number, w: number, h: number, color: [number, number, number, number]) => {
    for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(height, Math.ceil(y + h)); yy += 1) {
      for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(width, Math.ceil(x + w)); xx += 1) {
        setPixel(xx, yy, color);
      }
    }
  };
  const drawLine = (x0: number, y0: number, x1: number, y1: number, color: [number, number, number, number]) => {
    let x = Math.round(x0);
    let y = Math.round(y0);
    const endX = Math.round(x1);
    const endY = Math.round(y1);
    const dx = Math.abs(endX - x);
    const sx = x < endX ? 1 : -1;
    const dy = -Math.abs(endY - y);
    const sy = y < endY ? 1 : -1;
    let error = dx + dy;
    while (true) {
      fillRect(x - 1, y - 1, 3, 3, color);
      if (x === endX && y === endY) break;
      const e2 = 2 * error;
      if (e2 >= dy) {
        error += dy;
        x += sx;
      }
      if (e2 <= dx) {
        error += dx;
        y += sy;
      }
    }
  };
  const fillCircle = (cx: number, cy: number, radius: number, color: [number, number, number, number]) => {
    for (let y = -radius; y <= radius; y += 1) {
      for (let x = -radius; x <= radius; x += 1) {
        if (x * x + y * y <= radius * radius) setPixel(cx + x, cy + y, color);
      }
    }
  };

  fillRect(0, 0, width, height, [255, 255, 255, 255]);
  const margin = { left: 64, right: 36, top: 36, bottom: 58 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const axis = [145, 156, 175, 255] as [number, number, number, number];
  const grid = [226, 232, 240, 255] as [number, number, number, number];
  const blue = [37, 99, 235, 255] as [number, number, number, number];
  const green = [22, 163, 74, 255] as [number, number, number, number];

  for (let index = 0; index <= 4; index += 1) {
    const y = margin.top + (plotHeight / 4) * index;
    drawLine(margin.left, y, width - margin.right, y, grid);
  }
  drawLine(margin.left, margin.top, margin.left, height - margin.bottom, axis);
  drawLine(margin.left, height - margin.bottom, width - margin.right, height - margin.bottom, axis);

  const counts = rows.map((row) => row.count);
  const maxCount = Math.max(1, ...counts);
  const minCount = Math.min(0, ...counts);
  const range = Math.max(1, maxCount - minCount);
  const points = rows.map((row, index) => {
    const x = margin.left + (rows.length <= 1 ? plotWidth / 2 : (plotWidth / (rows.length - 1)) * index);
    const y = height - margin.bottom - ((row.count - minCount) / range) * plotHeight;
    return { x, y, row };
  });

  for (let index = 1; index < points.length; index += 1) {
    const prev = points[index - 1];
    const next = points[index];
    if (prev && next) drawLine(prev.x, prev.y, next.x, next.y, blue);
  }
  for (const point of points) {
    fillCircle(Math.round(point.x), Math.round(point.y), 7, point.row.delta >= 0 ? green : blue);
    fillCircle(Math.round(point.x), Math.round(point.y), 3, [255, 255, 255, 255]);
  }

  return encodePng(width, height, pixels);
}

function encodePng(width: number, height: number, rgba: Uint8Array) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.concat([
      uint32be(width),
      uint32be(height),
      Buffer.from([8, 6, 0, 0, 0])
    ])),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngChunk(type: string, data: Buffer) {
  const typeBuffer = Buffer.from(type, "ascii");
  const payload = Buffer.concat([typeBuffer, data]);
  return Buffer.concat([
    uint32be(data.length),
    payload,
    uint32be(crc32(payload))
  ]);
}

function uint32be(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function renderGroupStatsActionText(chatId: string, action: string, locale: Locale) {
  const todayKeys = recentDateKeys(1);
  const sevenDayKeys = recentDateKeys(7);
  const monthKeys = currentMonthDateKeys();

  if (action === "speech_today_rank") {
    const rows = await getMessageRanking(chatId, todayKeys);
    return rankingText(locale === "zh-CN" ? "今日发言排名" : "Today message ranking", todayKeys, rows, locale, locale === "zh-CN" ? "条" : "messages");
  }

  if (action === "speech_7d_rank") {
    const rows = await getMessageRanking(chatId, sevenDayKeys);
    return rankingText(locale === "zh-CN" ? "7日发言排名" : "7-day message ranking", sevenDayKeys, rows, locale, locale === "zh-CN" ? "条" : "messages");
  }

  if (action === "speech_7d_stats") {
    const summary = await getMessageStatsSummary(chatId, sevenDayKeys);
    return messageStatsSummaryText(summary, sevenDayKeys, locale);
  }

  if (action === "speech_month_rank") {
    const rows = await getMessageRanking(chatId, monthKeys);
    return rankingText(locale === "zh-CN" ? "月发言排名" : "Monthly message ranking", monthKeys, rows, locale, locale === "zh-CN" ? "条" : "messages");
  }

  if (action === "invite_today_rank") {
    const rows = await getInviteRanking(chatId, todayKeys);
    return rankingText(locale === "zh-CN" ? "今日邀请排名" : "Today invite ranking", todayKeys, rows, locale, locale === "zh-CN" ? "人" : "invites");
  }

  if (action === "invite_7d_stats") {
    const stats = await getInviteStatsSummary(chatId, sevenDayKeys);
    return inviteStatsSummaryText(stats, sevenDayKeys, locale);
  }

  if (action === "member_today") {
    const stats = await getMemberStatsSummary(chatId, todayKeys);
    return memberStatsSummaryText(stats, todayKeys, locale, false);
  }

  if (action === "member_7d") {
    const stats = await getMemberStatsSummary(chatId, sevenDayKeys);
    return memberStatsSummaryText(stats, sevenDayKeys, locale, true);
  }

  return locale === "zh-CN" ? "未知的统计类型。" : "Unknown stats view.";
}

async function getMessageRanking(chatId: string, dateKeys: string[]) {
  const rows = await prisma.chatDailyMessageStat.findMany({
    where: { chatId, statDate: { in: dateKeys } },
    select: { userId: true, messageCount: true }
  });
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.userId, (counts.get(row.userId) ?? 0) + row.messageCount);
  }
  return hydrateUserCounts(counts);
}

async function getMessageStatsSummary(chatId: string, dateKeys: string[]) {
  const rows = await prisma.chatDailyMessageStat.findMany({
    where: { chatId, statDate: { in: dateKeys } },
    select: { userId: true, messageCount: true }
  });
  return {
    total: rows.reduce((sum, row) => sum + row.messageCount, 0),
    users: new Set(rows.map((row) => row.userId)).size
  };
}

async function getInviteRanking(chatId: string, dateKeys: string[]) {
  const range = dateKeysToUtcRange(dateKeys);
  const rows = await prisma.inviteJoin.findMany({
    where: {
      chatId,
      inviteLinkId: { not: null },
      joinedAt: { gte: range.start, lt: range.end }
    },
    select: {
      inviteLink: {
        select: { creatorUserId: true }
      }
    }
  });
  const counts = new Map<string, number>();
  for (const row of rows) {
    const creatorUserId = row.inviteLink?.creatorUserId;
    if (creatorUserId) counts.set(creatorUserId, (counts.get(creatorUserId) ?? 0) + 1);
  }
  return hydrateUserCounts(counts);
}

async function getInviteStatsSummary(chatId: string, dateKeys: string[]) {
  const range = dateKeysToUtcRange(dateKeys);
  const rows = await prisma.inviteJoin.findMany({
    where: {
      chatId,
      inviteLinkId: { not: null },
      joinedAt: { gte: range.start, lt: range.end }
    },
    select: {
      inviteLinkId: true,
      inviteLink: {
        select: { creatorUserId: true }
      }
    }
  });
  return {
    total: rows.length,
    inviters: new Set(rows.map((row) => row.inviteLink?.creatorUserId).filter(Boolean)).size,
    links: new Set(rows.map((row) => row.inviteLinkId).filter(Boolean)).size
  };
}

async function getMemberStatsSummary(chatId: string, dateKeys: string[]) {
  const rows = await prisma.chatStatsEvent.findMany({
    where: {
      chatId,
      statDate: { in: dateKeys },
      eventType: { in: [ChatStatsEventType.JOIN, ChatStatsEventType.LEAVE] }
    },
    select: { statDate: true, eventType: true }
  });
  const byDate = new Map<string, { joins: number; leaves: number }>();
  for (const dateKey of dateKeys) byDate.set(dateKey, { joins: 0, leaves: 0 });
  for (const row of rows) {
    const item = byDate.get(row.statDate) ?? { joins: 0, leaves: 0 };
    if (row.eventType === ChatStatsEventType.JOIN) item.joins += 1;
    if (row.eventType === ChatStatsEventType.LEAVE) item.leaves += 1;
    byDate.set(row.statDate, item);
  }
  const days = [...byDate.entries()].map(([date, value]) => ({ date, ...value }));
  return {
    joins: days.reduce((sum, row) => sum + row.joins, 0),
    leaves: days.reduce((sum, row) => sum + row.leaves, 0),
    days
  };
}

async function hydrateUserCounts(counts: Map<string, number>) {
  const rows = [...counts.entries()]
    .map(([userId, count]) => ({ userId, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  const users = await prisma.user.findMany({
    where: { id: { in: rows.map((row) => row.userId) } }
  });
  const usersById = new Map(users.map((user) => [user.id, user]));
  return rows.map((row) => ({
    ...row,
    user: usersById.get(row.userId)
  }));
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

function memberStatsText(settings: MemberStatsSettings, locale: Locale) {
  if (locale !== "zh-CN") {
    return [
      `Daily member count stats: ${settings.enabled ? "✅" : "❌"}`,
      "",
      "🔔 Tip: when enabled, the bot records the chat member count once per day for member trend charts."
    ].join("\n");
  }

  return [
    `是否统计每日人数统计: ${settings.enabled ? "✅" : "❌"}`,
    "",
    "🔔提示：开启后，机器人每日统计群组人数，用于生成人数趋势统计图"
  ].join("\n");
}

function groupMembersText(settings: GroupMembersSettings, locale: Locale) {
  if (locale !== "zh-CN") {
    return [
      "👥 <b>Group & members</b>",
      "",
      `<b>Watch nickname changes:</b> ${settings.watchNicknameChange ? "On✅" : "Off❌"}`,
      `<b>Watch username changes:</b> ${settings.watchUsernameChange ? "On✅" : "Off❌"}`,
      `<b>Unpin linked channel messages:</b> ${settings.unpinLinkedChannelMessages ? "On✅" : "Off❌"}`
    ].join("\n");
  }

  return [
    "👥 <b>群组&成员</b>",
    "",
    `<b>监听昵称变更:</b> ${settings.watchNicknameChange ? "✅开启" : "❌关闭"}`,
    `<b>监听用户名变更:</b> ${settings.watchUsernameChange ? "✅开启" : "❌关闭"}`,
    `<b>取消绑定频道消息置顶:</b> ${settings.unpinLinkedChannelMessages ? "✅开启" : "❌关闭"}`
  ].join("\n");
}

function groupStatsHomeText(chat: PrismaChat, locale: Locale) {
  const title = escapeHtml(chat.title ?? chat.username ?? String(chat.telegramChatId));
  return locale === "zh-CN"
    ? `📊 <b>[ ${title} ]</b>群组统计`
    : `📊 <b>[ ${title} ]</b> Group stats`;
}

function rankingText(
  title: string,
  dateKeys: string[],
  rows: Awaited<ReturnType<typeof hydrateUserCounts>>,
  locale: Locale,
  unit: string
) {
  const lines = rows.length
    ? rows.map((row, index) => {
        const name = row.user ? escapeHtml(displayPrismaUser(row.user)) : escapeHtml(row.userId);
        return `${index + 1}. ${name} - ${row.count} ${unit}`;
      })
    : [locale === "zh-CN" ? "暂无数据。" : "No data yet."];

  return [
    `<b>${escapeHtml(title)}</b>`,
    `${locale === "zh-CN" ? "范围" : "Range"}: ${dateRangeLabel(dateKeys)}`,
    "",
    ...lines
  ].join("\n");
}

function messageStatsSummaryText(summary: { total: number; users: number }, dateKeys: string[], locale: Locale) {
  const average = dateKeys.length ? Math.round(summary.total / dateKeys.length) : 0;
  return locale === "zh-CN"
    ? [
        "<b>7日发言统计</b>",
        `范围: ${dateRangeLabel(dateKeys)}`,
        "",
        `总发言: ${summary.total} 条`,
        `发言人数: ${summary.users} 人`,
        `日均发言: ${average} 条`
      ].join("\n")
    : [
        "<b>7-day message stats</b>",
        `Range: ${dateRangeLabel(dateKeys)}`,
        "",
        `Messages: ${summary.total}`,
        `Active users: ${summary.users}`,
        `Daily average: ${average}`
      ].join("\n");
}

function inviteStatsSummaryText(summary: { total: number; inviters: number; links: number }, dateKeys: string[], locale: Locale) {
  return locale === "zh-CN"
    ? [
        "<b>7日邀请统计</b>",
        `范围: ${dateRangeLabel(dateKeys)}`,
        "",
        `总邀请: ${summary.total} 人`,
        `参与邀请人数: ${summary.inviters} 人`,
        `涉及邀请链接: ${summary.links} 条`
      ].join("\n")
    : [
        "<b>7-day invite stats</b>",
        `Range: ${dateRangeLabel(dateKeys)}`,
        "",
        `Invites: ${summary.total}`,
        `Inviters: ${summary.inviters}`,
        `Invite links: ${summary.links}`
      ].join("\n");
}

function memberStatsSummaryText(
  summary: { joins: number; leaves: number; days: Array<{ date: string; joins: number; leaves: number }> },
  dateKeys: string[],
  locale: Locale,
  includeDailyRows: boolean
) {
  const totalLines = locale === "zh-CN"
    ? [
        `<b>${includeDailyRows ? "7日进退群统计" : "今日进退群数据"}</b>`,
        `范围: ${dateRangeLabel(dateKeys)}`,
        "",
        `进群: ${summary.joins} 人`,
        `退群: ${summary.leaves} 人`,
        `净增长: ${summary.joins - summary.leaves} 人`
      ]
    : [
        `<b>${includeDailyRows ? "7-day join/leave stats" : "Today join/leave data"}</b>`,
        `Range: ${dateRangeLabel(dateKeys)}`,
        "",
        `Joins: ${summary.joins}`,
        `Leaves: ${summary.leaves}`,
        `Net: ${summary.joins - summary.leaves}`
      ];

  if (!includeDailyRows) return totalLines.join("\n");

  const dailyLines = summary.days.map((row) =>
    locale === "zh-CN"
      ? `${row.date}: 进 ${row.joins} / 退 ${row.leaves} / 净 ${row.joins - row.leaves}`
      : `${row.date}: +${row.joins} / -${row.leaves} / net ${row.joins - row.leaves}`
  );
  return [...totalLines, "", ...dailyLines].join("\n");
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
      `Bots: ${blocklistBotPunishmentLabel(settings.blockBotPunishment, locale)}`,
      `Ban after leave: ${onOff(settings.banAfterLeave)}`,
      `Flash join/leave: ${onOff(settings.blockFlashJoinLeave)} (${settings.flashWindowSeconds}s)`,
      `Join raid: ${onOff(settings.blockFollowerRaid)} (${settings.raidJoinThreshold}/${settings.raidWindowSeconds}s)`
    ].join("\n");
  }

  return [
    "<b>🚫👤 屏蔽</b>",
    `屏蔽机器人：${blocklistBotPunishmentLabel(settings.blockBotPunishment, locale)}`,
    `退群封禁：${onOffZh(settings.banAfterLeave)}`,
    `屏蔽闪进闪退：${onOffZh(settings.blockFlashJoinLeave)}（${settings.flashWindowSeconds} 秒内退群）`,
    `屏蔽刷粉攻击：${onOffZh(settings.blockFollowerRaid)}（${settings.raidWindowSeconds} 秒 ${settings.raidJoinThreshold} 人）`
  ].join("\n");
}

function blocklistBotText(settings: BlocklistSettings, locale: Locale) {
  return locale === "zh-CN"
    ? [
        "🤖 <b>屏蔽机器人</b>",
        "",
        "你也可以设置 处罚 把机器人添加进群组的用户",
        "",
        `<b>处罚:</b> ${blocklistBotPunishmentLabel(settings.blockBotPunishment, locale)}`
      ].join("\n")
    : [
        "🤖 <b>Block bots</b>",
        "",
        "You can also punish the user who adds a bot to the group.",
        "",
        `<b>Punishment:</b> ${blocklistBotPunishmentLabel(settings.blockBotPunishment, locale)}`
      ].join("\n");
}

function blocklistLeaveText(settings: BlocklistSettings, locale: Locale) {
  return locale === "zh-CN"
    ? [
        "🚪 <b>退群封禁</b>",
        "",
        "封禁离开群组(频道)的用户。",
        "",
        `<b>状态:</b> ${onOffZh(settings.banAfterLeave)}`
      ].join("\n")
    : [
        "🚪 <b>Ban leavers</b>",
        "",
        "Ban users who leave the group or channel.",
        "",
        `<b>Status:</b> ${onOff(settings.banAfterLeave)}`
      ].join("\n");
}

function blocklistFlashText(locale: Locale) {
  return locale === "zh-CN"
    ? [
        "🏃‍♂️ <b>屏蔽闪进闪退</b>",
        "",
        "如果用户加入群组(频道)几秒钟内离开，服务消息和欢迎消息将被删除。",
        "您还可以对此类用户设置惩罚",
        "<strong>该功能开通会员可用</strong>"
      ].join("\n")
    : [
        "🏃‍♂️ <b>Block flash join/leave</b>",
        "",
        "If a user leaves a group or channel seconds after joining, service and welcome messages are deleted.",
        "You can also set punishment for these users.",
        "<strong>This feature requires a membership.</strong>"
      ].join("\n");
}

function blocklistRaidText(locale: Locale) {
  return locale === "zh-CN"
    ? [
        "👨‍👩‍👧‍👦 <b>屏蔽刷粉攻击</b>",
        "",
        "如果在 2 秒内有 4 个用户加入该群组(频道)，则给予惩罚。",
        "",
        "状态: <strong>该功能开通会员可用</strong>"
      ].join("\n")
    : [
        "👨‍👩‍👧‍👦 <b>Block join raids</b>",
        "",
        "If 4 users join the group or channel within 2 seconds, a punishment is applied.",
        "",
        "Status: <strong>This feature requires a membership.</strong>"
      ].join("\n");
}

function blocklistBotPunishmentLabel(punishment: BlocklistBotPunishment, locale: Locale) {
  if (locale === "zh-CN") {
    if (punishment === "off") return "关闭";
    if (punishment === "warn") return "警告";
    if (punishment === "mute") return "禁言";
    if (punishment === "kick") return "踢出";
    return "封禁";
  }
  if (punishment === "off") return "Off";
  if (punishment === "warn") return "Warn";
  if (punishment === "mute") return "Mute";
  if (punishment === "kick") return "Kick";
  return "Ban";
}

function welcomeText(settings: WelcomeSettings, locale: Locale) {
  const hasMedia = Boolean(settings.mediaKind && settings.mediaFileId);
  const hasButton = Boolean(settings.buttons?.length || settings.replyKeyboard?.length || (settings.buttonText && settings.buttonUrl));
  const hasText = Boolean(settings.text.trim());
  if (locale !== "zh-CN") {
    return [
      "<b>🎉 Welcome</b>",
      "",
      `<b>Status</b>: ${settings.enabled ? "On✅" : "Off❌"}`,
      `<b>Delete message (minutes)</b>: ${settings.deleteAfterMinutes || "No"}`,
      "",
      "<b>Custom welcome content</b>:",
      ` ┌🖼 Media: ${hasMedia ? "✅" : "❌"}`,
      ` ├🔗 Link button: ${hasButton ? "✅" : "❌"}`,
      ` └📃 Text content: ${hasText ? "✅" : "❌"}`
    ].join("\n");
  }

  return [
    "<b>🎉 进群欢迎</b>",
    "",
    `<b>状态</b>: ${settings.enabled ? "开启✅" : "关闭❌"}`,
    `<b>删除消息(分钟)</b>: ${settings.deleteAfterMinutes || "否"}`,
    "",
    "<b>自定义欢迎内容</b>:",
    ` ┌🖼 媒体图片: ${hasMedia ? "✅" : "❌"}`,
    ` ├🔗 链接按钮: ${hasButton ? "✅" : "❌"}`,
    ` └📃 文本内容: ${hasText ? "✅" : "❌"}`
  ].join("\n");
}

function welcomeInputPromptText(field: WelcomeInputField, settings: WelcomeSettings, locale: Locale) {
  if (field === "media") {
    return locale === "zh-CN"
      ? "请回复图片、视频、贴图、动画表情进行设置"
      : "Send a photo, video, GIF, or sticker as the welcome media.";
  }

  if (field === "button") {
    return scheduledButtonPromptText(locale);
  }

  return locale === "zh-CN"
    ? [
        "👉 <strong>现在输入文本设置你的欢迎内容</strong>",
        "",
        '支持 💡HTML( <a href="tg://bot_command?command=html">/html</a> ) 和文字字体格式(加粗、链接、剧透、块引用等)及以下变量:',
        "<code>{NAME}</code> • 用户名",
        "<code>{MENTION}</code> • 用户名和链接",
        "<code>{GROUPNAME}</code> • 群组名"
      ].join("\n")
    : [
        "Send the welcome text. Available variables:",
        "<code>{name}</code> <code>{username}</code> <code>{chat}</code>",
        "",
        `Current text:\n${escapeHtml(settings.text || "-")}`
      ].join("\n");
}

function welcomeInputSavedText(locale: Locale) {
  return locale === "zh-CN" ? "✅ 设置成功，点击按钮返回。" : "✅ Saved. Tap the button to return.";
}

function isWelcomeInputField(value: string | undefined): value is WelcomeInputField {
  return value === "text" || value === "media" || value === "button";
}

function clearWelcomeField(settings: WelcomeSettings, field: WelcomeInputField) {
  if (field === "text") {
    settings.text = "";
    return;
  }
  if (field === "media") {
    settings.mediaKind = undefined;
    settings.mediaFileId = undefined;
    return;
  }
  settings.buttonText = "";
  settings.buttonUrl = "";
  settings.buttons = undefined;
  settings.replyKeyboard = undefined;
}

function joinVerifyText(settings: JoinVerifySettings, locale: Locale) {
  if (locale !== "zh-CN") {
    return [
      "<b>🤖 Join verification</b>",
      "",
      "New members must complete verification before they can send messages.",
      "",
      `<b>Status</b>: ${settings.enabled ? "On✅" : "Off❌"}`,
      `<b>Verification time</b>: ${settings.durationMinutes} minute${settings.durationMinutes === 1 ? "" : "s"}`,
      `<b>Timeout penalty</b>: ${settings.punishment === "mute" ? "Mute 24h" : settings.punishment === "kick" ? "Kick" : "Ban"}`,
      "",
      "<b>⚠️ Admin approval</b>",
      "For public groups, enable join requests in group settings.",
      "For private groups, create a new invite link with admin approval enabled.",
      "The default private invite link does not trigger verification."
    ].join("\n");
  }

  return [
    "<b>🤖 进群验证</b>",
    "",
    "启用后，新用户需要完成验证，才能发送消息。",
    "",
    `<b>状态</b>：${settings.enabled ? "开启✅" : "关闭❌"}`,
    `<b>验证时间</b>：${settings.durationMinutes} 分钟`,
    `<b>超时惩罚</b>：${settings.punishment === "mute" ? "禁言24小时" : settings.punishment === "kick" ? "踢出" : "封禁"}`,
    "",
    "<b>⚠️ 注意事项：</b>",
    "若启用了 <b>【管理员审批】</b>，请确保进行以下设置：",
    "",
    "<b>• 公共群组</b>：在群组设置中启用“新成员审核”；",
    "<b>• 私有群组</b>：请使用 <u>新建的邀请链接</u>，并启用“管理员审批”。",
    "    私有群组默认的邀请链接 <b>不会触发验证流程</b>！"
  ].join("\n");
}

function autoDeleteText(settings: AutoDeleteSettings, locale: Locale) {
  const labels = autoDeleteLabels(locale);
  const status = (enabled: boolean) => locale === "zh-CN"
    ? `${enabled ? "开启✅" : "关闭❌"}`
    : `${enabled ? "On ✅" : "Off ❌"}`;

  if (locale === "zh-CN") {
    return [
      "🧹 <b>自动删除</b>",
      "",
      "帮助您自动清理群组中的系统消息",
      "",
      `<b>${labels.join}</b> ${status(settings.join)}`,
      `<b>${labels.leave}</b> ${status(settings.leave)}`,
      `<b>${labels.boost}</b> ${status(settings.boost)}`,
      `<b>${labels.pin}</b> ${status(settings.pin)}`,
      `<b>${labels.photo}</b> ${status(settings.photo)}`,
      `<b>${labels.title}</b> ${status(settings.title)}`
    ].join("\n");
  }

  return [
    "🧹 <b>Auto delete</b>",
    "",
    "Automatically cleans service messages in this group.",
    "",
    `<b>${labels.join}</b> ${status(settings.join)}`,
    `<b>${labels.leave}</b> ${status(settings.leave)}`,
    `<b>${labels.boost}</b> ${status(settings.boost)}`,
    `<b>${labels.pin}</b> ${status(settings.pin)}`,
    `<b>${labels.photo}</b> ${status(settings.photo)}`,
    `<b>${labels.title}</b> ${status(settings.title)}`
  ].join("\n");
}

function autoReplyText(settings: AutoReplySettings, locale: Locale, botUsername: string) {
  const username = encodeURIComponent(botUsername.replace(/^@/, ""));
  const commandHelpUrl = `https://t.me/${username}?start=_CommandHelp`;
  const rules = settings.rules.length
    ? settings.rules.map((rule) => `${rule.matchType === "exact" ? "-" : "*"} ${escapeHtml(rule.keyword)}`)
    : [locale === "zh-CN" ? "[空]" : "[None]"];

  if (locale !== "zh-CN") {
    return [
      `💬 Keyword replies  [<a href="${commandHelpUrl}">❔Command help</a>]`,
      "",
      "<strong>Added keywords:</strong>",
      ...rules,
      "- exact match",
      "* contains match"
    ].join("\n");
  }

  return [
    `💬 关键词回复  [<a href="${commandHelpUrl}">❔命令帮助</a>]`,
    "",
    "<strong>已添加的关键词:</strong>",
    ...rules,
    "- 表示精准触发",
    " * 表示包含触发"
  ].join("\n");
}

function bannedWordsText(settings: BannedWordsSettings, count: number, locale: Locale) {
  if (locale !== "zh-CN") {
    return [
      "🔇 <b>Banned words</b>",
      "",
      `<b>Status</b>: ${settings.enabled ? "On✅" : "Off❌"}`,
      `<b>Punishment</b>: ${bannedWordsPunishmentLabel(settings, locale)}`,
      `<b>Words</b>: ${count}`,
      `<b>Notice deletion</b>: ${bannedWordsNoticeDeleteLabel(settings.noticeDeleteSeconds, locale)}`
    ].join("\n");
  }

  return [
    "🔇 <b>违禁词</b>",
    "",
    `<b>状态</b>: ${settings.enabled ? "开启✅" : "关闭❌"}`,
    `<b>惩罚</b>: ${bannedWordsPunishmentLabel(settings, locale)}`,
    `<b>词库</b>: ${count} 个`,
    `<b>提醒删除</b>: ${bannedWordsNoticeDeleteLabel(settings.noticeDeleteSeconds, locale)}`
  ].join("\n");
}

function bannedWordsPunishmentText(settings: BannedWordsSettings, locale: Locale) {
  return locale === "zh-CN"
    ? [
        "🔇 <b>违禁词</b>",
        "",
        `惩罚：${bannedWordsPunishmentLabel(settings, locale)}`
      ].join("\n")
    : [
        "🔇 <b>Banned words</b>",
        "",
        `Punishment: ${bannedWordsPunishmentLabel(settings, locale)}`
      ].join("\n");
}

function bannedWordsMuteDurationPromptText(settings: BannedWordsSettings, locale: Locale) {
  const duration = bannedWordsMuteDurationLabel(settings.muteMinutes, locale);
  return locale === "zh-CN"
    ? [
        "🔇 违禁词",
        "",
        `当前设置: 禁言${duration}`,
        "",
        "👉 输入处罚禁言的时长 如 <strong>60</strong> 单位/分钟:"
      ].join("\n")
    : [
        "🔇 Banned words",
        "",
        `Current setting: mute ${duration}`,
        "",
        "👉 Send the mute duration in minutes, for example <strong>60</strong>:"
      ].join("\n");
}

function bannedWordsNoticeText(locale: Locale) {
  return locale === "zh-CN"
    ? [
        "🔇 <strong>违禁词</strong>",
        "",
        "群成员触发 🔇 违禁词时，机器人发出的提醒消息在多久时间后自动删除"
      ].join("\n")
    : [
        "🔇 <strong>Banned words</strong>",
        "",
        "Choose how long bot warning notices stay after a member triggers a banned word."
      ].join("\n");
}

async function bannedWordsListText(chatId: string, locale: Locale) {
  const rules = await listBannedWordRules(chatId, 100);
  if (!rules.length) {
    return locale === "zh-CN" ? "📋 <b>违禁词列表</b>\n\n[空]" : "📋 <b>Banned words</b>\n\n[None]";
  }

  const lines = rules.map((rule, index) => `${index + 1}. ${escapeHtml(rule.pattern)}`);
  return locale === "zh-CN"
    ? ["📋 <b>违禁词列表</b>", "", ...lines].join("\n")
    : ["📋 <b>Banned words</b>", "", ...lines].join("\n");
}

function bannedWordsAddPromptText(locale: Locale) {
  return locale === "zh-CN"
    ? [
        "👉 <strong>请发送要添加的违禁词</strong>",
        "",
        "支持一次发送多个词，每行一个，或用逗号分隔。"
      ].join("\n")
    : [
        "👉 <strong>Send banned words to add</strong>",
        "",
        "You can send multiple words, one per line, or separate them with commas."
      ].join("\n");
}

async function bannedWordsDeletePromptText(chatId: string, locale: Locale) {
  const rules = await listBannedWordRules(chatId, 100);
  const lines = rules.length
    ? rules.map((rule) => `<code>${escapeHtml(rule.pattern)}</code>`)
    : [locale === "zh-CN" ? "[空]" : "[None]"];

  return locale === "zh-CN"
    ? [
        "请输入要删除的违禁词，可一次发送多个：",
        "",
        "<strong>已添加的违禁词:</strong>",
        ...lines
      ].join("\n")
    : [
        "Send banned words to delete. Multiple words are supported:",
        "",
        "<strong>Added banned words:</strong>",
        ...lines
      ].join("\n");
}

function bannedWordsSavedText(count: number, locale: Locale) {
  return locale === "zh-CN"
    ? `✅ 已添加 ${count} 个违禁词，点击按钮返回。`
    : `✅ Added ${count} banned word(s). Tap the button to return.`;
}

function bannedWordsDeletedText(count: number, locale: Locale) {
  return locale === "zh-CN"
    ? `✅ 已删除 ${count} 个违禁词，点击按钮返回。`
    : `✅ Deleted ${count} banned word(s). Tap the button to return.`;
}

function bannedWordsPunishmentLabel(settings: BannedWordsSettings, locale: Locale) {
  if (locale === "zh-CN") {
    if (settings.punishment === "warn") return `警告${settings.warningLimit}次后${bannedWordsFinalPunishmentLabel(settings.warningPunishment, settings, locale)}`;
    if (settings.punishment === "mute") return `禁言${bannedWordsMuteDurationLabel(settings.muteMinutes, locale)}`;
    if (settings.punishment === "kick") return "踢出";
    if (settings.punishment === "ban") return "踢出+封禁";
    return "仅删除消息";
  }

  if (settings.punishment === "warn") return `${settings.warningLimit} warnings, then ${bannedWordsFinalPunishmentLabel(settings.warningPunishment, settings, locale)}`;
  if (settings.punishment === "mute") return `Mute ${bannedWordsMuteDurationLabel(settings.muteMinutes, locale)}`;
  if (settings.punishment === "kick") return "Kick";
  if (settings.punishment === "ban") return "Kick+ban";
  return "Delete message only";
}

function bannedWordsFinalPunishmentLabel(punishment: BannedWordsFinalPunishment, settings: BannedWordsSettings, locale: Locale) {
  if (locale === "zh-CN") {
    if (punishment === "mute") return `禁言${bannedWordsMuteDurationLabel(settings.muteMinutes, locale)}`;
    if (punishment === "kick") return "踢出";
    return "踢出+封禁";
  }
  if (punishment === "mute") return `mute ${bannedWordsMuteDurationLabel(settings.muteMinutes, locale)}`;
  if (punishment === "kick") return "kick";
  return "kick+ban";
}

function bannedWordsFinalPunishmentNoticeLabel(punishment: BannedWordsFinalPunishment, settings: BannedWordsSettings, locale: Locale) {
  if (locale === "zh-CN") {
    if (punishment === "mute") return `禁言 ${bannedWordsMuteDurationLabel(settings.muteMinutes, locale)}`;
    if (punishment === "kick") return "踢出";
    return "封禁";
  }
  return bannedWordsFinalPunishmentLabel(punishment, settings, locale);
}

function bannedWordsMuteDurationLabel(minutes: number, locale: Locale) {
  if (minutes <= 0) return locale === "zh-CN" ? "永久" : "permanently";
  return locale === "zh-CN" ? `${minutes}分钟` : `${minutes}m`;
}

function bannedWordsNoticeDeleteLabel(seconds: number, locale: Locale) {
  if (seconds < 0) return locale === "zh-CN" ? "不提醒" : "Do not notify";
  if (seconds === 0) return locale === "zh-CN" ? "不删除" : "Do not delete";
  if (seconds < 60) return locale === "zh-CN" ? `${seconds}秒` : `${seconds}s`;
  if (seconds % 3600 === 0) return locale === "zh-CN" ? `${seconds / 3600}小时` : `${seconds / 3600}h`;
  if (seconds % 60 === 0) return locale === "zh-CN" ? `${seconds / 60}分钟` : `${seconds / 60}m`;
  return locale === "zh-CN" ? `${seconds}秒` : `${seconds}s`;
}

function bannedWordsNoticeStatusLabel(settings: BannedWordsSettings, label: string) {
  if (settings.noticeDeleteSeconds < 0) return label;
  return `✅${label}`;
}

function groupCommandsHomeText(locale: Locale) {
  return locale === "zh-CN" ? "请选择设置类型：" : "Choose a setting type:";
}

function groupCommandsText(settings: GroupCommandSettings, locale: Locale) {
  const lines = groupCommandDefinitions.map((item) => {
    const status = settings.commands[item.key]
      ? (locale === "zh-CN" ? "开启" : "On")
      : (locale === "zh-CN" ? "关闭" : "Off");
    return `${item.command} - ${groupCommandLabel(item.key, locale)}: ${status}`;
  });

  return locale === "zh-CN"
    ? ["<b>群组命令</b>", "", "关闭后，群内成员将无法使用对应命令。", "", ...lines].join("\n")
    : ["<b>Group commands</b>", "", "When disabled, members cannot use the matching command in this group.", "", ...lines].join("\n");
}

function groupCommandAliasesText(settings: GroupCommandSettings, locale: Locale) {
  const lines = groupCommandDefinitions.map((item) => {
    const aliases = settings.aliases[item.key];
    return `${groupCommandLabel(item.key, locale)}: ${aliases.length ? aliases.map((alias) => `<code>${escapeHtml(alias)}</code>`).join(" ") : "-"}`;
  });
  return locale === "zh-CN"
    ? ["<b>命令别名</b>", "", "成员发送别名时，会按对应群组命令执行。", "", ...lines].join("\n")
    : ["<b>Command aliases</b>", "", "When members send an alias, the matching group command runs.", "", ...lines].join("\n");
}

function groupCommandAliasDetailText(settings: GroupCommandSettings, command: GroupCommandKey, locale: Locale) {
  const aliases = settings.aliases[command];
  const lines = aliases.length ? aliases.map((alias) => `- <code>${escapeHtml(alias)}</code>`) : [locale === "zh-CN" ? "暂无别名。" : "No aliases yet."];
  return locale === "zh-CN"
    ? [`<b>${groupCommandLabel(command, locale)} 别名</b>`, "", ...lines].join("\n")
    : [`<b>${groupCommandLabel(command, locale)} aliases</b>`, "", ...lines].join("\n");
}

function groupCommandAliasInputPromptText(mode: "add" | "delete", command: GroupCommandKey, locale: Locale) {
  const name = groupCommandLabel(command, locale);
  if (locale === "zh-CN") {
    return mode === "add"
      ? [`<b>添加 ${name} 别名</b>`, "", "请发送别名，多个别名可用换行或逗号分隔。", "示例: <code>签到, qd, /qd</code>"].join("\n")
      : [`<b>删除 ${name} 别名</b>`, "", "请发送要删除的别名，多个别名可用换行或逗号分隔。"].join("\n");
  }
  return mode === "add"
    ? [`<b>Add aliases for ${name}</b>`, "", "Send aliases separated by new lines or commas.", "Example: <code>checkin, qd, /qd</code>"].join("\n")
    : [`<b>Delete aliases for ${name}</b>`, "", "Send aliases to delete, separated by new lines or commas."].join("\n");
}

function groupCommandAliasSavedText(count: number, mode: "add" | "delete", locale: Locale) {
  if (locale === "zh-CN") return mode === "add" ? `已添加 ${count} 个别名。` : `已删除 ${count} 个别名。`;
  return mode === "add" ? `Added ${count} alias(es).` : `Deleted ${count} alias(es).`;
}

function pointAliasInputText(aliases: string[], command: Extract<GroupCommandKey, "points" | "points_rank">, locale: Locale) {
  const current = aliases.length ? aliases.join(", ") : (command === "points_rank" ? "积分排名" : "积分");
  const title = command === "points_rank" ? (locale === "zh-CN" ? "积分排名" : "Points ranking") : (locale === "zh-CN" ? "积分" : "Points");
  return locale === "zh-CN"
    ? [`Ⓜ️ <b>${title}</b>`, "", `当前设置: <code>${escapeHtml(current)}</code>`, "", "👉 输入内容进行设置:"].join("\n")
    : [`Ⓜ️ <b>${title}</b>`, "", `Current setting: <code>${escapeHtml(current)}</code>`, "", "👉 Send the new alias:"].join("\n");
}

function pointAliasSavedText(locale: Locale) {
  return locale === "zh-CN" ? "别名已更新。" : "Alias updated.";
}

function pointExchangeText(settings: PointExchangeSettings, locale: Locale) {
  return locale === "zh-CN"
    ? ["🛒<b>商品兑换</b>", "", `<b>状态:</b> ${settings.enabled ? "开启" : "关闭"}`, "", `兑换关键词: ${escapeHtml(settings.keyword)}`].join("\n")
    : ["🛒<b>Product exchange</b>", "", `<b>Status:</b> ${settings.enabled ? "On" : "Off"}`, "", `Exchange keyword: ${escapeHtml(settings.keyword)}`].join("\n");
}

function exchangeKeywordInputText(locale: Locale) {
  return locale === "zh-CN"
    ? ["群成员输入关键词后，机器人会在群里发送商品列表", "", "<b>请输入兑换关键词:</b>"].join("\n")
    : ["When members send the keyword, the bot sends the product list in the group.", "", "<b>Send the exchange keyword:</b>"].join("\n");
}

function productsText(locale: Locale) {
  return locale === "zh-CN" ? "<b>🎁商品管理</b>" : "<b>🎁 Product management</b>";
}

function productText(product: PointProduct, locale: Locale) {
  const stock = product.codes.length;
  if (locale !== "zh-CN") {
    return [
      `<b>Product ID:</b> ${escapeHtml(product.id)}`,
      `<b>Product name:</b> ${escapeHtml(product.name)}`,
      `<b>Point cost:</b> ${product.cost}`,
      `<b>Remaining:</b> ${stock}`,
      `<b>Total exchanged:</b> ${product.soldCount}`,
      `<b>Daily exchange limit:</b> ${formatPointsLimit(product.dailyLimit, locale)}`
    ].join("\n");
  }
  return [
    `<b>商品编号：</b> ${escapeHtml(product.id)}`,
    `<b>商品名称：</b> ${escapeHtml(product.name)}`,
    `<b>消耗积分：</b> ${product.cost}`,
    `<b>剩余：</b> ${stock}`,
    `<b>累计兑换：</b> ${product.soldCount}`,
    `<b>每日兑换上限：</b> ${formatPointsLimit(product.dailyLimit, locale)}`
  ].join("\n");
}

function productInputPromptText(kind: Extract<PointsInputDraft, { productId: string }>["kind"], locale: Locale) {
  if (kind === "product_name") return locale === "zh-CN" ? "请输入商品名称:" : "Send the product name:";
  if (kind === "product_cost") return locale === "zh-CN" ? "请输入消耗积分:" : "Send the point cost:";
  if (kind === "product_codes") return locale === "zh-CN" ? "请输入卡密，每行一个:" : "Send codes, one per line:";
  return locale === "zh-CN" ? "请输入每日兑换上限，0 表示无限制:" : "Send the daily exchange limit. Use 0 for unlimited:";
}

function pointProductInputKind(value: string): Extract<PointsInputDraft, { productId: string }>["kind"] | null {
  if (value === "name") return "product_name";
  if (value === "cost") return "product_cost";
  if (value === "codes") return "product_codes";
  if (value === "daily_limit") return "product_daily_limit";
  return null;
}

function pointProductCodesText(product: PointProduct | undefined, locale: Locale) {
  if (!product) return locale === "zh-CN" ? "找不到商品。" : "Product not found.";
  const codes = product.codes.length ? product.codes.map((code) => `<code>${escapeHtml(code)}</code>`) : [locale === "zh-CN" ? "暂无卡密。" : "No codes."];
  return [locale === "zh-CN" ? "<b>查看卡密</b>" : "<b>Codes</b>", "", ...codes].join("\n");
}

function parsePointProductCodes(text: string) {
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const item of text.split(/[\r\n]+/)) {
    const code = item.trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    codes.push(code.slice(0, 255));
  }
  return codes.slice(0, 10000);
}

async function pointExchangeRecordsText(chatId: string, locale: Locale) {
  const rows = await prisma.chatPointTransaction.findMany({
    where: { chatId, type: PointTransactionType.EXCHANGE },
    include: { user: true },
    orderBy: { createdAt: "desc" },
    take: 20
  });
  const lines = rows.length
    ? rows.map((row) => `${formatDateTimeForDisplay(row.createdAt)} ${displayPrismaUser(row.user)} ${row.delta}`)
    : [locale === "zh-CN" ? "暂无兑换记录。" : "No exchange records yet."];
  return [locale === "zh-CN" ? "<b>🧾兑换记录</b>" : "<b>🧾 Exchange records</b>", "", ...lines].join("\n");
}

function pointsInputInvalidText(locale: Locale) {
  return locale === "zh-CN" ? "请输入有效内容。" : "Send a valid value.";
}

function pointAdjustAmountPromptText(user: PrismaUser, locale: Locale) {
  const name = escapeHtml(displayPrismaUser(user));
  return locale === "zh-CN"
    ? [`当前用户: <b>${name}</b>`, "", "请输入增减积分数量，例如 <code>10</code> 或 <code>-10</code>:"].join("\n")
    : [`Current user: <b>${name}</b>`, "", "Send the point delta, for example <code>10</code> or <code>-10</code>:"].join("\n");
}

function pointsPanelText(settings: PointsSettings, locale: Locale) {
  if (locale !== "zh-CN") {
    return [
      "<b>Ⓜ️ Points</b>",
      "",
      "Set points gained from daily sign-in, messages and invites. Points can be spent by giveaways or adjusted manually by admins.",
      "",
      `<b>Status:</b>${settings.enabled ? "✅On" : "❌Off"}`,
      `<b>Delete sign-in reply:</b>${settings.deleteSignInMessage ? "✅On" : "❌Off"} (${settings.deleteSignInSeconds}s after)`,
      "<b>Sign-in rule:</b>",
      `└ Send <code>/sign_in</code>, daily sign-in earns: ${settings.signInPoints} point(s)`,
      "",
      "<blockquote>After the optimized alias flow, set trigger words for <code>/sign_in</code> under <b>Group commands - Command aliases</b>. The system no longer forces the built-in sign-in keyword.</blockquote>",
      "",
      "<b>Speech rule:</b>",
      `└ 1 message earns: ${settings.speechPoints} point(s)`,
      `└ Daily earning limit: ${formatPointsLimit(settings.speechDailyLimit, locale)} point(s)`,
      `└ Minimum text length: ${settings.speechMinLength}`,
      "<b>Invite rule:</b>",
      `└ 1 invite earns: ${settings.invitePoints} point(s)`,
      `└ Daily earning limit: ${formatPointsLimit(settings.inviteDailyLimit, locale)} point(s)`,
      "Points alias:",
      "└ Send <code>points</code> or <code>积分</code> in group to check your points",
      "Ranking alias:",
      "└ Send <code>points ranking</code> or <code>积分排名</code> in group to check ranking"
    ].join("\n");
  }

  return [
    "<b>Ⓜ️ 积分</b>",
    "",
    "设置群成员签到或发言获得积分，消耗积分抽奖或管理员手动扣除积分。",
    "",
    `<b>状态:</b>${settings.enabled ? "✅开启" : "❌关闭"}`,
    `<b>删除签到信息:</b>${settings.deleteSignInMessage ? "✅开启" : "❌关闭"} (${settings.deleteSignInSeconds}s后删除)`,
    "<b>签到规则:</b>",
    `└ 发送 <code>/sign_in</code>，每日签到获得:${settings.signInPoints} 积分`,
    "",
    "<blockquote>新版优化后，请手动在 <b>群组命令-命令别名</b> 中，设置命令 <code>/sign_in</code> 的签到触发词别名。\n\n系统不再强制用户使用系统自带的 <b>签到</b> 关键词</blockquote>",
    "",
    "<b>发言规则:</b>",
    `└ 发言1次，获得: ${settings.speechPoints} 积分`,
    `└ 每日获取上限:${formatPointsLimit(settings.speechDailyLimit, locale)} 积分`,
    `└ 最小字数长度限制: ${settings.speechMinLength}`,
    "<b>邀请规则:</b>",
    `└ 邀请1人，获得: ${settings.invitePoints} 积分`,
    `└ 每日获取上限: ${formatPointsLimit(settings.inviteDailyLimit, locale)} 积分`,
    "积分别名:",
    "└ 群组中发送“<code>积分</code>”查询自己的积分",
    "排名别名：",
    "└ 群组中发送“<code>积分排名</code>”查询积分排名"
  ].join("\n");
}

function pointsRuleText(settings: PointsSettings, rule: "sign" | "speech" | "invite", locale: Locale) {
  if (rule === "sign") {
    return locale === "zh-CN"
      ? ["<b>⚙️ 签到规则</b>", "", `每日签到积分: ${settings.signInPoints}`, `签到信息删除延迟: ${settings.deleteSignInSeconds}s`].join("\n")
      : ["<b>⚙️ Sign-in rule</b>", "", `Daily sign-in points: ${settings.signInPoints}`, `Sign-in reply delete delay: ${settings.deleteSignInSeconds}s`].join("\n");
  }
  if (rule === "speech") {
    return locale === "zh-CN"
      ? ["<b>⚙️ 发言规则</b>", "", `发言1次获得: ${settings.speechPoints} 积分`, `每日获取上限: ${formatPointsLimit(settings.speechDailyLimit, locale)} 积分`, `最小字数长度限制: ${settings.speechMinLength}`].join("\n")
      : ["<b>⚙️ Speech rule</b>", "", `1 message earns: ${settings.speechPoints} point(s)`, `Daily earning limit: ${formatPointsLimit(settings.speechDailyLimit, locale)} point(s)`, `Minimum text length: ${settings.speechMinLength}`].join("\n");
  }
  return locale === "zh-CN"
    ? ["<b>⚙️ 邀请规则</b>", "", `邀请1人获得: ${settings.invitePoints} 积分`, `每日获取上限: ${formatPointsLimit(settings.inviteDailyLimit, locale)} 积分`].join("\n")
    : ["<b>⚙️ Invite rule</b>", "", `1 invite earns: ${settings.invitePoints} point(s)`, `Daily earning limit: ${formatPointsLimit(settings.inviteDailyLimit, locale)} point(s)`].join("\n");
}

function formatPointsLimit(value: number, locale: Locale) {
  if (value <= 0) return locale === "zh-CN" ? "无限制" : "Unlimited";
  return String(value);
}

function groupCommandLabel(key: GroupCommandKey, locale: Locale) {
  const item = groupCommandDefinitions.find((definition) => definition.key === key);
  if (!item) return key;
  return locale === "zh-CN" ? item.zh : item.en;
}

function autoReplyDeleteText(settings: AutoReplySettings, locale: Locale) {
  const lines = settings.rules.map((rule, index) => `${index + 1}. ${rule.matchType === "exact" ? "-" : "*"} ${escapeHtml(rule.keyword)}`);
  return locale === "zh-CN"
    ? ["🗑 <b>删除关键词</b>", "", "选择要删除的关键词：", ...lines].join("\n")
    : ["🗑 <b>Delete keyword</b>", "", "Choose a keyword to delete:", ...lines].join("\n");
}

function autoReplyDeletePromptText(settings: AutoReplySettings, locale: Locale) {
  const rules = settings.rules.length
    ? settings.rules.map((rule) => `<code>${escapeHtml(rule.keyword)}</code>`)
    : [locale === "zh-CN" ? "[空]" : "[None]"];

  return locale === "zh-CN"
    ? [
        "请输入要删除的关键词，一次只能删除一个，回复关键词名:",
        "",
        "<strong>已添加的关键词:</strong>",
        ...rules
      ].join("\n")
    : [
        "Send the keyword name to delete. Only one keyword can be deleted at a time:",
        "",
        "<strong>Added keywords:</strong>",
        ...rules
      ].join("\n");
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
        "👉 第一步 请输入关键词:"
      ].join("\n")
    : [
        "💬 Keyword replies",
        "",
        "<strong>Added keywords:</strong>",
        ...rules,
        "",
        "👉 Step 1: Send a keyword:"
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

function autoReplyTriggerPromptText(locale: Locale) {
  return locale === "zh-CN"
    ? [
        "💬 关键词回复",
        "",
        "👉 最后，请选择回复触发方式:"
      ].join("\n")
    : [
        "💬 Keyword replies",
        "",
        "👉 Finally, choose how this reply is triggered:"
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

function parseBannedWordsInput(input: string) {
  return input
    .split(/[\n,，;；]+/)
    .map(normalizeBannedWord)
    .filter(Boolean)
    .map((word) => word.slice(0, 128));
}

function uniqueBannedWords(words: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const word of words.map(normalizeBannedWord).filter(Boolean)) {
    const key = normalizeBannedWordForMatch(word);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(word.slice(0, 128));
  }
  return result;
}

function normalizeBannedWord(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeBannedWordForMatch(value: string) {
  return normalizeBannedWord(value).toLocaleLowerCase();
}

function isBannedWordsPunishment(value: unknown): value is BannedWordsPunishment {
  return value === "warn" || value === "mute" || value === "kick" || value === "ban" || value === "delete_only";
}

function parseBannedWordsPunishment(value: unknown): BannedWordsPunishment {
  if (value === "warn_mute") return "warn";
  return isBannedWordsPunishment(value) ? value : defaultBannedWordsSettings.punishment;
}

function isBannedWordsFinalPunishment(value: unknown): value is BannedWordsFinalPunishment {
  return value === "mute" || value === "kick" || value === "ban";
}

function isBlocklistBotPunishment(value: unknown): value is BlocklistBotPunishment {
  return value === "off" || value === "warn" || value === "mute" || value === "kick" || value === "ban";
}

function userChatKey(chatId: string, userId: number) {
  return `${chatId}:${userId}`;
}

function verificationKey(chatId: number, userId: number) {
  return `${chatId}:${userId}`;
}

function joinVerificationRecordId(chatId: string, userId: number) {
  return `${chatId}:${userId}`;
}

function isJoinVerifyPunishment(value: unknown): value is JoinVerifySettings["punishment"] {
  return value === "mute" || value === "kick" || value === "ban";
}

function isGroupLike(chat: Chat) {
  return chat.type === "group" || chat.type === "supergroup";
}

function displayName(user: User) {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return escapeHtml(fullName || user.username || String(user.id));
}

function buildUserProfileChange(previous: StoredUserProfile, current: StoredUserProfile): UserProfileChange {
  return {
    previous,
    current,
    nicknameChanged: profileNickname(previous) !== profileNickname(current),
    usernameChanged: normalizeUsername(previous.username) !== normalizeUsername(current.username)
  };
}

function profileNickname(user: StoredUserProfile) {
  return [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
}

function normalizeUsername(username: string | null) {
  return (username ?? "").trim().toLocaleLowerCase();
}

function formatProfileField(value: string | null | undefined, locale: Locale) {
  const fallback = locale === "zh-CN" ? "无" : "None";
  return escapeHtml((value ?? "").trim() || fallback);
}

function linkedChannelPinnedMessage(message: Message) {
  const pinned = "pinned_message" in message ? message.pinned_message : undefined;
  if (!pinned) return false;
  const anyMessage = pinned as Message & {
    is_automatic_forward?: boolean;
    sender_chat?: Chat;
    forward_origin?: { type?: string; chat?: Chat };
    forward_from_chat?: Chat;
  };
  return Boolean(
    anyMessage.is_automatic_forward
    || anyMessage.sender_chat?.type === "channel"
    || anyMessage.forward_origin?.type === "channel"
    || anyMessage.forward_origin?.chat?.type === "channel"
    || anyMessage.forward_from_chat?.type === "channel"
  );
}

async function maybeNotifyMemberProfileChange(ctx: Context, chat: PrismaChat, user: User, settings: GroupMembersSettings) {
  const change = userProfileChanges.get(user.id);
  if (!change) return;
  userProfileChanges.delete(user.id);

  const changedNickname = settings.watchNicknameChange && change.nicknameChanged;
  const changedUsername = settings.watchUsernameChange && change.usernameChanged;
  if (!changedNickname && !changedUsername) return;

  const locale = await getLocale(ctx);
  const link = `<a href="tg://user?id=${user.id}">${displayName(user)}</a>`;
  const lines = locale === "zh-CN"
    ? ["👥 <b>成员资料变更</b>", "", `用户：${link}`]
    : ["👥 <b>Member profile changed</b>", "", `User: ${link}`];

  if (changedNickname) {
    lines.push(
      locale === "zh-CN"
        ? `昵称：${formatProfileField(profileNickname(change.previous), locale)} -> ${formatProfileField(profileNickname(change.current), locale)}`
        : `Nickname: ${formatProfileField(profileNickname(change.previous), locale)} -> ${formatProfileField(profileNickname(change.current), locale)}`
    );
  }

  if (changedUsername) {
    lines.push(
      locale === "zh-CN"
        ? `用户名：${formatProfileField(change.previous.username ? `@${change.previous.username}` : "", locale)} -> ${formatProfileField(change.current.username ? `@${change.current.username}` : "", locale)}`
        : `Username: ${formatProfileField(change.previous.username ? `@${change.previous.username}` : "", locale)} -> ${formatProfileField(change.current.username ? `@${change.current.username}` : "", locale)}`
    );
  }

  await ctx.api.sendMessage(Number(chat.telegramChatId), lines.join("\n"), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true }
  }).catch(() => undefined);
}

async function maybeUnpinLinkedChannelMessage(ctx: Context, message: Message) {
  if (!linkedChannelPinnedMessage(message) || !ctx.chat) return;

  const pinned = "pinned_message" in message ? message.pinned_message : undefined;
  if (!pinned) return;

  await ctx.api.unpinChatMessage(ctx.chat.id, pinned.message_id).catch(() => undefined);
  await ctx.api.deleteMessage(ctx.chat.id, message.message_id).catch(() => undefined);
}

function displayPrismaUser(user: PrismaUser) {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || String(user.telegramUserId);
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function recentDateKeys(days: number, end = new Date()) {
  const count = Math.max(1, Math.round(days));
  const endDate = new Date(`${formatDate(end)}T00:00:00.000Z`);
  const keys: string[] = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    const item = new Date(endDate);
    item.setUTCDate(item.getUTCDate() - index);
    keys.push(formatDate(item));
  }
  return keys;
}

function currentMonthDateKeys(end = new Date()) {
  const today = new Date(`${formatDate(end)}T00:00:00.000Z`);
  const current = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const keys: string[] = [];
  while (current <= today) {
    keys.push(formatDate(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return keys;
}

function dateKeysToUtcRange(dateKeys: string[]) {
  const sorted = [...dateKeys].sort();
  const first = sorted[0] ?? formatDate(new Date());
  const last = sorted[sorted.length - 1] ?? first;
  const start = new Date(`${first}T00:00:00.000Z`);
  const end = new Date(`${last}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

function dateRangeLabel(dateKeys: string[]) {
  const sorted = [...dateKeys].sort();
  const first = sorted[0] ?? "-";
  const last = sorted[sorted.length - 1] ?? first;
  return first === last ? first : `${first} ~ ${last}`;
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

