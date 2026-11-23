import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectsCommand,
  NotFound,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env.ts";
import { AppError } from "./errors.ts";

export const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});

const bucket = () => {
  if (!env.S3_BUCKET) throw new AppError(503, "STORAGE_NOT_CONFIGURED", "File storage is not configured");
  return env.S3_BUCKET;
};

export const UPLOAD_URL_TTL_SECONDS = 10 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

/** Presigned POST so S3 itself enforces the size limit and content type. */
export async function presignUpload(key: string, mime: string, maxBytes: number) {
  return createPresignedPost(s3, {
    Bucket: bucket(),
    Key: key,
    Conditions: [
      ["content-length-range", 1, maxBytes],
      ["eq", "$Content-Type", mime],
    ],
    Fields: { "Content-Type": mime },
    Expires: UPLOAD_URL_TTL_SECONDS,
  });
}

export async function presignDownload(key: string, filename?: string | null, ttlSeconds = DOWNLOAD_URL_TTL_SECONDS) {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      ResponseContentDisposition: filename
        ? `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
        : undefined,
    }),
    { expiresIn: ttlSeconds },
  );
}

export async function headObject(key: string): Promise<{ size: number; contentType?: string; lastModified?: Date } | null> {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return { size: res.ContentLength ?? 0, contentType: res.ContentType, lastModified: res.LastModified };
  } catch (err) {
    if (err instanceof NotFound || (err as { name?: string }).name === "NotFound") return null;
    throw err;
  }
}

/**
 * Copies an object onto itself. S3 lifecycle expiry counts from the object's creation time,
 * and an in-place copy creates a new object, so this restarts the 30-day clock.
 * MetadataDirective=REPLACE is required for a same-key copy, so the content type is sent again.
 */
export async function refreshObjectAge(key: string, mime: string) {
  const b = bucket();
  await s3.send(
    new CopyObjectCommand({
      Bucket: b,
      Key: key,
      CopySource: `${b}/${key.split("/").map(encodeURIComponent).join("/")}`,
      MetadataDirective: "REPLACE",
      ContentType: mime,
      Metadata: { refreshed: new Date().toISOString() },
    }),
  );
}

export async function deleteObjects(keys: string[]) {
  if (!keys.length || !env.S3_BUCKET) return;
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: env.S3_BUCKET,
        Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
      }),
    );
  }
}

export const storageConfigured = () => Boolean(env.S3_BUCKET);
