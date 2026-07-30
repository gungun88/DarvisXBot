import { giveawayDrawQueue } from "../lib/queues.js";

export function giveawayDrawJobId(id: string) {
  return `giveaway-draw:${id}`;
}

export async function enqueueGiveawayDraw(id: string, drawAt: Date) {
  const jobId = giveawayDrawJobId(id);
  await giveawayDrawQueue.remove(jobId).catch(() => undefined);
  await giveawayDrawQueue.add(
    "draw",
    { giveawayId: id },
    {
      jobId,
      delay: Math.max(0, drawAt.getTime() - Date.now()),
      removeOnComplete: true,
      removeOnFail: 100
    }
  );
}

export async function cancelGiveawayDrawJob(id: string) {
  await giveawayDrawQueue.remove(giveawayDrawJobId(id)).catch(() => undefined);
}
