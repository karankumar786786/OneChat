import { prisma } from "../../lib/prisma.ts";
import { env } from "../../config/env.ts";
import { badRequest, forbidden, notFound } from "../../lib/errors.ts";
import { connectionIds, isConnected } from "../connections/service.ts";
import { blockedEitherWayIds, isBlockedEitherWay } from "../blocks/service.ts";
import { deleteObjects, presignDownload, storageConfigured } from "../../lib/s3.ts";
import { emitToUsers } from "../../realtime/io.ts";
import { publicUserSelect, toPublicUser, toPublicUsers, type PublicUser } from "../users/dto.ts";
import { logger } from "../../lib/logger.ts";
import type { StatusType } from "../../generated/prisma/client.ts";

const MEDIA_URL_TTL_SECONDS = 3600;

export interface StatusDto {
  id: string;
  userId: string;
  type: StatusType;
  text: string | null;
  bg: string | null;
  media: { fileId: string; mime: string; url: string | null } | null;
  createdAt: string;
  expiresAt: string;
}

type StatusRow = {
  id: string;
  userId: string;
  type: StatusType;
  text: string | null;
  bg: string | null;
  createdAt: Date;
  expiresAt: Date;
  file: { id: string; key: string; mime: string } | null;
};

const statusSelect = {
  id: true,
  userId: true,
  type: true,
  text: true,
  bg: true,
  createdAt: true,
  expiresAt: true,
  file: { select: { id: true, key: true, mime: true } },
} as const;

async function toDto(s: StatusRow): Promise<StatusDto> {
  return {
    id: s.id,
    userId: s.userId,
    type: s.type,
    text: s.text,
    bg: s.bg,
    media: s.file
      ? {
          fileId: s.file.id,
          mime: s.file.mime,
          url: storageConfigured() ? await presignDownload(s.file.key, null, MEDIA_URL_TTL_SECONDS).catch(() => null) : null,
        }
      : null,
    createdAt: s.createdAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
  };
}

/** Owners always see their own status; others must be a connection with no block in either direction. */
export async function canSee(viewerId: string, ownerId: string) {
  if (viewerId === ownerId) return true;
  if (!(await isConnected(viewerId, ownerId))) return false;
  return !(await isBlockedEitherWay(viewerId, ownerId));
}

async function loadVisible(viewerId: string, statusId: string) {
  const status = await prisma.status.findUnique({ where: { id: statusId }, select: statusSelect });
  if (!status || status.expiresAt < new Date() || !(await canSee(viewerId, status.userId))) {
    throw notFound("Status not found");
  }
  return status;
}

async function visibleAudience(ownerId: string) {
  const [conns, blocked] = await Promise.all([connectionIds(ownerId), blockedEitherWayIds(ownerId)]);
  return conns.filter((id) => !blocked.has(id));
}

export async function createStatus(
  userId: string,
  input: { type: StatusType; text?: string; bg?: string; fileId?: string },
) {
  if (input.type === "text") {
    if (!input.text?.trim()) throw badRequest("A text status needs text");
    if (input.fileId) throw badRequest("A text status cannot have media");
  } else {
    if (!input.fileId) throw badRequest(`An ${input.type} status needs a fileId`);
    const file = await prisma.file.findUnique({ where: { id: input.fileId } });
    if (!file || file.ownerId !== userId || file.purpose !== "status" || file.state !== "ready") {
      throw badRequest("fileId must be a finished status upload of yours");
    }
    if (!file.mime.startsWith(`${input.type}/`)) throw badRequest(`File is not an ${input.type}`);
  }
  const now = Date.now();
  const expiresAt = new Date(now + env.STATUS_TTL_HOURS * 3_600_000);
  const status = await prisma.status.create({
    data: {
      userId,
      type: input.type,
      text: input.text?.trim() || null,
      bg: input.bg ?? null,
      fileId: input.fileId ?? null,
      createdAt: new Date(now),
      expiresAt,
    },
    select: statusSelect,
  });
  if (input.fileId) {
    // The media lives exactly as long as the status.
    await prisma.file.update({ where: { id: input.fileId }, data: { expiresAt } });
  }
  emitToUsers(await visibleAudience(userId), "status:new", { userId, statusId: status.id, createdAt: status.createdAt.toISOString() });
  return toDto(status);
}

