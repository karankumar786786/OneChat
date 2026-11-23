import { prisma } from "../../lib/prisma.ts";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors.ts";
import { isConnected } from "../connections/service.ts";
import { isBlockedEitherWay } from "../blocks/service.ts";
import { avatarUrls, publicUserSelect, toPublicUsers, type PublicUser } from "../users/dto.ts";
import { enqueueMany } from "../../realtime/inbox.ts";
import { getGroupMeta, invalidateGroup, memberOf, type GroupMeta } from "./cache.ts";
import type { GroupAction, GroupUpdatePayload } from "../../realtime/types.ts";

export const MAX_GROUP_SIZE = 256;

export interface GroupSummary {
  id: string;
  name: string;
  description: string | null;
  avatarFileId: string | null;
  avatarUrl: string | null;
  onlyAdminsCanSend: boolean;
  onlyAdminsCanEditInfo: boolean;
  createdById: string;
  createdAt: string;
  memberCount: number;
  myRole: "member" | "admin";
  mutedUntil: string | null;
}

export interface GroupMemberDto {
  user: PublicUser;
  role: "member" | "admin";
  joinedAt: string;
  isCreator: boolean;
}

// ---------------------------------------------------------------------------
// helpers

async function requireMember(userId: string, groupId: string): Promise<{ meta: GroupMeta; role: "member" | "admin" }> {
  const meta = await getGroupMeta(groupId);
  const me = memberOf(meta, userId);
  if (!meta || !me) throw notFound("Group not found");
  return { meta, role: me.role };
}

async function requireAdmin(userId: string, groupId: string) {
  const r = await requireMember(userId, groupId);
  if (r.role !== "admin") throw forbidden("Only group admins can do that");
  return r;
}

async function usernames(ids: string[]) {
  const rows = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, username: true } });
  const map = new Map(rows.map((r) => [r.id, r.username ?? ""]));
  return ids.map((id) => ({ id, username: map.get(id) ?? "" }));
}

/**
 * Tells every member (and anyone just removed) what changed. Each device turns this
 * into a system message ("@a added @b") and refreshes its copy of the group.
 */
async function announce(
  groupId: string,
  recipients: string[],
  action: GroupAction,
  actorId: string,
  targetIds: string[] = [],
  changes: GroupUpdatePayload["changes"] = null,
) {
  const [actor] = await usernames([actorId]);
  const payload: GroupUpdatePayload = {
    groupId,
    action,
    actor: actor!,
    targets: targetIds.length ? await usernames(targetIds) : [],
    changes,
    at: new Date().toISOString(),
  };
  await enqueueMany("group.update", actorId, [...new Set(recipients)], payload, { groupId });
}

/** You can add people you chat with (WhatsApp: your contacts), unless a block stands between you. */
async function checkAddable(actorId: string, userIds: string[]) {
  for (const id of userIds) {
    if (id === actorId) continue;
    const user = await prisma.user.findUnique({ where: { id }, select: { username: true } });
    if (!user?.username) throw badRequest(`User ${id} does not exist`);
    if (!(await isConnected(actorId, id))) throw badRequest(`You can only add people you have chatted with (@${user.username})`);
    if (await isBlockedEitherWay(actorId, id)) throw forbidden(`You cannot add @${user.username}`);
  }
}

async function checkAvatar(userId: string, fileId: string) {
  const file = await prisma.file.findUnique({ where: { id: fileId } });
  if (!file || file.ownerId !== userId || file.purpose !== "avatar" || file.state !== "ready") {
    throw badRequest("avatarFileId must be a finished avatar upload of yours");
  }
}

function newInviteCode() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("base64url");
}

