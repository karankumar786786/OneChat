import { prisma } from "../../lib/prisma.ts";
import { redis } from "../../lib/redis.ts";

/**
 * What the message hot path needs to know about a group, cached in Redis as JSON.
 * Any change to the group or its members must call invalidateGroup().
 */
export interface GroupMeta {
  id: string;
  name: string;
  onlyAdminsCanSend: boolean;
  onlyAdminsCanEditInfo: boolean;
  createdById: string;
  members: { userId: string; role: "member" | "admin"; username: string; mutedUntil: string | null }[];
}

const key = (groupId: string) => `group:${groupId}`;
const TTL_SECONDS = 3600;

export async function getGroupMeta(groupId: string): Promise<GroupMeta | null> {
  const cached = await redis.get(key(groupId));
  if (cached) return JSON.parse(cached) as GroupMeta;
  const g = await prisma.group.findUnique({
    where: { id: groupId },
    select: {
      id: true,
      name: true,
      onlyAdminsCanSend: true,
      onlyAdminsCanEditInfo: true,
      createdById: true,
      members: {
        orderBy: { joinedAt: "asc" },
        select: { userId: true, role: true, mutedUntil: true, user: { select: { username: true } } },
      },
    },
  });
  if (!g) return null;
  const meta: GroupMeta = {
    id: g.id,
    name: g.name,
    onlyAdminsCanSend: g.onlyAdminsCanSend,
    onlyAdminsCanEditInfo: g.onlyAdminsCanEditInfo,
    createdById: g.createdById,
    members: g.members.map((m) => ({
      userId: m.userId,
      role: m.role,
      username: m.user.username ?? "",
      mutedUntil: m.mutedUntil?.toISOString() ?? null,
    })),
  };
  await redis.set(key(groupId), JSON.stringify(meta), "EX", TTL_SECONDS);
  return meta;
}

export async function invalidateGroup(groupId: string) {
  await redis.del(key(groupId));
}

export function memberOf(meta: GroupMeta | null, userId: string) {
  return meta?.members.find((m) => m.userId === userId) ?? null;
}
