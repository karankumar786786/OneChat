import { createRoute, z } from "@hono/zod-openapi";
import { authErrors, bearerSecurity, createRouter, errorResponse, jsonBody, jsonResponse } from "../../lib/http.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { consume } from "../../lib/rateLimit.ts";
import * as files from "./service.ts";

export const FileSchema = z
  .object({
    id: z.string().uuid(),
    mime: z.string(),
    size: z.number().int(),
    name: z.string().nullable(),
    purpose: z.enum(["chat", "status", "avatar"]),
    state: z.enum(["pending", "ready"]),
    expiresAt: z.string().nullable(),
  })
  .openapi("File");

const params = z.object({ id: z.string().uuid() });

const router = createRouter();
router.use("/files", requireAuth);
router.use("/files/*", requireAuth);

router.openapi(
  createRoute({
    method: "post",
    path: "/files/upload-url",
    tags: ["files"],
    summary: "Start an upload. POST the file to upload.url as multipart/form-data with every field in upload.fields, then the file as the last field named 'file'.",
    security: bearerSecurity,
    request: {
      body: jsonBody(
        z.object({
          mime: z.string().min(3).max(127).regex(/^[\w.+-]+\/[\w.+-]+$/, "Invalid MIME type"),
          size: z.number().int().positive(),
          name: z.string().max(255).optional(),
          purpose: z.enum(["chat", "status", "avatar"]),
        }),
      ),
    },
    responses: {
      201: jsonResponse(
        z.object({ file: FileSchema, upload: z.object({ url: z.string().url(), fields: z.record(z.string(), z.string()) }) }),
        "Presigned upload",
      ),
      400: errorResponse("Bad type"),
      413: errorResponse("Too large (FILE_TOO_LARGE)"),
      503: errorResponse("Storage not configured"),
      ...authErrors,
    },
  }),
  async (c) => {
    const me = c.get("userId");
    await consume("uploads", me);
    return c.json(await files.createUpload(me, c.req.valid("json")), 201);
  },
);

router.openapi(
  createRoute({
    method: "post",
    path: "/files/{id}/complete",
    tags: ["files"],
    summary: "Mark an upload finished once the S3 POST succeeded",
    security: bearerSecurity,
    request: { params },
    responses: { 200: jsonResponse(FileSchema, "Ready file"), 400: errorResponse("Not uploaded yet"), 404: errorResponse("Not found"), ...authErrors },
  }),
  async (c) => c.json(await files.completeUpload(c.get("userId"), c.req.valid("param").id), 200),
);

router.openapi(
  createRoute({
    method: "get",
    path: "/files/{id}",
    tags: ["files"],
    summary: "File details (owner and people it was sent to)",
    security: bearerSecurity,
    request: { params },
    responses: { 200: jsonResponse(FileSchema, "File"), 404: errorResponse("Not found"), ...authErrors },
  }),
  async (c) => c.json(files.toFileDto(await files.getFileForUser(c.get("userId"), c.req.valid("param").id)), 200),
);

router.openapi(
  createRoute({
    method: "get",
    path: "/files/{id}/download-url",
    tags: ["files"],
    summary: "Short-lived download link. 410 once the file expired.",
    security: bearerSecurity,
    request: { params },
    responses: {
      200: jsonResponse(z.object({ url: z.string().url(), urlExpiresAt: z.string(), file: FileSchema }), "Download link"),
      404: errorResponse("Not found or no access"),
      410: errorResponse("Expired (GONE)"),
      ...authErrors,
    },
  }),
  async (c) => c.json(await files.downloadUrl(c.get("userId"), c.req.valid("param").id), 200),
);

export default router;
