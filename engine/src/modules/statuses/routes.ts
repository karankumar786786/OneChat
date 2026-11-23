import { createRoute, z } from "@hono/zod-openapi";
import { authErrors, bearerSecurity, createRouter, errorResponse, jsonBody, jsonResponse, noContent } from "../../lib/http.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { consume } from "../../lib/rateLimit.ts";
import { PublicUserSchema } from "../users/dto.ts";
import * as statuses from "./service.ts";

const StatusSchema = z
  .object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
    type: z.enum(["text", "image", "video"]),
    text: z.string().nullable(),
    bg: z.string().nullable(),
    media: z.object({ fileId: z.string().uuid(), mime: z.string(), url: z.string().url().nullable() }).nullable(),
    createdAt: z.string(),
    expiresAt: z.string(),
  })
  .openapi("Status");

const FeedStatusSchema = StatusSchema.extend({ viewedByMe: z.boolean(), myReaction: z.string().nullable() }).openapi("FeedStatus");
const MyStatusSchema = StatusSchema.extend({ viewCount: z.number().int(), commentCount: z.number().int() }).openapi("MyStatus");

const FeedEntrySchema = z
  .object({ user: PublicUserSchema, statuses: z.array(FeedStatusSchema), hasUnviewed: z.boolean(), latestAt: z.string() })
  .openapi("StatusFeedEntry");

const ViewSchema = z
  .object({ viewer: PublicUserSchema, viewedAt: z.string(), reaction: z.string().nullable(), reactedAt: z.string().nullable() })
  .openapi("StatusView");

const CommentSchema = z
  .object({ id: z.string().uuid(), statusId: z.string().uuid(), text: z.string(), createdAt: z.string(), author: PublicUserSchema })
  .openapi("StatusComment");

const params = z.object({ id: z.string().uuid() });
const notFound = { 404: errorResponse("Status not found, expired, or not visible to you") };

const router = createRouter();
router.use("/statuses", requireAuth);
router.use("/statuses/*", requireAuth);

router.openapi(
  createRoute({
    method: "post",
    path: "/statuses",
    tags: ["statuses"],
    summary: "Post a status that disappears after 24 hours. Visible to your connections.",
    security: bearerSecurity,
    request: {
      body: jsonBody(
        z.object({
          type: z.enum(["text", "image", "video"]),
          text: z.string().max(700).optional(),
          bg: z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, "bg must be a hex colour").optional(),
          fileId: z.string().uuid().optional(),
        }),
      ),
    },
    responses: { 201: jsonResponse(StatusSchema, "Created"), 400: errorResponse("Invalid status"), ...authErrors },
  }),
  async (c) => {
    const me = c.get("userId");
    await consume("statusWrites", me);
    return c.json(await statuses.createStatus(me, c.req.valid("json")), 201);
  },
);

router.openapi(
  createRoute({
    method: "get",
    path: "/statuses/feed",
    tags: ["statuses"],
    summary: "Active statuses from your connections, grouped by person, unviewed first",
    security: bearerSecurity,
    responses: { 200: jsonResponse(z.object({ feed: z.array(FeedEntrySchema) }), "Feed"), ...authErrors },
  }),
  async (c) => c.json({ feed: await statuses.feed(c.get("userId")) }, 200),
);

router.openapi(
  createRoute({
    method: "get",
    path: "/statuses/mine",
    tags: ["statuses"],
    summary: "Your active statuses with view and comment counts",
    security: bearerSecurity,
    responses: { 200: jsonResponse(z.object({ statuses: z.array(MyStatusSchema) }), "Your statuses"), ...authErrors },
  }),
  async (c) => c.json({ statuses: await statuses.mine(c.get("userId")) }, 200),
);

router.openapi(
  createRoute({
    method: "get",
    path: "/statuses/{id}",
    tags: ["statuses"],
    summary: "One status",
    security: bearerSecurity,
    request: { params },
    responses: { 200: jsonResponse(StatusSchema, "Status"), ...notFound, ...authErrors },
  }),
  async (c) => c.json(await statuses.getOne(c.get("userId"), c.req.valid("param").id), 200),
);

router.openapi(
  createRoute({
    method: "delete",
    path: "/statuses/{id}",
    tags: ["statuses"],
    summary: "Delete your status early",
    security: bearerSecurity,
    request: { params },
    responses: { 204: noContent, ...notFound, ...authErrors },
  }),
  async (c) => {
    await statuses.deleteStatus(c.get("userId"), c.req.valid("param").id);
    return c.body(null, 204);
  },
);

router.openapi(
  createRoute({
    method: "post",
    path: "/statuses/{id}/view",
    tags: ["statuses"],
    summary: "Record that you watched a status (adds you to its view log)",
    security: bearerSecurity,
    request: { params },
    responses: { 204: noContent, ...notFound, ...authErrors },
  }),
  async (c) => {
    await statuses.markViewed(c.get("userId"), c.req.valid("param").id);
    return c.body(null, 204);
  },
);

router.openapi(
  createRoute({
    method: "post",
    path: "/statuses/{id}/react",
    tags: ["statuses"],
    summary: "Set or clear (null) your reaction on a status",
    security: bearerSecurity,
    request: { params, body: jsonBody(z.object({ emoji: z.string().min(1).max(16).nullable() })) },
    responses: { 204: noContent, 403: errorResponse("Own status"), ...notFound, ...authErrors },
  }),
  async (c) => {
    await statuses.react(c.get("userId"), c.req.valid("param").id, c.req.valid("json").emoji);
    return c.body(null, 204);
  },
);

router.openapi(
  createRoute({
    method: "get",
    path: "/statuses/{id}/views",
    tags: ["statuses"],
    summary: "Who watched your status, when, and how they reacted (owner only)",
    security: bearerSecurity,
    request: { params },
    responses: { 200: jsonResponse(z.object({ views: z.array(ViewSchema) }), "View log"), ...notFound, ...authErrors },
  }),
  async (c) => c.json({ views: await statuses.views(c.get("userId"), c.req.valid("param").id) }, 200),
);

router.openapi(
  createRoute({
    method: "post",
    path: "/statuses/{id}/comments",
    tags: ["statuses"],
    summary: "Comment on a status. Only you and the owner can see it.",
    security: bearerSecurity,
    request: { params, body: jsonBody(z.object({ text: z.string().trim().min(1).max(500) })) },
    responses: { 201: jsonResponse(CommentSchema, "Comment"), 403: errorResponse("Own status"), ...notFound, ...authErrors },
  }),
  async (c) => {
    const me = c.get("userId");
    await consume("statusWrites", me);
    return c.json(await statuses.addComment(me, c.req.valid("param").id, c.req.valid("json").text), 201);
  },
);

router.openapi(
  createRoute({
    method: "get",
    path: "/statuses/{id}/comments",
    tags: ["statuses"],
    summary: "Owner sees every comment; anyone else sees only their own",
    security: bearerSecurity,
    request: { params },
    responses: { 200: jsonResponse(z.object({ comments: z.array(CommentSchema) }), "Comments"), ...notFound, ...authErrors },
  }),
  async (c) => c.json({ comments: await statuses.listComments(c.get("userId"), c.req.valid("param").id) }, 200),
);

export default router;
