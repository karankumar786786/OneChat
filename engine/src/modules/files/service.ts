import { prisma } from "../../lib/prisma.ts";
import { env } from "../../config/env.ts";
import { AppError, badRequest, forbidden, gone, notFound } from "../../lib/errors.ts";
import { deleteObjects, headObject, presignDownload, presignUpload, refreshObjectAge } from "../../lib/s3.ts";
import { logger } from "../../lib/logger.ts";
import type { FilePurpose } from "../../generated/prisma/client.ts";

const DAY_MS = 86_400_000;
const MB = 1024 * 1024;

/** S3 lifecycle rules work in whole days, so refreshing more than once a day buys nothing. */
const REFRESH_MIN_INTERVAL_MS = DAY_MS;

const AVATAR_MAX_BYTES = 5 * MB;

export function fileTtlMs() {
  return env.FILE_TTL_DAYS * DAY_MS;
}

function maxBytesFor(purpose: FilePurpose) {
  return purpose === "avatar" ? AVATAR_MAX_BYTES : env.MAX_FILE_MB * MB;
}

function expiryFor(purpose: FilePurpose, from = Date.now()): Date | null {
  if (purpose === "avatar") return null;
  if (purpose === "status") return new Date(from + env.STATUS_TTL_HOURS * 3_600_000);
  return new Date(from + fileTtlMs());
}

function checkMime(purpose: FilePurpose, mime: string) {
  if (purpose === "avatar" && !mime.startsWith("image/")) throw badRequest("Avatars must be images");
  if (purpose === "status" && !mime.startsWith("image/") && !mime.startsWith("video/")) {
    throw badRequest("Status media must be an image or a video");
  }
}

export interface FileDto {
  id: string;
  mime: string;
  size: number;
  name: string | null;
  purpose: FilePurpose;
  state: "pending" | "ready";
  expiresAt: string | null;
}

export function toFileDto(f: {
  id: string;
  mime: string;
  size: number;
  name: string | null;
  purpose: FilePurpose;
  state: "pending" | "ready";
  expiresAt: Date | null;
}): FileDto {
  return {
    id: f.id,
    mime: f.mime,
    size: f.size,
    name: f.name,
    purpose: f.purpose,
    state: f.state,
    expiresAt: f.expiresAt?.toISOString() ?? null,
  };
}

export async function createUpload(ownerId: string, input: { mime: string; size: number; name?: string; purpose: FilePurpose }) {
  checkMime(input.purpose, input.mime);
  const maxBytes = maxBytesFor(input.purpose);
  if (input.size > maxBytes) {
    throw new AppError(413, "FILE_TOO_LARGE", `Files for ${input.purpose} can be at most ${Math.floor(maxBytes / MB)} MB`);
  }
  const id = crypto.randomUUID();
  const key = `${input.purpose}/${id}`;
  // Presign first so a storage misconfiguration fails before a row is written.
  const upload = await presignUpload(key, input.mime, maxBytes);
  const file = await prisma.file.create({
    data: {
      id,
      ownerId,
      key,
      mime: input.mime,
      size: input.size,
      name: input.name ?? null,
      purpose: input.purpose,
      expiresAt: expiryFor(input.purpose),
    },
  });
  return { file: toFileDto(file), upload: { url: upload.url, fields: upload.fields } };
}

export async function completeUpload(ownerId: string, fileId: string) {
  const file = await prisma.file.findUnique({ where: { id: fileId } });
  if (!file || file.ownerId !== ownerId) throw notFound("File not found");
  if (file.state === "ready") return toFileDto(file);

  const head = await headObject(file.key);
  if (!head) throw badRequest("The upload has not reached storage yet");
  if (head.size > maxBytesFor(file.purpose)) {
    await deleteObjects([file.key]);
    await prisma.file.delete({ where: { id: file.id } });
    throw new AppError(413, "FILE_TOO_LARGE", "File is larger than allowed");
  }
  // The S3 clock starts at upload time, so expiry is counted from now.
  const now = new Date();
  const updated = await prisma.file.update({
    where: { id: file.id },
    data: { state: "ready", size: head.size, lastRefreshedAt: now, expiresAt: expiryFor(file.purpose, now.getTime()) },
  });
  return toFileDto(updated);
}

