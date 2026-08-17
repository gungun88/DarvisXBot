import { spawn } from "node:child_process";

export function postgresToolUrl(databaseUrl: string, databaseName?: string) {
  const parsed = new URL(databaseUrl);
  parsed.searchParams.delete("schema");
  if (databaseName) parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

export function runPostgresTool(command: string, args: string[], captureOutput = false) {
  return new Promise<string>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn(command, args, {
      stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true
    });
    if (captureOutput) {
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    }
    child.once("error", (error) => reject(new Error(`无法启动 ${command}: ${error.message}`)));
    child.once("exit", (code) => {
      if (code === 0) return resolve(Buffer.concat(stdout).toString("utf8"));
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(`${command} 退出码 ${code ?? "unknown"}${detail ? `: ${detail.slice(0, 500)}` : ""}`));
    });
  });
}
