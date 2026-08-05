import { signInMessageDeleteQueue } from "../lib/queues.js";

export async function enqueueSignInMessageDelete(chatId: number, messageId: number, seconds: number) {
  const jobId = signInMessageDeleteJobId(chatId, messageId);
  await signInMessageDeleteQueue.remove(jobId).catch(() => undefined);
  await signInMessageDeleteQueue.add(
    "delete",
    { chatId, messageId },
    {
      jobId,
      delay: Math.max(0, Math.round(seconds * 1000)),
      removeOnComplete: true,
      removeOnFail: 100
    }
  );
}

export function signInMessageDeleteJobId(chatId: number, messageId: number) {
  return `sign-in-delete:${chatId}:${messageId}`;
}