async function canAccess(userId: string, file: { id: string; ownerId: string }) {
  if (file.ownerId === userId) return true;
  const grant = await prisma.fileGrant.findUnique({ where: { fileId_userId: { fileId: file.id, userId } } });
  return Boolean(grant);
}

export async function getFileForUser(userId: string, fileId: string) {
  const file = await prisma.file.findUnique({ where: { id: fileId } });
  if (!file || !(await canAccess(userId, file))) throw notFound("File not found");
  return file;
}

export async function downloadUrl(userId: string, fileId: string) {
  const file = await getFileForUser(userId, fileId);
  if (file.state !== "ready") throw badRequest("File upload is not finished");
  if (file.expiresAt && file.expiresAt < new Date()) throw gone("This file has expired");
  const ttl = 5 * 60;
  return {
    url: await presignDownload(file.key, file.name),
    urlExpiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    file: toFileDto(file),
  };
}

/**
 * Called when a chat or group message carries a file. The sender must own the file or have
 * received it. Every recipient gets a download grant.
 *
 * Forwarding (sending a file you received, or flagging forwarded) restarts the TTL:
 * the S3 object is copied onto itself, which resets its age for the lifecycle rule,
 * and expiresAt moves to now + FILE_TTL_DAYS.
 */
export async function shareFile(senderId: string, recipientIds: string[], fileId: string, forwarded: boolean) {
  const file = await prisma.file.findUnique({ where: { id: fileId } });
  if (!file || !(await canAccess(senderId, file))) throw forbidden("You cannot send this file");
  if (file.purpose !== "chat") throw badRequest("Only chat files can be sent in a message");
  if (file.state !== "ready") throw badRequest("File upload is not finished");
  if (file.expiresAt && file.expiresAt < new Date()) throw gone("This file has expired and cannot be sent");

  const isForward = forwarded || file.ownerId !== senderId;
  let current = file;
  if (isForward && Date.now() - file.lastRefreshedAt.getTime() >= REFRESH_MIN_INTERVAL_MS) {
    await refreshObjectAge(file.key, file.mime);
    const now = new Date();
    current = await prisma.file.update({
      where: { id: file.id },
      data: { lastRefreshedAt: now, expiresAt: new Date(now.getTime() + fileTtlMs()) },
    });
    logger.debug({ fileId, expiresAt: current.expiresAt }, "file TTL refreshed by forward");
  }

  if (recipientIds.length) {
    await prisma.fileGrant.createMany({
      data: recipientIds.map((userId) => ({ fileId, userId })),
      skipDuplicates: true,
    });
  }
  return toFileDto(current);
}

/** 1:1 shorthand. */
export function shareFileInChat(senderId: string, recipientId: string, fileId: string, forwarded: boolean) {
  return shareFile(senderId, [recipientId], fileId, forwarded);
}

/** Removes expired files and uploads that were never finished. S3 lifecycle rules delete the objects too; this keeps the database tidy. */
export async function cleanupExpiredFiles(batchSize = 500) {
  let removed = 0;
  const staleUploadCutoff = new Date(Date.now() - DAY_MS);
  for (;;) {
    const batch = await prisma.file.findMany({
      where: {
        OR: [{ expiresAt: { lt: new Date() } }, { state: "pending", createdAt: { lt: staleUploadCutoff } }],
        // Files still attached to a live status are kept; the status cleanup handles them.
        statuses: { none: { expiresAt: { gt: new Date() } } },
      },
      select: { id: true, key: true },
      take: batchSize,
    });
    if (batch.length === 0) break;
    await deleteObjects(batch.map((f) => f.key)).catch((err) => logger.warn({ err }, "S3 delete failed; lifecycle rule will catch it"));
    await prisma.file.deleteMany({ where: { id: { in: batch.map((f) => f.id) } } });
    removed += batch.length;
    if (batch.length < batchSize) break;
  }
  return removed;
}
