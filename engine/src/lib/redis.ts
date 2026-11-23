import { Redis } from "ioredis";
import { env } from "../config/env.ts";

/** General-purpose client: presence, caches, rate limits. */
export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });

/** Dedicated pub/sub pair for the Socket.IO Redis adapter. */
export const redisPub = new Redis(env.REDIS_URL, { lazyConnect: true });
export const redisSub = redisPub.duplicate();

/** BullMQ wants its own connection settings (blocking commands, no retry limit). */
export const bullConnection = { url: env.REDIS_URL, maxRetriesPerRequest: null };

export async function closeRedis() {
  await Promise.allSettled([redis.quit(), redisPub.quit(), redisSub.quit()]);
}
