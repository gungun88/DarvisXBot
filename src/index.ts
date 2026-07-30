import { loadConfig } from "./lib/config.js";
import { createBot, registerBotCommands } from "./telegram/bot.js";
import { startScheduledMessageWorker } from "./scheduled-messages/scheduled-message.worker.js";
import { startGiveawayDrawWorker, syncActiveGiveawayDrawJobs } from "./giveaways/giveaway.worker.js";

const config = loadConfig();
const scheduledMessageWorker = startScheduledMessageWorker(config);
const giveawayDrawWorker = startGiveawayDrawWorker(config);
await syncActiveGiveawayDrawJobs();

process.once("SIGINT", async () => {
  await scheduledMessageWorker.close();
  await giveawayDrawWorker.close();
  process.exit(0);
});

process.once("SIGTERM", async () => {
  await scheduledMessageWorker.close();
  await giveawayDrawWorker.close();
  process.exit(0);
});

if (config.botMode === "polling") {
  const bot = createBot(config);
  await registerBotCommands(bot);

  await bot.start({
    drop_pending_updates: config.dropPendingUpdates,
    onStart: (botInfo) => {
      console.info(`XDoingBot polling started as @${botInfo.username}`);
    }
  });
} else {
  const { createServer } = await import("./server.js");
  const server = await createServer(config);
  const address = await server.listen({ host: config.host, port: config.port });
  server.log.info({ address }, "XDoingBot webhook service started");
}
