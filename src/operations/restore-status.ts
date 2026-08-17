import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const restoreStatusFile = ".restore-verification.json";

export type RestoreVerificationRecord = {
  status: "healthy" | "failed";
  attemptedAt: string;
  completedAt: string | null;
  backupFile: string;
  detail: string;
};

export type RestoreStatus = {
  status: "healthy" | "stale" | "missing" | "failed" | "disabled";
  backupFile: string | null;
  lastAttemptAt: Date | null;
  lastVerifiedAt: Date | null;
  ageHours: number | null;
  detail: string;
};

export async function getRestoreStatus(directory: string | undefined, maxAgeHours: number, now = Date.now()): Promise<RestoreStatus> {
  if (!directory) return emptyStatus("disabled", "未配置备份目录");
  try {
    const raw = await readFile(path.join(path.resolve(directory), restoreStatusFile), "utf8");
    const record = parseRecord(JSON.parse(raw));
    if (!record) return emptyStatus("failed", "恢复验证状态文件无效");
    const attemptedAt = new Date(record.attemptedAt);
    const completedAt = record.completedAt ? new Date(record.completedAt) : null;
    if (!Number.isFinite(attemptedAt.getTime()) || (completedAt && !Number.isFinite(completedAt.getTime()))) {
      return emptyStatus("failed", "恢复验证时间无效");
    }
    if (record.status === "failed" || !completedAt) {
      return { status: "failed", backupFile: record.backupFile, lastAttemptAt: attemptedAt, lastVerifiedAt: null, ageHours: null, detail: record.detail };
    }
    const ageHours = Math.max(0, (now - completedAt.getTime()) / 3_600_000);
    const healthy = ageHours <= maxAgeHours;
    return {
      status: healthy ? "healthy" : "stale",
      backupFile: record.backupFile,
      lastAttemptAt: attemptedAt,
      lastVerifiedAt: completedAt,
      ageHours: Math.round(ageHours * 10) / 10,
      detail: healthy ? record.detail : `最近恢复演练已超过 ${maxAgeHours} 小时`
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return emptyStatus(code === "ENOENT" ? "missing" : "failed", code === "ENOENT" ? "尚未执行恢复演练" : (error instanceof Error ? error.message : "无法读取恢复验证状态"));
  }
}

export async function writeRestoreVerification(directory: string, record: RestoreVerificationRecord) {
  const resolved = path.resolve(directory);
  await mkdir(resolved, { recursive: true });
  const target = path.join(resolved, restoreStatusFile);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

function parseRecord(value: unknown): RestoreVerificationRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if ((record.status !== "healthy" && record.status !== "failed") || typeof record.attemptedAt !== "string" || (record.completedAt !== null && typeof record.completedAt !== "string") || typeof record.backupFile !== "string" || typeof record.detail !== "string") return null;
  return record as RestoreVerificationRecord;
}

function emptyStatus(status: RestoreStatus["status"], detail: string): RestoreStatus {
  return { status, backupFile: null, lastAttemptAt: null, lastVerifiedAt: null, ageHours: null, detail };
}
