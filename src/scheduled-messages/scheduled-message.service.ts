import { Prisma, ScheduledMessageStatus } from "@prisma/client";
import { scheduledMessagesQueue } from "../lib/queues.js";

export type ScheduledMessageContent = {
  name?: string;
  text?: string;
  photoFileId?: string;
  mediaKind?: ScheduledMediaKind;
  mediaFileId?: string;
  deletePrevious?: boolean;
  pin?: boolean;
  lastMessageId?: number;
  lastMessageIds?: number[];
};

export type ScheduledMediaKind = "photo" | "video" | "animation" | "sticker";

export type ScheduledRepeatRule = {
  intervalMinutes: number;
  startAt?: string;
  endAt?: string;
  timeStart?: string;
  timeEnd?: string;
};

export const defaultScheduledIntervalMinutes = 10;

export function defaultScheduledContent(): ScheduledMessageContent {
  return {
    deletePrevious: true,
    pin: false
  };
}

export function defaultScheduledRepeatRule(): ScheduledRepeatRule {
  return {
    intervalMinutes: defaultScheduledIntervalMinutes
  };
}

export function parseScheduledContent(value: Prisma.JsonValue): ScheduledMessageContent {
  if (!isRecord(value)) return defaultScheduledContent();

  const content: ScheduledMessageContent = {
    deletePrevious: typeof value.deletePrevious === "boolean" ? value.deletePrevious : true,
    pin: typeof value.pin === "boolean" ? value.pin : false
  };

  if (typeof value.name === "string") content.name = value.name;
  if (typeof value.text === "string") content.text = value.text;
  if (typeof value.photoFileId === "string") content.photoFileId = value.photoFileId;
  if (isScheduledMediaKind(value.mediaKind)) content.mediaKind = value.mediaKind;
  if (typeof value.mediaFileId === "string") content.mediaFileId = value.mediaFileId;
  if (!content.mediaFileId && content.photoFileId) {
    content.mediaKind = "photo";
    content.mediaFileId = content.photoFileId;
  }
  if (typeof value.lastMessageId === "number") content.lastMessageId = value.lastMessageId;
  if (Array.isArray(value.lastMessageIds)) {
    const ids = value.lastMessageIds.filter((item): item is number => typeof item === "number");
    if (ids.length) content.lastMessageIds = ids;
  }

  return content;
}

export function parseScheduledRepeatRule(value: Prisma.JsonValue | null): ScheduledRepeatRule {
  if (!isRecord(value)) return defaultScheduledRepeatRule();

  const intervalMinutes = typeof value.intervalMinutes === "number"
    ? value.intervalMinutes
    : defaultScheduledIntervalMinutes;

  const rule: ScheduledRepeatRule = {
    intervalMinutes: clampIntervalMinutes(intervalMinutes)
  };

  if (typeof value.startAt === "string") rule.startAt = value.startAt;
  if (typeof value.endAt === "string") rule.endAt = value.endAt;
  if (typeof value.timeStart === "string") rule.timeStart = value.timeStart;
  if (typeof value.timeEnd === "string") rule.timeEnd = value.timeEnd;

  return rule;
}

export function scheduledContentToJson(content: ScheduledMessageContent): Prisma.InputJsonObject {
  return cleanJsonObject({
    name: content.name,
    text: content.text,
    photoFileId: content.photoFileId,
    mediaKind: content.mediaKind,
    mediaFileId: content.mediaFileId,
    deletePrevious: content.deletePrevious ?? true,
    pin: content.pin ?? false,
    lastMessageId: content.lastMessageId,
    lastMessageIds: content.lastMessageIds
  });
}

export function scheduledRepeatRuleToJson(rule: ScheduledRepeatRule): Prisma.InputJsonObject {
  return cleanJsonObject({
    intervalMinutes: clampIntervalMinutes(rule.intervalMinutes),
    startAt: rule.startAt,
    endAt: rule.endAt,
    timeStart: rule.timeStart,
    timeEnd: rule.timeEnd
  });
}

export function clampIntervalMinutes(value: number) {
  if (!Number.isFinite(value)) return defaultScheduledIntervalMinutes;
  return Math.min(Math.max(Math.round(value), 1), 60 * 24 * 30);
}

export function hasScheduledMessageContent(content: ScheduledMessageContent) {
  return Boolean(content.text?.trim() || content.mediaFileId || content.photoFileId);
}

export function nextScheduledRun(rule: ScheduledRepeatRule, from = new Date()) {
  const intervalMs = clampIntervalMinutes(rule.intervalMinutes) * 60 * 1000;
  let candidate = new Date(from.getTime() + intervalMs);

  if (rule.startAt) {
    const startAt = parseDateTime(rule.startAt);
    if (startAt && candidate < startAt) candidate = startAt;
  }

  const endAt = rule.endAt ? parseDateTime(rule.endAt) : null;
  if (endAt && candidate > endAt) return null;

  if (rule.timeStart && rule.timeEnd) {
    candidate = moveIntoTimeWindow(candidate, rule.timeStart, rule.timeEnd);
    if (endAt && candidate > endAt) return null;
  }

  return candidate;
}

export async function enqueueScheduledMessage(id: string, sendAt: Date) {
  const jobId = scheduledMessageJobId(id);
  await scheduledMessagesQueue.remove(jobId).catch(() => undefined);
  await scheduledMessagesQueue.add(
    "send",
    { scheduledMessageId: id },
    {
      jobId,
      delay: Math.max(0, sendAt.getTime() - Date.now()),
      removeOnComplete: true,
      removeOnFail: 100
    }
  );
}

export async function cancelScheduledMessageJob(id: string) {
  await scheduledMessagesQueue.remove(scheduledMessageJobId(id)).catch(() => undefined);
}

export function scheduledMessageJobId(id: string) {
  return `scheduled-message:${id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScheduledMediaKind(value: unknown): value is ScheduledMediaKind {
  return value === "photo" || value === "video" || value === "animation" || value === "sticker";
}

function cleanJsonObject(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  ) as Prisma.InputJsonObject;
}

function parseDateTime(value: string) {
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function moveIntoTimeWindow(date: Date, start: string, end: string) {
  const startMinutes = parseClockMinutes(start);
  const endMinutes = parseClockMinutes(end);
  if (startMinutes === null || endMinutes === null) return date;

  const candidate = new Date(date);
  const currentMinutes = candidate.getHours() * 60 + candidate.getMinutes();
  const wrapsMidnight = startMinutes > endMinutes;
  const inside = wrapsMidnight
    ? currentMinutes >= startMinutes || currentMinutes <= endMinutes
    : currentMinutes >= startMinutes && currentMinutes <= endMinutes;

  if (inside) return candidate;

  if (!wrapsMidnight && currentMinutes > endMinutes) {
    candidate.setDate(candidate.getDate() + 1);
  }

  candidate.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);
  return candidate;
}

function parseClockMinutes(value: string) {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export { ScheduledMessageStatus };
