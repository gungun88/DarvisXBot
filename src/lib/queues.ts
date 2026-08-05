import { Queue } from "bullmq";
import { redis } from "./redis.js";

export const scheduledMessagesQueue = new Queue("scheduled-messages", {
  connection: redis
});

export const giveawayDrawQueue = new Queue("giveaway-draws", {
  connection: redis
});

export const membershipExpiryQueue = new Queue("membership-expiry", {
  connection: redis
});

export const signInMessageDeleteQueue = new Queue("sign-in-message-deletes", {
  connection: redis
});

export async function closeQueues() {
  await Promise.all([
    scheduledMessagesQueue.close(),
    giveawayDrawQueue.close(),
    membershipExpiryQueue.close(),
    signInMessageDeleteQueue.close()
  ]);
}
