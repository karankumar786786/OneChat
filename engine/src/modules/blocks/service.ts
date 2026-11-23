import { prisma } from "../../lib/prisma.ts";
import { redis } from "../../lib/redis.ts";
import { badRequest, notFound } from "../../lib/errors.ts";

/**
 * blk:{userId} caches the full set of users that userId has blocked.
 * "~" is a sentinel so an empty set still counts as "loaded".
 */
const key = (userId: string) => `blk:${userId}`;
const SENTINEL = "~";
const CACHE_TTL_SECONDS = 3600;

async function ensureLoaded(userId: string) {
  if (await redis.exists(key(userId))) return;
  const rows = await prisma.block.findMany({ where: { blockerId: userId }, select: { blockedId: true } });
  await redis
    .multi()
    .del(key(userId))
    .sadd(key(userId), SENTINEL, ...rows.map((r) => r.blockedId))
    .expire(key(userId), CACHE_TTL_SECONDS)
    .exec();
}

export async function hasBlocked(blockerId: string, blockedId: string): Promise<boolean> {
  await ensureLoaded(blockerId);
  return (await redis.sismember(key(blockerId), blockedId)) === 1;
}

export async function isBlockedEitherWay(a: string, b: string): Promise<boolean> {
  const [ab, ba] = await Promise.all([hasBlocked(a, b), hasBlocked(b, a)]);
  return ab || ba;
}

/** Ids of every user that `userId` blocked or that blocked `userId`. */
export async function blockedEitherWayIds(userId: string): Promise<Set<string>> {
  const rows = await prisma.block.findMany({
    where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
    select: { blockerId: true, blockedId: true },
  });
  return new Set(rows.map((r) => (r.blockerId === userId ? r.blockedId : r.blockerId)));
}

export async function block(blockerId: string, blockedId: string) {
  if (blockerId === blockedId) throw badRequest("You cannot block yourself");
  const target = await prisma.user.findUnique({ where: { id: blockedId }, select: { id: true } });
  if (!target) throw notFound("User not found");
  await prisma.block.upsert({
    where: { blockerId_blockedId: { blockerId, blockedId } },
    create: { blockerId, blockedId },
    update: {},
  });
  await redis.del(key(blockerId));
}

export async function unblock(blockerId: string, blockedId: string) {
  await prisma.block.deleteMany({ where: { blockerId, blockedId } });
  await redis.del(key(blockerId));
}

export async function listBlocked(blockerId: string) {
  const rows = await prisma.block.findMany({
    where: { blockerId },
    orderBy: { createdAt: "desc" },
    select: { blocked: { select: { id: true, username: true, displayName: true, avatarFileId: true } } },
  });
  return rows.map((r) => r.blocked);
}
