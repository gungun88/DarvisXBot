import { loadConfig } from "./lib/config.js";
import { createBot, registerBotCommands } from "./telegram/bot.js";
import { startScheduledMessageWorker } from "./scheduled-messages/scheduled-message.worker.js";
import { startGiveawayDrawWorker, syncActiveGiveawayDrawJobs } from "./giveaways/giveaway.worker.js";
import { startSignInMessageDeleteWorker } from "./telegram/sign-in-delete.worker.js";
import { startOperationsMonitor } from "./operations/health.service.js";

const config = loadConfig();
const bot = createBot(config);
await registerBotCommands(bot);
const scheduledMessageWorker = startScheduledMessageWorker(config);
const giveawayDrawWorker = startGiveawayDrawWorker(config);
const signInMessageDeleteWorker = startSignInMessageDeleteWorker(config);
const stopOperationsMonitor = startOperationsMonitor(config);
await syncActiveGiveawayDrawJobs();

const { createServer } = await import("./server.js");
const server = await createServer(config, config.botMode === "webhook" ? bot : undefined);
const address = await server.listen({ host: config.host, port: config.port });
server.log.info({ address }, "DarvisXBot HTTP service started");

async function shutdown() {
  stopOperationsMonitor();
  bot.stop();
  await scheduledMessageWorker.close();
  await giveawayDrawWorker.close();
  await signInMessageDeleteWorker.close();
  await server.close();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

if (config.botMode === "polling") {
  await bot.start({
    drop_pending_updates: config.dropPendingUpdates,
    onStart: (botInfo) => {
      console.info(`DarvisXBot polling started as @${botInfo.username}`);
    }
  });
}