async function summaryFor(userId: string, groupId: string): Promise<GroupSummary> {
  const g = await prisma.group.findUnique({
    where: { id: groupId },
    include: { _count: { select: { members: true } }, members: { where: { userId }, select: { role: true, mutedUntil: true } } },
  });
  if (!g || g.members.length === 0) throw notFound("Group not found");
  const urls = await avatarUrls(g.avatarFileId ? [g.avatarFileId] : []);
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    avatarFileId: g.avatarFileId,
    avatarUrl: g.avatarFileId ? (urls.get(g.avatarFileId) ?? null) : null,
    onlyAdminsCanSend: g.onlyAdminsCanSend,
    onlyAdminsCanEditInfo: g.onlyAdminsCanEditInfo,
    createdById: g.createdById,
    createdAt: g.createdAt.toISOString(),
    memberCount: g._count.members,
    myRole: g.members[0]!.role,
    mutedUntil: g.members[0]!.mutedUntil?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// reads

export async function listGroups(userId: string): Promise<GroupSummary[]> {
  const rows = await prisma.groupMember.findMany({ where: { userId }, select: { groupId: true }, orderBy: { joinedAt: "desc" } });
  return Promise.all(rows.map((r) => summaryFor(userId, r.groupId)));
}

export async function groupDetails(userId: string, groupId: string) {
  const summary = await summaryFor(userId, groupId);
  const members = await prisma.groupMember.findMany({
    where: { groupId },
    orderBy: [{ role: "desc" }, { joinedAt: "asc" }],
    select: { role: true, joinedAt: true, user: { select: publicUserSelect } },
  });
  const users = await toPublicUsers(members.map((m) => m.user));
  const memberDtos: GroupMemberDto[] = members.map((m, i) => ({
    user: users[i]!,
    role: m.role,
    joinedAt: m.joinedAt.toISOString(),
    isCreator: m.user.id === summary.createdById,
  }));
  return { ...summary, members: memberDtos };
}

// ---------------------------------------------------------------------------
// writes

export async function createGroup(
  creatorId: string,
  input: { name: string; description?: string | null; avatarFileId?: string | null; memberIds: string[] },
) {
  const name = input.name.trim();
  if (!name) throw badRequest("Group name is required");
  const memberIds = [...new Set(input.memberIds)].filter((id) => id !== creatorId);
  if (memberIds.length === 0) throw badRequest("Add at least one person");
  if (memberIds.length + 1 > MAX_GROUP_SIZE) throw badRequest(`Groups can have at most ${MAX_GROUP_SIZE} members`);
  await checkAddable(creatorId, memberIds);
  if (input.avatarFileId) await checkAvatar(creatorId, input.avatarFileId);

  const group = await prisma.group.create({
    data: {
      name,
      description: input.description?.trim() || null,
      avatarFileId: input.avatarFileId ?? null,
      createdById: creatorId,
      members: {
        create: [
          { userId: creatorId, role: "admin" },
          ...memberIds.map((userId) => ({ userId, role: "member" as const, addedById: creatorId })),
        ],
      },
    },
  });
  await announce(group.id, [creatorId, ...memberIds], "created", creatorId, memberIds, { name });
  return groupDetails(creatorId, group.id);
}

export async function updateInfo(
  userId: string,
  groupId: string,
  input: { name?: string; description?: string | null; avatarFileId?: string | null },
) {
  const { meta, role } = await requireMember(userId, groupId);
  if (meta.onlyAdminsCanEditInfo && role !== "admin") throw forbidden("Only admins can edit this group's info");
  const changes: NonNullable<GroupUpdatePayload["changes"]> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw badRequest("Group name is required");
    changes.name = name;
  }
  if (input.description !== undefined) changes.description = input.description?.trim() || null;
  if (input.avatarFileId !== undefined) {
    if (input.avatarFileId) await checkAvatar(userId, input.avatarFileId);
    changes.avatarFileId = input.avatarFileId;
  }
  if (Object.keys(changes).length === 0) return groupDetails(userId, groupId);
  await prisma.group.update({ where: { id: groupId }, data: changes });
  await invalidateGroup(groupId);
  await announce(groupId, meta.members.map((m) => m.userId), "info", userId, [], changes);
  return groupDetails(userId, groupId);
}

export async function updateSettings(
  userId: string,
  groupId: string,
  input: { onlyAdminsCanSend?: boolean; onlyAdminsCanEditInfo?: boolean },
) {
  const { meta } = await requireAdmin(userId, groupId);
  const changes = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  if (Object.keys(changes).length === 0) return groupDetails(userId, groupId);
  await prisma.group.update({ where: { id: groupId }, data: changes });
  await invalidateGroup(groupId);
  await announce(groupId, meta.members.map((m) => m.userId), "settings", userId, [], changes);
  return groupDetails(userId, groupId);
}

export async function addMembers(userId: string, groupId: string, userIds: string[]) {
  const { meta } = await requireAdmin(userId, groupId);
  const existing = new Set(meta.members.map((m) => m.userId));
  const fresh = [...new Set(userIds)].filter((id) => !existing.has(id));
  if (fresh.length === 0) throw badRequest("Everyone is already in the group");
  if (meta.members.length + fresh.length > MAX_GROUP_SIZE) throw badRequest(`Groups can have at most ${MAX_GROUP_SIZE} members`);
  await checkAddable(userId, fresh);
  await prisma.groupMember.createMany({
    data: fresh.map((id) => ({ groupId, userId: id, addedById: userId })),
    skipDuplicates: true,
  });
  await invalidateGroup(groupId);
  await announce(groupId, [...existing, ...fresh], "added", userId, fresh);
  return groupDetails(userId, groupId);
}

