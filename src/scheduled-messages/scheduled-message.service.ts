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
  cron?: string;
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
  if (typeof value.cron === "string" && parseCronExpression(value.cron)) rule.cron = value.cron;

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
    cron: rule.cron,
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
  let candidate = rule.cron
    ? nextCronRun(rule.cron, from)
    : new Date(from.getTime() + clampIntervalMinutes(rule.intervalMinutes) * 60 * 1000);
  if (!candidate) return null;

  if (rule.startAt) {
    const startAt = parseDateTime(rule.startAt);
    if (startAt && candidate < startAt) {
      candidate = rule.cron ? nextCronRun(rule.cron, new Date(startAt.getTime() - 60 * 1000)) : startAt;
      if (!candidate) return null;
    }
  }

  const endAt = rule.endAt ? parseDateTime(rule.endAt) : null;
  if (endAt && candidate > endAt) return null;

  if (rule.timeStart && rule.timeEnd) {
    candidate = moveIntoTimeWindow(candidate, rule.timeStart, rule.timeEnd);
    if (endAt && candidate > endAt) return null;
  }

  return candidate;
}

export function isValidCronExpression(value: string) {
  return Boolean(parseCronExpression(value));
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

type CronRule = {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
};

function nextCronRun(expression: string, from: Date) {
  const cron = parseCronExpression(expression);
  if (!cron) return null;

  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxChecks = 366 * 24 * 60;
  for (let index = 0; index < maxChecks; index += 1) {
    if (
      cron.minutes.has(candidate.getMinutes())
      && cron.hours.has(candidate.getHours())
      && cron.days.has(candidate.getDate())
      && cron.months.has(candidate.getMonth() + 1)
      && cron.weekdays.has(candidate.getDay())
    ) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}

function parseCronExpression(expression: string): CronRule | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minutePart, hourPart, dayPart, monthPart, weekdayPart] = parts;
  if (!minutePart || !hourPart || !dayPart || !monthPart || !weekdayPart) return null;

  const minutes = parseCronPart(minutePart, 0, 59);
  const hours = parseCronPart(hourPart, 0, 23);
  const days = parseCronPart(dayPart, 1, 31);
  const months = parseCronPart(monthPart, 1, 12);
  const weekdays = parseCronPart(weekdayPart, 0, 6);

  if (!minutes || !hours || !days || !months || !weekdays) return null;
  return { minutes, hours, days, months, weekdays };
}

function parseCronPart(part: string, min: number, max: number) {
  const values = new Set<number>();
  for (const segment of part.split(",")) {
    const parsed = parseCronSegment(segment.trim(), min, max);
    if (!parsed) return null;
    parsed.forEach((value) => values.add(value));
  }
  return values.size ? values : null;
}

function parseCronSegment(segment: string, min: number, max: number) {
  if (!segment) return null;
  const [rangeText, stepText] = segment.split("/");
  const step = stepText ? Number(stepText) : 1;
  if (!Number.isSafeInteger(step) || step <= 0) return null;

  let start = min;
  let end = max;

  if (rangeText && rangeText !== "*") {
    const range = rangeText.split("-");
    if (range.length === 1) {
      start = Number(range[0]);
      end = Number(range[0]);
    } else if (range.length === 2) {
      start = Number(range[0]);
      end = Number(range[1]);
    } else {
      return null;
    }
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < min || end > max || start > end) {
    return null;
  }

  const values = [];
  for (let value = start; value <= end; value += step) values.push(value);
  return values;
}

export { ScheduledMessageStatus };
