import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../lib/config.js";
import { postgresToolUrl, runPostgresTool } from "./postgres-tools.js";

const config = loadConfig();
if (!config.backupDir) throw new Error("BACKUP_DIR 未配置");

const directory = path.resolve(config.backupDir);
await mkdir(directory, { recursive: true });
const timestamp = new Date().toISOString().replaceAll(":", "-").replace("T", "_").replace("Z", "");
const output = path.join(directory, `darvisxbot_${timestamp}.dump`);

try {
  await runPostgresTool("pg_dump", ["--format=custom", "--no-owner", "--file", output, postgresToolUrl(config.databaseUrl)]);
  await runPostgresTool("pg_restore", ["--list", output], true);
} catch (error) {
  await unlink(output).catch(() => undefined);
  throw error;
}
await removeExpiredBackups(directory, config.backupRetentionDays);
console.info(`Database backup created: ${output}`);

async function removeExpiredBackups(backupDirectory: string, retentionDays: number) {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const files = (await readdir(backupDirectory)).filter((name) => name.endsWith(".dump"));
  await Promise.all(files.map(async (name) => {
    const file = path.join(backupDirectory, name);
    const info = await stat(file);
    if (info.mtimeMs < cutoff) await unlink(file);
  }));
}
