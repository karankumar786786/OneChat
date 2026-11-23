import { Directory, File, Paths } from "expo-file-system";
import { api, ApiError, unwrap } from "../api/client";
import type { FileMeta } from "../db/types";

const dir = () => {
  const d = new Directory(Paths.cache, "chat-files");
  if (!d.exists) d.create({ intermediates: true });
  return d;
};

/** Downloads a chat file into the app cache and returns its local uri. Throws ApiError GONE once expired. */
export async function downloadFile(meta: FileMeta): Promise<string> {
  const ext = meta.name?.includes(".") ? meta.name.slice(meta.name.lastIndexOf(".")) : "";
  const target = new File(dir(), `${meta.id}${ext}`);
  if (target.exists) return target.uri;
  const { url } = await unwrap(api.GET("/files/{id}/download-url", { params: { path: { id: meta.id } } }));
  const file = await File.downloadFileAsync(url, target);
  return file.uri;
}

export const isExpiredError = (e: unknown) => e instanceof ApiError && e.status === 410;