export async function removeMember(userId: string, groupId: string, targetId: string) {
  if (targetId === userId) return leaveGroup(userId, groupId);
  const { meta } = await requireAdmin(userId, groupId);
  if (!memberOf(meta, targetId)) throw notFound("That person is not in the group");
  if (targetId === meta.createdById) throw forbidden("The group creator cannot be removed");
  await prisma.groupMember.delete({ where: { groupId_userId: { groupId, userId: targetId } } });
  await invalidateGroup(groupId);
  await announce(groupId, meta.members.map((m) => m.userId), "removed", userId, [targetId]);
  return groupDetails(userId, groupId);
}

export async function setRole(userId: string, groupId: string, targetId: string, role: "member" | "admin") {
  const { meta } = await requireAdmin(userId, groupId);
  const target = memberOf(meta, targetId);
  if (!target) throw notFound("That person is not in the group");
  if (role === "member" && targetId === meta.createdById) throw forbidden("The group creator is always an admin");
  if (target.role === role) return groupDetails(userId, groupId);
  await prisma.groupMember.update({ where: { groupId_userId: { groupId, userId: targetId } }, data: { role } });
  await invalidateGroup(groupId);
  await announce(groupId, meta.members.map((m) => m.userId), role === "admin" ? "promoted" : "demoted", userId, [targetId]);
  return groupDetails(userId, groupId);
}

/**
 * Leaving: the last one out deletes the group. If the last admin leaves, the longest-standing
 * member becomes admin (as WhatsApp does), so a group is never left without one.
 */
export async function leaveGroup(userId: string, groupId: string) {
  const { meta } = await requireMember(userId, groupId);
  await prisma.groupMember.delete({ where: { groupId_userId: { groupId, userId } } });
  const remaining = meta.members.filter((m) => m.userId !== userId);
  if (remaining.length === 0) {
    await prisma.group.delete({ where: { id: groupId } });
    await invalidateGroup(groupId);
    return null;
  }
  let promoted: string | null = null;
  if (!remaining.some((m) => m.role === "admin")) {
    promoted = remaining[0]!.userId; // members are ordered by joinedAt
    await prisma.groupMember.update({ where: { groupId_userId: { groupId, userId: promoted } }, data: { role: "admin" } });
  }
  await invalidateGroup(groupId);
  await announce(groupId, meta.members.map((m) => m.userId), "left", userId, [userId]);
  if (promoted) await announce(groupId, remaining.map((m) => m.userId), "promoted", userId, [promoted]);
  return null;
}

export async function setMute(userId: string, groupId: string, until: Date | null) {
  await requireMember(userId, groupId);
  await prisma.groupMember.update({ where: { groupId_userId: { groupId, userId } }, data: { mutedUntil: until } });
  await invalidateGroup(groupId);
  return summaryFor(userId, groupId);
}

// ---------------------------------------------------------------------------
// invite links

export async function getInvite(userId: string, groupId: string, opts: { reset?: boolean } = {}) {
  await requireAdmin(userId, groupId);
  const g = await prisma.group.findUniqueOrThrow({ where: { id: groupId }, select: { inviteCode: true } });
  let code = g.inviteCode;
  if (!code || opts.reset) {
    code = newInviteCode();
    await prisma.group.update({ where: { id: groupId }, data: { inviteCode: code } });
  }
  return { code };
}

export async function disableInvite(userId: string, groupId: string) {
  await requireAdmin(userId, groupId);
  await prisma.group.update({ where: { id: groupId }, data: { inviteCode: null } });
}

async function groupByCode(code: string) {
  const g = await prisma.group.findUnique({
    where: { inviteCode: code },
    select: { id: true, name: true, description: true, avatarFileId: true, _count: { select: { members: true } } },
  });
  if (!g) throw new AppError(404, "NOT_FOUND", "This invite link is invalid or was reset");
  return g;
}

export async function previewInvite(userId: string, code: string) {
  const g = await groupByCode(code);
  const urls = await avatarUrls(g.avatarFileId ? [g.avatarFileId] : []);
  const meta = await getGroupMeta(g.id);
  return {
    groupId: g.id,
    name: g.name,
    description: g.description,
    avatarFileId: g.avatarFileId,
    avatarUrl: g.avatarFileId ? (urls.get(g.avatarFileId) ?? null) : null,
    memberCount: g._count.members,
    alreadyMember: Boolean(memberOf(meta, userId)),
  };
}

export async function joinByInvite(userId: string, code: string) {
  const g = await groupByCode(code);
  const meta = await getGroupMeta(g.id);
  if (memberOf(meta, userId)) return groupDetails(userId, g.id);
  if (g._count.members >= MAX_GROUP_SIZE) throw badRequest("This group is full");
  await prisma.groupMember.create({ data: { groupId: g.id, userId } });
  await invalidateGroup(g.id);
  await announce(g.id, [...(meta?.members.map((m) => m.userId) ?? []), userId], "joined", userId, [userId]);
  return groupDetails(userId, g.id);
}
