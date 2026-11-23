import { prisma } from "../../lib/prisma.ts";
import { redis } from "../../lib/redis.ts";

/**
 * conns:{userId} is a write-through cache of known connections. Members are only ever added,
 * so a hit is always correct; a miss falls back to Postgres.
 */
const cacheKey = (userId: string) => `conns:${userId}`;
const CACHE_TTL_SECONDS = 7 * 86_400;

const pair = (a: string, b: string) => (a < b ? { userAId: a, userBId: b } : { userAId: b, userBId: a });

async function cache(a: string, b: string) {
  await redis
    .multi()
    .sadd(cacheKey(a), b)
    .expire(cacheKey(a), CACHE_TTL_SECONDS)
    .sadd(cacheKey(b), a)
    .expire(cacheKey(b), CACHE_TTL_SECONDS)
    .exec();
}

export async function isConnected(a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  if ((await redis.sismember(cacheKey(a), b)) === 1) return true;
  const row = await prisma.connection.findUnique({ where: { userAId_userBId: pair(a, b) } });
  if (row) await cache(a, b);
  return Boolean(row);
}

/** Called on every message send; creates the connection the first time two users talk. */
export async function ensureConnection(a: string, b: string): Promise<{ created: boolean }> {
  if ((await redis.sismember(cacheKey(a), b)) === 1) return { created: false };
  const key = pair(a, b);
  const existing = await prisma.connection.findUnique({ where: { userAId_userBId: key } });
  if (!existing) {
    await prisma.connection.upsert({ where: { userAId_userBId: key }, create: key, update: {} });
  }
  await cache(a, b);
  return { created: !existing };
}

export async function connectionIds(userId: string): Promise<string[]> {
  const rows = await prisma.connection.findMany({
    where: { OR: [{ userAId: userId }, { userBId: userId }] },
    select: { userAId: true, userBId: true },
  });
  return rows.map((r) => (r.userAId === userId ? r.userBId : r.userAId));
}

export async function listConnections(userId: string) {
  const rows = await prisma.connection.findMany({
    where: { OR: [{ userAId: userId }, { userBId: userId }] },
    orderBy: { createdAt: "desc" },
    select: {
      createdAt: true,
      userA: { select: { id: true, username: true, displayName: true, avatarFileId: true, lastSeenAt: true } },
      userB: { select: { id: true, username: true, displayName: true, avatarFileId: true, lastSeenAt: true } },
    },
  });
  return rows.map((r) => ({ user: r.userA.id === userId ? r.userB : r.userA, connectedAt: r.createdAt }));
}
