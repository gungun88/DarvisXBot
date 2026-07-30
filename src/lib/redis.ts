import { Redis } from "ioredis";
import { loadConfig } from "./config.js";

const config = loadConfig();

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null
});
