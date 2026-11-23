import { createRoute, z } from "@hono/zod-openapi";
import { authErrors, bearerSecurity, createRouter, errorResponse, jsonResponse, noContent } from "../../lib/http.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { PublicUserSchema, toPublicUsers } from "../users/dto.ts";
import * as blocks from "./service.ts";

const params = z.object({ userId: z.string().uuid() });

const router = createRouter();
router.use("/blocks", requireAuth);
router.use("/blocks/*", requireAuth);

router.openapi(
  createRoute({
    method: "get",
    path: "/blocks",
    tags: ["blocks"],
    summary: "Users you have blocked",
    security: bearerSecurity,
    responses: { 200: jsonResponse(z.object({ users: z.array(PublicUserSchema) }), "Blocked users"), ...authErrors },
  }),
  async (c) => c.json({ users: await toPublicUsers(await blocks.listBlocked(c.get("userId"))) }, 200),
);

router.openapi(
  createRoute({
    method: "post",
    path: "/blocks/{userId}",
    tags: ["blocks"],
    summary: "Block a user. They can no longer message you, find you, or see your presence and statuses.",
    security: bearerSecurity,
    request: { params },
    responses: { 204: noContent, 400: errorResponse("Cannot block yourself"), 404: errorResponse("No such user"), ...authErrors },
  }),
  async (c) => {
    await blocks.block(c.get("userId"), c.req.valid("param").userId);
    return c.body(null, 204);
  },
);

router.openapi(
  createRoute({
    method: "delete",
    path: "/blocks/{userId}",
    tags: ["blocks"],
    summary: "Unblock a user",
    security: bearerSecurity,
    request: { params },
    responses: { 204: noContent, ...authErrors },
  }),
  async (c) => {
    await blocks.unblock(c.get("userId"), c.req.valid("param").userId);
    return c.body(null, 204);
  },
);

export default router;
