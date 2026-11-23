import { prisma } from "../../lib/prisma.ts";
import { badRequest, conflict, notFound } from "../../lib/errors.ts";
import { blockedEitherWayIds, isBlockedEitherWay } from "../blocks/service.ts";
import { publicUserSelect } from "./dto.ts";

export const USERNAME_RE = /^[a-z0-9](?:[a-z0-9_.]{1,18})[a-z0-9]$/;

const RESERVED = new Set([
  "admin", "administrator", "root", "support", "help", "system", "official", "staff",
  "moderator", "mod", "security", "api", "null", "undefined", "me", "you", "everyone",
  "chat", "app", "team", "status", "settings",
]);

export function normalizeUsername(raw: string) {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

/** Returns a reason string when the username is not allowed, or null when it is. */
export function usernameProblem(username: string): string | null {
  if (username.length < 3 || username.length > 20) return "Must be 3 to 20 characters";
  if (!USERNAME_RE.test(username)) return "Use letters, numbers, _ and . only, starting and ending with a letter or number";
  if (/[_.]{2}/.test(username)) return "Cannot have two symbols in a row";
  if (RESERVED.has(username)) return "This username is reserved";
  return null;
}

export async function usernameAvailability(raw: string, forUserId?: string) {
  const username = normalizeUsername(raw);
  const problem = usernameProblem(username);
  if (problem) return { username, available: false, reason: problem };
  const taken = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  if (taken && taken.id !== forUserId) return { username, available: false, reason: "Already taken" };
  return { username, available: true, reason: null };
}

export async function setUsername(userId: string, raw: string) {
  const username = normalizeUsername(raw);
  const problem = usernameProblem(username);
  if (problem) throw badRequest(problem);
  try {
    return await prisma.user.update({ where: { id: userId }, data: { username } });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw conflict("USERNAME_TAKEN", "That username is already taken");
    throw err;
  }
}

export async function updateProfile(userId: string, input: { displayName?: string | null; avatarFileId?: string | null }) {
  if (input.avatarFileId) {
    const file = await prisma.file.findUnique({ where: { id: input.avatarFileId } });
    if (!file || file.ownerId !== userId || file.purpose !== "avatar" || file.state !== "ready") {
      throw badRequest("avatarFileId must be a finished avatar upload of yours");
    }
  }
  return prisma.user.update({
    where: { id: userId },
    data: {
      ...(input.displayName !== undefined ? { displayName: input.displayName?.trim() || null } : {}),
      ...(input.avatarFileId !== undefined ? { avatarFileId: input.avatarFileId } : {}),
    },
  });
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/** Prefix search on username. Uses the text_pattern_ops index, so LIKE 'abc%' stays fast. */
export async function searchUsers(me: string, rawQuery: string, limit: number) {
  const q = normalizeUsername(rawQuery);
  if (!q || !/^[a-z0-9_.]+$/.test(q)) return [];
  const hidden = await blockedEitherWayIds(me);
  const rows = await prisma.$queryRaw<{ id: string; username: string; displayName: string | null; avatarFileId: string | null }[]>`
    SELECT id, username, "displayName", "avatarFileId"
    FROM "User"
    WHERE username LIKE ${escapeLike(q) + "%"} ESCAPE '\\'
      AND id <> ${me}::uuid
    ORDER BY (username = ${q}) DESC, length(username), username
    LIMIT ${limit + hidden.size}
  `;
  return rows.filter((r) => !hidden.has(r.id)).slice(0, limit);
}

/** Profile lookup that hides users on either side of a block. */
export async function getVisibleUser(me: string, where: { id: string } | { username: string }) {
  const user = await prisma.user.findUnique({ where, select: publicUserSelect });
  if (!user || !user.username) throw notFound("User not found");
  if (user.id !== me && (await isBlockedEitherWay(me, user.id))) throw notFound("User not found");
  return user;
}
