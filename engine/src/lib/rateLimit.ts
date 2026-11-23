import { RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";
import { redis } from "./redis.ts";
import { AppError } from "./errors.ts";
import { env } from "../config/env.ts";

function limiter(keyPrefix: string, points: number, durationSeconds: number) {
  // Tests hammer endpoints from one IP, so limits are relaxed there.
  const scaled = env.NODE_ENV === "test" ? points * 100 : points;
  return new RateLimiterRedis({ storeClient: redis, keyPrefix: `rl:${keyPrefix}`, points: scaled, duration: durationSeconds });
}

export const limits = {
  authByIp: limiter("auth-ip", 20, 60),
  search: limiter("search", 60, 60),
  usernameCheck: limiter("uname", 60, 60),
  uploads: limiter("upload", 120, 3600),
  messages: limiter("msg", 120, 60),
  socketEvents: limiter("sockev", 600, 60),
  statusWrites: limiter("status", 60, 60),
};

export type LimiterName = keyof typeof limits;

/** Consumes one point; throws a 429 AppError when the limit is hit. */
export async function consume(name: LimiterName, key: string): Promise<void> {
  try {
    await limits[name].consume(key);
  } catch (err) {
    if (err instanceof RateLimiterRes) {
      throw new AppError(429, "RATE_LIMITED", "Too many requests, slow down", {
        retryAfterMs: err.msBeforeNext,
      });
    }
    throw err;
  }
}

/** Same as consume() but returns false instead of throwing. Used for socket events. */
export async function tryConsume(name: LimiterName, key: string): Promise<boolean> {
  try {
    await limits[name].consume(key);
    return true;
  } catch (err) {
    if (err instanceof RateLimiterRes) return false;
    throw err;
  }
}
