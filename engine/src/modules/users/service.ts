import { prisma } from "../../lib/prisma.ts";
import { badRequest, conflict, notFound } from "../../lib/errors.ts";
import { blockedEitherWayIds, hasBlocked, isBlockedEitherWay } from "../blocks/service.ts";
import { isConnected } from "../connections/service.ts";
import { getPresence } from "../../realtime/presence.ts";
import { avatarUrls, publicUserSelect, toPublicUser } from "./dto.ts";

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

export async function updateProfile(
  userId: string,
  input: { displayName?: string | null; about?: string | null; avatarFileId?: string | null },
) {
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
      ...(input.about !== undefined ? { about: input.about?.trim() || null } : {}),
      ...(input.avatarFileId !== undefined ? { avatarFileId: input.avatarFileId } : {}),
    },
  });
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/**
 * Finds people by username prefix or by name (any word of the display name starting with
 * the term). "@abc" searches usernames only. Exact username matches come first.
 * Usernames use the text_pattern_ops index; names are fine to scan at this scale.
 */
export async function searchUsers(me: string, rawQuery: string, limit: number) {
  const term = rawQuery.trim().toLowerCase().replace(/\s+/g, " ");
  if (!term) return [];
  const usernameOnly = term.startsWith("@");
  const uname = term.replace(/^@/, "");
  const unameOk = /^[a-z0-9_.]+$/.test(uname);
  if (usernameOnly && !unameOk) return [];
  if (!uname) return [];
  const hidden = await blockedEitherWayIds(me);
  const unamePattern = unameOk ? escapeLike(uname) + "%" : null;
  const namePattern = escapeLike(uname) + "%";
  const wordPattern = "% " + escapeLike(uname) + "%";
  const rows = await prisma.$queryRaw<
    { id: string; username: string; displayName: string | null; about: string | null; avatarFileId: string | null }[]
  >`
    SELECT id, username, "displayName", about, "avatarFileId"
    FROM "User"
    WHERE username IS NOT NULL
      AND id <> ${me}::uuid
      AND (
        (${unamePattern}::text IS NOT NULL AND username LIKE ${unamePattern} ESCAPE '\\')
        OR (${!usernameOnly} AND (lower("displayName") LIKE ${namePattern} ESCAPE '\\' OR lower("displayName") LIKE ${wordPattern} ESCAPE '\\'))
      )
    ORDER BY (username = ${uname}) DESC,
             (${unamePattern}::text IS NOT NULL AND username LIKE ${unamePattern} ESCAPE '\\') DESC,
             length(username), username
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

/**
 * Everything the profile screen shows. Hidden (404) only when *they* blocked you, so you can
 * still open someone you blocked to unblock them. Presence only for connections without a block.
 */
export async function userProfile(me: string, userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { ...publicUserSelect, lastSeenAt: true } });
  if (!user?.username) throw notFound("User not found");
  if (userId !== me && (await hasBlocked(userId, me))) throw notFound("User not found");
  const blockedByMe = userId !== me && (await hasBlocked(me, userId));
  const connected = userId === me || (await isConnected(me, userId));

  let online: boolean | null = null;
  let lastSeenAt: string | null = null;
  if (connected && !blockedByMe && userId !== me) {
    const [p] = await getPresence([userId], new Map([[userId, user.lastSeenAt]]));
    online = p?.online ?? false;
    lastSeenAt = p?.lastSeenAt ?? null;
  }

  const groups = await prisma.group.findMany({
    where: { AND: [{ members: { some: { userId: me } } }, { members: { some: { userId } } }] },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, avatarFileId: true, _count: { select: { members: true } } },
    take: 50,
  });
  const urls = await avatarUrls(groups.flatMap((g) => (g.avatarFileId ? [g.avatarFileId] : [])));
  return {
    user: await toPublicUser(user),
    isMe: userId === me,
    isConnected: connected,
    blockedByMe,
    online,
    lastSeenAt,
    commonGroups: userId === me ? [] : groups.map((g) => ({
      id: g.id,
      name: g.name,
      avatarFileId: g.avatarFileId,
      avatarUrl: g.avatarFileId ? (urls.get(g.avatarFileId) ?? null) : null,
      memberCount: g._count.members,
    })),
  };
}
