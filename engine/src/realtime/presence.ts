import { redis } from "../lib/redis.ts";
import { prisma } from "../lib/prisma.ts";
import { emitToUsers } from "./io.ts";
import { connectionIds } from "../modules/connections/service.ts";
import { blockedEitherWayIds } from "../modules/blocks/service.ts";
import { logger } from "../lib/logger.ts";

/**
 * presence:{userId} is a sorted set of socket ids scored by their last heartbeat (ms).
 * A socket counts as live while its heartbeat is newer than STALE_MS, so sockets on a
 * crashed instance age out on their own. lastseen:{userId} holds the last offline time.
 */
export const HEARTBEAT_MS = 25_000;
const STALE_MS = 60_000;
const KEY_TTL_SECONDS = 120;

const key = (userId: string) => `presence:${userId}`;
const lastSeenKey = (userId: string) => `lastseen:${userId}`;

export interface PresenceState {
  userId: string;
  online: boolean;
  lastSeenAt: string | null;
}

async function liveCount(userId: string, now = Date.now()): Promise<number> {
  return redis.zcount(key(userId), now - STALE_MS, "+inf");
}

export async function socketOnline(userId: string, socketId: string) {
  const now = Date.now();
  const before = await liveCount(userId, now);
  await redis
    .multi()
    .zremrangebyscore(key(userId), "-inf", now - STALE_MS)
    .zadd(key(userId), now, socketId)
    .expire(key(userId), KEY_TTL_SECONDS)
    .exec();
  if (before === 0) await broadcast({ userId, online: true, lastSeenAt: null });
}

export async function heartbeat(userId: string, socketId: string) {
  await redis.multi().zadd(key(userId), Date.now(), socketId).expire(key(userId), KEY_TTL_SECONDS).exec();
}

export async function socketOffline(userId: string, socketId: string) {
  await redis.zrem(key(userId), socketId);
  if ((await liveCount(userId)) > 0) return;
  const now = new Date();
  await redis.set(lastSeenKey(userId), now.toISOString(), "EX", 30 * 86_400);
  await prisma.user.update({ where: { id: userId }, data: { lastSeenAt: now } }).catch((err) => {
    logger.warn({ err, userId }, "failed to store lastSeenAt");
  });
  await broadcast({ userId, online: false, lastSeenAt: now.toISOString() });
}

export async function isOnline(userId: string): Promise<boolean> {
  return (await liveCount(userId)) > 0;
}

/** Presence for many users in one round trip. */
export async function getPresence(userIds: string[], dbLastSeen?: Map<string, Date | null>): Promise<PresenceState[]> {
  if (userIds.length === 0) return [];
  const now = Date.now();
  const pipeline = redis.pipeline();
  for (const id of userIds) {
    pipeline.zcount(key(id), now - STALE_MS, "+inf");
    pipeline.get(lastSeenKey(id));
  }
  const results = (await pipeline.exec()) ?? [];
  return userIds.map((userId, i) => {
    const count = Number(results[i * 2]?.[1] ?? 0);
    const cached = results[i * 2 + 1]?.[1] as string | null | undefined;
    const fromDb = dbLastSeen?.get(userId);
    const online = count > 0;
    return {
      userId,
      online,
      lastSeenAt: online ? null : (cached ?? fromDb?.toISOString() ?? null),
    };
  });
}

/** Tells the user's connections (minus blocks either way) that they came online or went offline. */
async function broadcast(state: PresenceState) {
  const [conns, blocked] = await Promise.all([connectionIds(state.userId), blockedEitherWayIds(state.userId)]);
  const targets = conns.filter((id) => !blocked.has(id));
  emitToUsers(targets, "presence:update", state);
}
