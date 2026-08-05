import { Bot } from "grammy";
import { Worker } from "bullmq";
import { GiveawayStatus, Prisma } from "@prisma/client";
import type { User } from "@prisma/client";
import type { AppConfig } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";
import { enqueueGiveawayDraw } from "./giveaway.service.js";

export function startGiveawayDrawWorker(config: AppConfig) {
  const bot = new Bot(config.botToken);

  return new Worker(
    "giveaway-draws",
    async (job) => {
      const giveawayId = String(job.data?.giveawayId ?? "");
      if (!giveawayId) return;

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
      if (giveaway.drawAt.getTime() > Date.now() + 1000) {
        await enqueueGiveawayDraw(giveaway.id, giveaway.drawAt);
        return;
      }

      const winners = await resolveGiveawayWinners(giveaway);
      const drawResult: Prisma.InputJsonObject = {
        drawnAt: new Date().toISOString(),
        entryCount: winners.entryCount,
        winnerCount: winners.length,
        winnerUserIds: winners.users.map((user) => user.id),
        winnerTelegramUserIds: winners.users.map((user) => user.telegramUserId.toString()),
        source: winners.source
      };

      await prisma.giveaway.update({
        where: { id: giveaway.id },
        data: {
          status: GiveawayStatus.DRAWN,
          drawResult
        }
      });

      await prisma.auditLog.create({
        data: {
          chatId: giveaway.chatId,
          action: "giveaway.drawn",
          targetType: "giveaway",
          targetId: giveaway.id,
          metadata: drawResult
        }
      });

      await bot.api.sendMessage(
        Number(giveaway.chat.telegramChatId),
        buildDrawMessage(giveaway.title, giveaway.prize, winners.users),
        { parse_mode: "HTML" }
      ).catch(() => undefined);
    },
    { connection: redis }
  );
}

export async function syncActiveGiveawayDrawJobs() {
  const giveaways = await prisma.giveaway.findMany({
    where: { status: GiveawayStatus.ACTIVE },
    select: { id: true, drawAt: true }
  });

  await Promise.all(giveaways.map((giveaway) => enqueueGiveawayDraw(giveaway.id, giveaway.drawAt)));
}

type WorkerGiveaway = NonNullable<Awaited<ReturnType<typeof prisma.giveaway.findUnique>>> & {
  entries: Array<{ userId: string; user: User }>;
};

type GiveawayRequirements =
  | { type: "common" | "points" | "report"; drawMode?: "full" | "timed" }
  | { type: "active"; mode: "ranking" | "speech_count"; days: number; minCount?: number }
  | { type: "invite"; mode: "ranking" | "count"; days: number; minCount?: number }
  | { type: "fun"; mode: "dice" | "dart" | "basketball" | "football" | "bowling" | "slot"; attempts: number };

async function resolveGiveawayWinners(giveaway: WorkerGiveaway) {
  const requirements = parseGiveawayRequirements(giveaway.joinRequirements);
  if (requirements?.type === "active") {
    const rows = await getActivityCandidates(giveaway.chatId, requirements);
    const selected = requirements.mode === "ranking" ? rows.slice(0, giveaway.winnersCount) : pickWinners(rows, giveaway.winnersCount);
    return { users: selected.map((row) => row.user), entryCount: rows.length, length: selected.length, source: `active:${requirements.mode}` };
  }
  if (requirements?.type === "invite") {
    const rows = await getInviteCandidates(giveaway.chatId, requirements);
    const selected = requirements.mode === "ranking" ? rows.slice(0, giveaway.winnersCount) : pickWinners(rows, giveaway.winnersCount);
    return { users: selected.map((row) => row.user), entryCount: rows.length, length: selected.length, source: `invite:${requirements.mode}` };
  }
  if (requirements?.type === "fun" && requirements.mode !== "slot") {
    const rows = await getFunCandidates(giveaway.id);
    const selected = rows.slice(0, giveaway.winnersCount);
    return { users: selected.map((row) => row.user), entryCount: rows.length, length: selected.length, source: `fun:${requirements.mode}` };
  }

  const selectedEntries = pickWinners(giveaway.entries, giveaway.winnersCount);
  return {
    users: selectedEntries.map((entry) => entry.user),
    entryCount: giveaway.entries.length,
    length: selectedEntries.length,
    source: requirements?.type ?? "entries"
  };
}

async function getActivityCandidates(
  chatId: string,
  requirements: Extract<GiveawayRequirements, { type: "active" }>
) {
  const dateKeys = recentDateKeys(requirements.days);
  const rows = await prisma.chatDailyMessageStat.findMany({
    where: { chatId, statDate: { in: dateKeys } },
    select: { userId: true, messageCount: true }
  });
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.userId, (counts.get(row.userId) ?? 0) + row.messageCount);
  const candidates = [...counts.entries()]
    .filter(([, count]) => requirements.mode === "ranking" || count >= (requirements.minCount ?? 1))
    .sort((a, b) => b[1] - a[1]);
  return hydrateCandidates(candidates);
}

