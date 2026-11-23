import { api, unwrap, type Schemas } from "../api/client";
import { fetchWithTimeout } from "../lib/fetch";

export interface PickedFile {
  uri: string;
  name: string;
  mime: string;
  size: number;
}

/**
 * Uploads straight to S3 with the presigned POST from the engine:
 * 1. ask for an upload slot, 2. POST the file to S3, 3. tell the engine it is done.
 */
export async function uploadFile(file: PickedFile, purpose: "chat" | "status" | "avatar"): Promise<Schemas["File"]> {
  const slot = await unwrap(api.POST("/files/upload-url", { body: { mime: file.mime, size: file.size, name: file.name, purpose } }));

  const form = new FormData();
  for (const [k, v] of Object.entries(slot.upload.fields)) form.append(k, v);
  // S3 requires the file to be the last field.
  form.append("file", { uri: file.uri, name: file.name, type: file.mime } as unknown as Blob);

  const res = await fetchWithTimeout(slot.upload.url, { method: "POST", body: form }, 120_000);
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);

  return unwrap(api.POST("/files/{id}/complete", { params: { path: { id: slot.file.id } } }));
}