export async function deleteStatus(userId: string, statusId: string) {
  const status = await prisma.status.findUnique({ where: { id: statusId }, select: { userId: true, file: { select: { id: true, key: true } } } });
  if (!status || status.userId !== userId) throw notFound("Status not found");
  await prisma.status.delete({ where: { id: statusId } });
  if (status.file) {
    await deleteObjects([status.file.key]).catch((err) => logger.warn({ err }, "status media delete failed"));
    await prisma.file.delete({ where: { id: status.file.id } }).catch(() => {});
  }
  emitToUsers(await visibleAudience(userId), "status:deleted", { userId, statusId });
}

export interface FeedEntry {
  user: PublicUser;
  statuses: (StatusDto & { viewedByMe: boolean; myReaction: string | null })[];
  hasUnviewed: boolean;
  latestAt: string;
}

export async function feed(viewerId: string): Promise<FeedEntry[]> {
  const [conns, blocked] = await Promise.all([connectionIds(viewerId), blockedEitherWayIds(viewerId)]);
  const owners = conns.filter((id) => !blocked.has(id));
  if (owners.length === 0) return [];

  const rows = await prisma.status.findMany({
    where: { userId: { in: owners }, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "asc" },
    select: {
      ...statusSelect,
      user: { select: publicUserSelect },
      views: { where: { viewerId }, select: { reaction: true } },
    },
  });

  const byUser = new Map<string, typeof rows>();
  for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);

  const users = await toPublicUsers([...byUser.values()].map((list) => list[0]!.user));
  const entries = await Promise.all(
    [...byUser.values()].map(async (list, i) => {
      const statuses = await Promise.all(
        list.map(async (s) => ({
          ...(await toDto(s)),
          viewedByMe: s.views.length > 0,
          myReaction: s.views[0]?.reaction ?? null,
        })),
      );
      return {
        user: users[i]!,
        statuses,
        hasUnviewed: statuses.some((s) => !s.viewedByMe),
        latestAt: statuses[statuses.length - 1]!.createdAt,
      };
    }),
  );
  // Unviewed first, then most recent.
  return entries.sort((a, b) => Number(b.hasUnviewed) - Number(a.hasUnviewed) || b.latestAt.localeCompare(a.latestAt));
}

export async function mine(userId: string) {
  const rows = await prisma.status.findMany({
    where: { userId, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "asc" },
    select: { ...statusSelect, _count: { select: { views: true, comments: true } } },
  });
  return Promise.all(
    rows.map(async (s) => ({ ...(await toDto(s)), viewCount: s._count.views, commentCount: s._count.comments })),
  );
}

export async function getOne(viewerId: string, statusId: string) {
  return toDto(await loadVisible(viewerId, statusId));
}

/** Logs a view. The owner's own views are not logged. The owner is told live on the first view. */
export async function markViewed(viewerId: string, statusId: string) {
  const status = await loadVisible(viewerId, statusId);
  if (status.userId === viewerId) return;
  const existing = await prisma.statusView.findUnique({ where: { statusId_viewerId: { statusId, viewerId } } });
  if (existing) return;
  const view = await prisma.statusView.upsert({
    where: { statusId_viewerId: { statusId, viewerId } },
    create: { statusId, viewerId },
    update: {},
  });
  const viewer = await prisma.user.findUnique({ where: { id: viewerId }, select: publicUserSelect });
  emitToUsers([status.userId], "status:viewed", {
    statusId,
    viewer: viewer ? await toPublicUser(viewer) : null,
    viewedAt: view.viewedAt.toISOString(),
  });
}

