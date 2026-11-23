import { prisma } from "../../lib/prisma.ts";
import { redis } from "../../lib/redis.ts";
import { env } from "../../config/env.ts";
import { hashToken, newRefreshToken, signAccessToken } from "../../lib/jwt.ts";
import { getIo, rooms } from "../../realtime/io.ts";
import { logger } from "../../lib/logger.ts";

const revokedKey = (sid: string) => `revoked-session:${sid}`;

export interface TokenPair {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

/** Access tokens are stateless, so revocation is remembered in Redis for as long as one could still be valid. */
export async function isSessionRevoked(sessionId: string): Promise<boolean> {
  return (await redis.exists(revokedKey(sessionId))) === 1;
}

async function issueRefreshToken(sessionId: string, expiresAt: Date) {
  const refreshToken = newRefreshToken();
  await prisma.refreshToken.create({
    data: { sessionId, tokenHash: hashToken(refreshToken), expiresAt },
  });
  return refreshToken;
}

export async function issueTokens(userId: string, sessionId: string, sessionExpiresAt: Date): Promise<TokenPair> {
  const accessToken = await signAccessToken({ sub: userId, sid: sessionId });
  const refreshToken = await issueRefreshToken(sessionId, sessionExpiresAt);
  return {
    accessToken,
    accessTokenExpiresAt: new Date(Date.now() + env.ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
    refreshToken,
    refreshTokenExpiresAt: sessionExpiresAt.toISOString(),
  };
}

/**
 * v1 policy: one active device per account. Creating a session signs out every other one.
 */
export async function createSession(userId: string, deviceId?: string): Promise<{ sessionId: string; tokens: TokenPair }> {
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  const session = await prisma.session.create({ data: { userId, deviceId, expiresAt } });
  await revokeUserSessions(userId, { except: session.id, reason: "signed_in_elsewhere" });
  return { sessionId: session.id, tokens: await issueTokens(userId, session.id, expiresAt) };
}

export type RevokeReason = "signed_in_elsewhere" | "signed_out" | "token_reuse";

export async function revokeUserSessions(userId: string, opts: { except?: string; reason: RevokeReason }) {
  const sessions = await prisma.session.findMany({
    where: { userId, revokedAt: null, ...(opts.except ? { id: { not: opts.except } } : {}) },
    select: { id: true },
  });
  if (sessions.length === 0) return;
  await revokeSessionIds(
    sessions.map((s) => s.id),
    opts.reason,
  );
}

export async function revokeSessionIds(sessionIds: string[], reason: RevokeReason) {
  if (sessionIds.length === 0) return;
  await prisma.$transaction([
    prisma.session.updateMany({ where: { id: { in: sessionIds }, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.pushToken.deleteMany({ where: { sessionId: { in: sessionIds } } }),
  ]);
  const pipeline = redis.pipeline();
  for (const sid of sessionIds) pipeline.set(revokedKey(sid), reason, "EX", env.ACCESS_TOKEN_TTL_SECONDS + 60);
  await pipeline.exec();

  const io = getIo();
  if (io) {
    for (const sid of sessionIds) {
      io.to(rooms.session(sid)).emit("session:revoked", { reason });
      io.in(rooms.session(sid)).disconnectSockets(true);
    }
  }
  logger.debug({ sessionIds, reason }, "sessions revoked");
}
