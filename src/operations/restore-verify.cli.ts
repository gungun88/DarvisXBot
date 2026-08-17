import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../lib/config.js";
import { postgresToolUrl, runPostgresTool } from "./postgres-tools.js";
import { writeRestoreVerification } from "./restore-status.js";

const config = loadConfig();
if (!config.backupDir) throw new Error("BACKUP_DIR 未配置");

const directory = path.resolve(config.backupDir);
const backup = await latestBackup(directory);
if (!backup) throw new Error("没有可用于恢复演练的数据库备份");

const databaseName = `darvisx_restore_${Date.now()}_${randomBytes(3).toString("hex")}`;
const maintenanceUrl = postgresToolUrl(config.databaseUrl, "postgres");
const restoreUrl = postgresToolUrl(config.databaseUrl, databaseName);
const attemptedAt = new Date();
let databaseCreated = false;
let failure: Error | null = null;
let migrationCount = 0;

try {
  await runPostgresTool("psql", ["--dbname", maintenanceUrl, "--set", "ON_ERROR_STOP=1", "--command", `CREATE DATABASE "${databaseName}"`], true);
  databaseCreated = true;
  await runPostgresTool("pg_restore", ["--no-owner", "--no-privileges", "--exit-on-error", "--dbname", restoreUrl, backup.file], true);
  const output = await runPostgresTool("psql", [
    "--dbname", restoreUrl,
    "--set", "ON_ERROR_STOP=1",
    "--tuples-only",
    "--no-align",
    "--field-separator", "|",
    "--command",
    "SELECT COUNT(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL), COUNT(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) FROM \"_prisma_migrations\""
  ], true);
  const [appliedCount, failedCount] = output.trim().split("|").map((value) => Number.parseInt(value, 10));
  migrationCount = appliedCount ?? 0;
  if (!Number.isInteger(migrationCount) || migrationCount < 1) throw new Error("恢复后的数据库缺少已应用的 Prisma 迁移记录");
  if (!Number.isInteger(failedCount) || failedCount !== 0) throw new Error(`恢复后的数据库存在 ${failedCount ?? "未知数量"} 条未解决的失败迁移`);
} catch (error) {
  failure = error instanceof Error ? error : new Error("恢复演练失败");
}

if (databaseCreated) {
  try {
    await runPostgresTool("psql", ["--dbname", maintenanceUrl, "--set", "ON_ERROR_STOP=1", "--command", `DROP DATABASE "${databaseName}" WITH (FORCE)`], true);
  } catch (error) {
    failure ??= error instanceof Error ? error : new Error("恢复演练临时数据库清理失败");
  }
}

const completedAt = failure ? null : new Date();
await writeRestoreVerification(directory, {
  status: failure ? "failed" : "healthy",
  attemptedAt: attemptedAt.toISOString(),
  completedAt: completedAt?.toISOString() ?? null,
  backupFile: path.basename(backup.file),
  detail: failure ? failure.message.slice(0, 500) : `完整恢复成功，检测到 ${migrationCount} 条 Prisma 迁移记录`
});

if (failure) throw failure;
console.info(`Database restore verification passed: ${path.basename(backup.file)}`);

async function latestBackup(backupDirectory: string) {
  const names = (await readdir(backupDirectory)).filter((name) => name.endsWith(".dump"));
  const entries = await Promise.all(names.map(async (name) => {
    const file = path.join(backupDirectory, name);
    return { file, modifiedAt: (await stat(file)).mtimeMs };
  }));
  entries.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return entries[0];
}
