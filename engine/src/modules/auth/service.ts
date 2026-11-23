import { prisma } from "../../lib/prisma.ts";
import { AppError, conflict, unauthorized } from "../../lib/errors.ts";
import { hashToken } from "../../lib/jwt.ts";
import { createSession, issueTokens, revokeSessionIds, revokeUserSessions } from "./sessions.ts";
import { toMe } from "../users/dto.ts";
import { logger } from "../../lib/logger.ts";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

// Verifying against a throwaway hash keeps "unknown email" as slow as "wrong password".
const dummyHash = await Bun.password.hash("not-a-real-password", { algorithm: "argon2id" });

export async function register(input: { email: string; password: string; deviceId?: string }) {
  const email = normalizeEmail(input.email);
  const passwordHash = await Bun.password.hash(input.password, { algorithm: "argon2id" });
  let user;
  try {
    user = await prisma.user.create({ data: { email, passwordHash } });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw conflict("EMAIL_TAKEN", "An account with this email already exists");
    throw err;
  }
  const { tokens } = await createSession(user.id, input.deviceId);
  return { user: await toMe(user), tokens };
}

export async function login(input: { email: string; password: string; deviceId?: string }) {
  const email = normalizeEmail(input.email);
  const user = await prisma.user.findUnique({ where: { email } });
  const ok = await Bun.password.verify(input.password, user?.passwordHash ?? dummyHash);
  if (!user || !ok) throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is wrong");
  const { tokens } = await createSession(user.id, input.deviceId);
  return { user: await toMe(user), tokens };
}

/**
 * Rotates the refresh token. A token can be used once; using it again means it was
 * copied, so every session of the account is revoked.
 */
export async function refresh(refreshToken: string) {
  const row = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(refreshToken) },
    include: { session: true },
  });
  if (!row) throw unauthorized("Unknown refresh token");

  const { session } = row;
  if (row.usedAt) {
    logger.warn({ userId: session.userId, sessionId: session.id }, "refresh token reuse detected");
    await revokeUserSessions(session.userId, { reason: "token_reuse" });
    throw unauthorized("Refresh token was already used", "SESSION_REVOKED");
  }
  if (session.revokedAt) throw unauthorized("This session was signed out", "SESSION_REVOKED");
  if (row.expiresAt < new Date() || session.expiresAt < new Date()) throw unauthorized("Session expired");

  // Conditional update closes the race where two requests use the same token at once.
  const claimed = await prisma.refreshToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) {
    await revokeUserSessions(session.userId, { reason: "token_reuse" });
    throw unauthorized("Refresh token was already used", "SESSION_REVOKED");
  }
  return issueTokens(session.userId, session.id, session.expiresAt);
}

export async function logout(sessionId: string) {
  await revokeSessionIds([sessionId], "signed_out");
}
