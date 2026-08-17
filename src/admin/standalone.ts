import { loadConfig } from "../lib/config.js";
import { createServer } from "../server.js";

const config = loadConfig();
const server = await createServer(config);
await server.listen({ host: config.host, port: config.port });

async function shutdown() {
  await server.close();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
