import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export type BackupStatus = {
  status: "healthy" | "stale" | "missing" | "disabled";
  directory: string | null;
  latestFile: string | null;
  latestAt: Date | null;
  ageHours: number | null;
  detail: string;
};

export async function getBackupStatus(directory: string | undefined, maxAgeHours: number): Promise<BackupStatus> {
  if (!directory) return { status: "disabled", directory: null, latestFile: null, latestAt: null, ageHours: null, detail: "未配置备份目录" };
  const resolved = path.resolve(directory);
  try {
    const files = (await readdir(resolved)).filter((name) => name.endsWith(".dump"));
    const entries = await Promise.all(files.map(async (name) => ({ name, stats: await stat(path.join(resolved, name)) })));
    entries.sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs);
    const latest = entries[0];
    if (!latest) return { status: "missing", directory: resolved, latestFile: null, latestAt: null, ageHours: null, detail: "尚未生成数据库备份" };
    const ageHours = Math.max(0, (Date.now() - latest.stats.mtimeMs) / 3_600_000);
    const healthy = ageHours <= maxAgeHours;
    return {
      status: healthy ? "healthy" : "stale",
      directory: resolved,
      latestFile: latest.name,
      latestAt: latest.stats.mtime,
      ageHours: Math.round(ageHours * 10) / 10,
      detail: healthy ? "最近备份在允许时限内" : `最近备份已超过 ${maxAgeHours} 小时`
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return {
      status: "missing",
      directory: resolved,
      latestFile: null,
      latestAt: null,
      ageHours: null,
      detail: code === "ENOENT" ? "备份目录不存在" : (error instanceof Error ? error.message : "无法读取备份目录")
    };
  }
}