async function getInviteCandidates(
  chatId: string,
  requirements: Extract<GiveawayRequirements, { type: "invite" }>
) {
  const range = dateKeysToUtcRange(recentDateKeys(requirements.days));
  const rows = await prisma.inviteJoin.findMany({
    where: {
      chatId,
      inviteLinkId: { not: null },
      joinedAt: { gte: range.start, lt: range.end }
    },
    select: {
      inviteLink: { select: { creatorUserId: true } }
    }
  });
  const counts = new Map<string, number>();
  for (const row of rows) {
    const userId = row.inviteLink?.creatorUserId;
    if (userId) counts.set(userId, (counts.get(userId) ?? 0) + 1);
  }
  const candidates = [...counts.entries()]
    .filter(([, count]) => requirements.mode === "ranking" || count >= (requirements.minCount ?? 1))
    .sort((a, b) => b[1] - a[1]);
  return hydrateCandidates(candidates);
}

async function getFunCandidates(giveawayId: string) {
  const logs = await prisma.auditLog.findMany({
    where: {
      action: "giveaway.fun_roll",
      targetType: "giveaway",
      targetId: giveawayId
    },
    select: { actorUserId: true, metadata: true, createdAt: true },
    orderBy: { createdAt: "asc" }
  });
  const best = new Map<string, { score: number; firstAt: Date }>();
  for (const log of logs) {
    if (!log.actorUserId || !isRecord(log.metadata)) continue;
    const score = Number(log.metadata.value);
    if (!Number.isFinite(score)) continue;
    const current = best.get(log.actorUserId);
    if (!current || score > current.score) best.set(log.actorUserId, { score, firstAt: log.createdAt });
  }
  const candidates = [...best.entries()].sort((a, b) => b[1].score - a[1].score || a[1].firstAt.getTime() - b[1].firstAt.getTime());
  return hydrateCandidates(candidates.map(([userId, value]) => [userId, value.score]));
}

async function hydrateCandidates(rows: Array<[string, number]>) {
  const users = await prisma.user.findMany({ where: { id: { in: rows.map(([userId]) => userId) } } });
  const byId = new Map(users.map((user) => [user.id, user]));
  return rows
    .map(([userId, count]) => ({ user: byId.get(userId), count }))
    .filter((row): row is { user: User; count: number } => Boolean(row.user));
}

function parseGiveawayRequirements(value: Prisma.JsonValue | null): GiveawayRequirements | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "common" || value.type === "points" || value.type === "report") {
    return { type: value.type };
  }
  if (value.type === "active" && (value.mode === "ranking" || value.mode === "speech_count")) {
    const days = Number(value.days);
    const minCount = Number(value.minCount);
    if (!Number.isSafeInteger(days) || days <= 0) return null;
    return { type: "active", mode: value.mode, days, ...(Number.isSafeInteger(minCount) && minCount > 0 ? { minCount } : {}) };
  }
  if (value.type === "invite" && (value.mode === "ranking" || value.mode === "count")) {
    const days = Number(value.days);
    const minCount = Number(value.minCount);
    if (!Number.isSafeInteger(days) || days <= 0) return null;
    return { type: "invite", mode: value.mode, days, ...(Number.isSafeInteger(minCount) && minCount > 0 ? { minCount } : {}) };
  }
  if (value.type === "fun" && typeof value.mode === "string") {
    const attempts = Number(value.attempts);
    if (!isFunGiveawayMode(value.mode) || !Number.isSafeInteger(attempts) || attempts <= 0) return null;
    return { type: "fun", mode: value.mode, attempts };
  }
  return null;
}

function isFunGiveawayMode(value: string): value is Extract<GiveawayRequirements, { type: "fun" }>["mode"] {
  return value === "dice"
    || value === "dart"
    || value === "basketball"
    || value === "football"
    || value === "bowling"
    || value === "slot";
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

function dateKeysToUtcRange(dateKeys: string[]) {
  const sorted = [...dateKeys].sort();
  const first = sorted[0] ?? formatDate(new Date());
  const last = sorted[sorted.length - 1] ?? first;
  const start = new Date(`${first}T00:00:00.000Z`);
  const end = new Date(`${last}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickWinners<T>(entries: T[], winnersCount: number) {
  const shuffled = [...entries];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled.slice(0, Math.max(0, Math.min(winnersCount, shuffled.length)));
}

function buildDrawMessage(title: string, prize: string, winners: User[]) {
  const header = [
    `🎁 <b>${escapeHtml(title)}</b>`,
    "",
    `奖品: <b>${escapeHtml(prize)}</b>`
  ];

  if (winners.length === 0) {
    return [...header, "", "本次抽奖没有有效参与者，已自动结束。"].join("\n");
  }

  return [
    ...header,
    "",
    "<b>中奖用户:</b>",
    ...winners.map((user, index) => `${index + 1}. ${mentionStoredUser(user)}`)
  ].join("\n");
}

function mentionStoredUser(user: User) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim()
    || user.username
    || user.telegramUserId.toString();
  return `<a href="tg://user?id=${user.telegramUserId.toString()}">${escapeHtml(name)}</a>`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