/** One reaction per viewer per status; null clears it. Reacting also counts as a view. */
export async function react(viewerId: string, statusId: string, emoji: string | null) {
  const status = await loadVisible(viewerId, statusId);
  if (status.userId === viewerId) throw forbidden("You cannot react to your own status");
  const now = new Date();
  await prisma.statusView.upsert({
    where: { statusId_viewerId: { statusId, viewerId } },
    create: { statusId, viewerId, reaction: emoji, reactedAt: emoji ? now : null },
    update: { reaction: emoji, reactedAt: emoji ? now : null },
  });
  const viewer = await prisma.user.findUnique({ where: { id: viewerId }, select: publicUserSelect });
  emitToUsers([status.userId], "status:reaction", {
    statusId,
    viewer: viewer ? await toPublicUser(viewer) : null,
    reaction: emoji,
    at: now.toISOString(),
  });
}

export async function views(ownerId: string, statusId: string) {
  const status = await prisma.status.findUnique({ where: { id: statusId }, select: { userId: true } });
  if (!status || status.userId !== ownerId) throw notFound("Status not found");
  const rows = await prisma.statusView.findMany({
    where: { statusId },
    orderBy: { viewedAt: "desc" },
    select: { viewedAt: true, reaction: true, reactedAt: true, viewer: { select: publicUserSelect } },
  });
  const viewers = await toPublicUsers(rows.map((r) => r.viewer));
  return rows.map((r, i) => ({
    viewer: viewers[i]!,
    viewedAt: r.viewedAt.toISOString(),
    reaction: r.reaction,
    reactedAt: r.reactedAt?.toISOString() ?? null,
  }));
}

/** Comments are private: only the status owner and the comment's author can read them. */
export async function addComment(authorId: string, statusId: string, text: string) {
  const status = await loadVisible(authorId, statusId);
  if (status.userId === authorId) throw forbidden("Reply to comments in chat instead");
  const comment = await prisma.statusComment.create({
    data: { statusId, authorId, text: text.trim() },
    select: { id: true, text: true, createdAt: true, author: { select: publicUserSelect } },
  });
  const dto = {
    id: comment.id,
    statusId,
    text: comment.text,
    createdAt: comment.createdAt.toISOString(),
    author: await toPublicUser(comment.author),
  };
  // A comment implies the status was seen.
  await prisma.statusView.upsert({
    where: { statusId_viewerId: { statusId, viewerId: authorId } },
    create: { statusId, viewerId: authorId },
    update: {},
  });
  emitToUsers([status.userId], "status:comment", dto);
  return dto;
}

export async function listComments(viewerId: string, statusId: string) {
  const status = await loadVisible(viewerId, statusId);
  const rows = await prisma.statusComment.findMany({
    where: { statusId, ...(status.userId === viewerId ? {} : { authorId: viewerId }) },
    orderBy: { createdAt: "asc" },
    select: { id: true, text: true, createdAt: true, author: { select: publicUserSelect } },
  });
  const authors = await toPublicUsers(rows.map((r) => r.author));
  return rows.map((r, i) => ({ id: r.id, statusId, text: r.text, createdAt: r.createdAt.toISOString(), author: authors[i]! }));
}

/** Hard-deletes expired statuses (views and comments cascade) and their media. */
export async function cleanupExpiredStatuses(batchSize = 500) {
  let removed = 0;
  for (;;) {
    const batch = await prisma.status.findMany({
      where: { expiresAt: { lt: new Date() } },
      select: { id: true, file: { select: { id: true, key: true } } },
      take: batchSize,
    });
    if (batch.length === 0) break;
    const files = batch.flatMap((s) => (s.file ? [s.file] : []));
    await prisma.status.deleteMany({ where: { id: { in: batch.map((s) => s.id) } } });
    if (files.length) {
      await deleteObjects(files.map((f) => f.key)).catch((err) => logger.warn({ err }, "status media delete failed"));
      await prisma.file.deleteMany({ where: { id: { in: files.map((f) => f.id) } } });
    }
    removed += batch.length;
    if (batch.length < batchSize) break;
  }
  return removed;
}
