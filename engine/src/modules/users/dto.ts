import { z } from "@hono/zod-openapi";
import { presignDownload, storageConfigured } from "../../lib/s3.ts";
import { prisma } from "../../lib/prisma.ts";

export const PublicUserSchema = z
  .object({
    id: z.string().uuid(),
    username: z.string(),
    displayName: z.string().nullable(),
    about: z.string().nullable().openapi({ description: "The profile's About line" }),
    avatarFileId: z.string().uuid().nullable().openapi({ description: "Use as the image cache key; the URL changes on every response." }),
    avatarUrl: z.string().url().nullable(),
  })
  .openapi("PublicUser");

export const MeSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    username: z.string().nullable(),
    displayName: z.string().nullable(),
    about: z.string().nullable(),
    avatarFileId: z.string().uuid().nullable(),
    avatarUrl: z.string().url().nullable(),
    createdAt: z.string(),
  })
  .openapi("Me");

export type PublicUser = z.infer<typeof PublicUserSchema>;
export type Me = z.infer<typeof MeSchema>;

type UserRow = {
  id: string;
  username: string | null;
  displayName: string | null;
  about?: string | null;
  avatarFileId: string | null;
};

const AVATAR_URL_TTL_SECONDS = 6 * 3600;

export async function avatarUrls(fileIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!fileIds.length || !storageConfigured()) return map;
  const files = await prisma.file.findMany({ where: { id: { in: fileIds }, state: "ready" }, select: { id: true, key: true } });
  await Promise.all(files.map(async (f) => map.set(f.id, await presignDownload(f.key, null, AVATAR_URL_TTL_SECONDS))));
  return map;
}

export async function toPublicUsers(rows: UserRow[]): Promise<PublicUser[]> {
  const urls = await avatarUrls(rows.flatMap((r) => (r.avatarFileId ? [r.avatarFileId] : [])));
  return rows.map((r) => ({
    id: r.id,
    username: r.username ?? "",
    displayName: r.displayName,
    about: r.about ?? null,
    avatarFileId: r.avatarFileId,
    avatarUrl: r.avatarFileId ? (urls.get(r.avatarFileId) ?? null) : null,
  }));
}

export async function toPublicUser(row: UserRow): Promise<PublicUser> {
  return (await toPublicUsers([row]))[0]!;
}

export async function toMe(row: UserRow & { email: string; createdAt: Date }): Promise<Me> {
  const pub = await toPublicUser(row);
  return { ...pub, username: row.username, email: row.email, createdAt: row.createdAt.toISOString() };
}

export const publicUserSelect = { id: true, username: true, displayName: true, about: true, avatarFileId: true } as const;
