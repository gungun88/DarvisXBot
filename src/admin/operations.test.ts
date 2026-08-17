import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getBackupStatus } from "../operations/backup-status.js";
import { getRestoreStatus, writeRestoreVerification } from "../operations/restore-status.js";

test("backup status distinguishes disabled, healthy, and stale backups", async (t) => {
  assert.equal((await getBackupStatus(undefined, 26)).status, "disabled");

  const directory = await mkdtemp(path.join(tmpdir(), "darvisx-backup-test-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  assert.equal((await getBackupStatus(directory, 26)).status, "missing");

  const backup = path.join(directory, "darvisxbot_test.dump");
  await writeFile(backup, "test");
  assert.equal((await getBackupStatus(directory, 26)).status, "healthy");

  const old = new Date(Date.now() - 48 * 3_600_000);
  await utimes(backup, old, old);
  assert.equal((await getBackupStatus(directory, 26)).status, "stale");
});

test("restore status tracks missing, healthy, stale, and failed drills", async (t) => {
  assert.equal((await getRestoreStatus(undefined, 168)).status, "disabled");
  const directory = await mkdtemp(path.join(tmpdir(), "darvisx-restore-test-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  assert.equal((await getRestoreStatus(directory, 168)).status, "missing");

  const completedAt = new Date("2026-08-17T00:00:00.000Z");
  await writeRestoreVerification(directory, {
    status: "healthy",
    attemptedAt: completedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    backupFile: "darvisxbot_test.dump",
    detail: "完整恢复成功"
  });
  assert.equal((await getRestoreStatus(directory, 168, completedAt.getTime() + 24 * 3_600_000)).status, "healthy");
  assert.equal((await getRestoreStatus(directory, 168, completedAt.getTime() + 200 * 3_600_000)).status, "stale");

  await writeRestoreVerification(directory, {
    status: "failed",
    attemptedAt: completedAt.toISOString(),
    completedAt: null,
    backupFile: "darvisxbot_test.dump",
    detail: "恢复失败"
  });
  assert.equal((await getRestoreStatus(directory, 168)).status, "failed");
});
