import type { Queue } from "bullmq";
import type { AppConfig } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";
import { giveawayDrawQueue, scheduledMessagesQueue, signInMessageDeleteQueue } from "../lib/queues.js";
import { redis } from "../lib/redis.js";
import { getBackupStatus } from "./backup-status.js";
import { getRestoreStatus } from "./restore-status.js";

let lastAlertAt = 0;
let lastAlertSentAt: Date | null = null;
let lastAlertError: string | null = null;

export async function getOperationsHealth(config: AppConfig, notify = false) {
  const checkedAt = new Date();
  const database = await check("PostgreSQL", async () => {
    await prisma.$queryRaw`SELECT 1`;
    return "查询正常";
  });
  const redisCheck = await check("Redis", async () => {
    const pong = await redis.ping();
    return pong === "PONG" ? "连接正常" : pong;
  });
  const queues = await Promise.all([
    queueStatus("定时消息", scheduledMessagesQueue),
    queueStatus("抽奖开奖", giveawayDrawQueue),
    queueStatus("签到消息清理", signInMessageDeleteQueue)
  ]);
  const backup = await getBackupStatus(config.backupDir, config.backupMaxAgeHours);
  const restore = await getRestoreStatus(config.backupDir, config.restoreMaxAgeHours);
  const coreHealthy = database.status === "healthy" && redisCheck.status === "healthy" && queues.every((item) => item.status === "healthy");
  const backupHealthy = backup.status === "healthy" || backup.status === "disabled";
  const restoreHealthy = restore.status === "healthy" || restore.status === "disabled";
  const status = coreHealthy && backupHealthy && restoreHealthy ? "healthy" : "degraded";
  if (notify && status === "degraded") await sendAlert(config, { database, redis: redisCheck, queues, backup, restore }).catch(() => undefined);
  return {
    status,
    checkedAt,
    dependencies: [database, redisCheck],
    queues,
    backup,
    restore,
    alerts: {
      configured: Boolean(config.alertWebhookUrl),
      cooldownMinutes: config.alertCooldownMinutes,
      lastSentAt: lastAlertSentAt,
      lastError: lastAlertError
    }
  };
}

export function startOperationsMonitor(config: AppConfig) {
  const run = () => { void getOperationsHealth(config, true).catch((error) => console.error("Operations monitor failed", error)); };
  run();
  const timer = setInterval(run, 5 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

async function queueStatus(name: string, queue: Queue) {
  try {
    const counts = await queue.getJobCounts("active", "waiting", "delayed", "completed", "failed");
    return { name, status: "healthy" as const, counts };
  } catch (error) {
    return { name, status: "unhealthy" as const, error: error instanceof Error ? error.message : "读取失败", counts: {} };
  }
}

async function check(name: string, run: () => Promise<string>) {
  const startedAt = Date.now();
  try {
    return { name, status: "healthy" as const, detail: await run(), latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { name, status: "unhealthy" as const, detail: error instanceof Error ? error.message : "检查失败", latencyMs: Date.now() - startedAt };
  }
}

async function sendAlert(config: AppConfig, details: unknown) {
  if (!config.alertWebhookUrl) return;
  const cooldownMs = config.alertCooldownMinutes * 60_000;
  if (Date.now() - lastAlertAt < cooldownMs) return;
  lastAlertAt = Date.now();
  const message = `DarvisXBot operations degraded at ${new Date().toISOString()}`;
  try {
    const response = await fetch(config.alertWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: message, content: message, details })
    });
    if (!response.ok) throw new Error(`告警 webhook 返回 ${response.status}`);
    lastAlertSentAt = new Date();
    lastAlertError = null;
  } catch (error) {
    lastAlertError = error instanceof Error ? error.message : "发送告警失败";
    throw error;
  }
}
