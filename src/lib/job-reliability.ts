export const DEFAULT_JOB_ATTEMPTS = 3;

type JobAttemptState = {
  attemptsMade: number;
  opts: { attempts?: number | undefined };
};

export function currentJobAttempt(job: JobAttemptState) {
  return job.attemptsMade + 1;
}

export function isFinalJobAttempt(job: JobAttemptState) {
  return currentJobAttempt(job) >= Math.max(1, job.opts.attempts ?? 1);
}

export function jobErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 4000) || "任务执行失败";
}
