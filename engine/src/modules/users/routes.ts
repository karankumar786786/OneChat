import { createRoute, z } from "@hono/zod-openapi";
import { authErrors, bearerSecurity, createRouter, errorResponse, jsonBody, jsonResponse } from "../../lib/http.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { consume } from "../../lib/rateLimit.ts";
import { prisma } from "../../lib/prisma.ts";
import { notFound } from "../../lib/errors.ts";
import { MeSchema, PublicUserSchema, toMe, toPublicUser, toPublicUsers } from "./dto.ts";
import * as users from "./service.ts";

const router = createRouter();
router.use("/me", requireAuth);
router.use("/me/*", requireAuth);
router.use("/users/*", requireAuth);

async function loadMe(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound("Account not found");
  return toMe(user);
}

router.openapi(
  createRoute({
    method: "get",
    path: "/me",
    tags: ["users"],
    summary: "Your own profile. username is null until you set one.",
    security: bearerSecurity,
    responses: { 200: jsonResponse(MeSchema, "Profile"), ...authErrors },
  }),
  async (c) => c.json(await loadMe(c.get("userId")), 200),
);

router.openapi(
  createRoute({
    method: "patch",
    path: "/me",
    tags: ["users"],
    summary: "Update name, About line or profile photo (avatarFileId from a finished avatar upload, or null to remove)",
    security: bearerSecurity,
    request: {
      body: jsonBody(
        z.object({
          displayName: z.string().max(50).nullable().optional(),
          about: z.string().max(140).nullable().optional(),
          avatarFileId: z.string().uuid().nullable().optional(),
        }),
      ),
    },
    responses: { 200: jsonResponse(MeSchema, "Updated profile"), 400: errorResponse("Invalid avatar"), ...authErrors },
  }),
  async (c) => {
    const user = await users.updateProfile(c.get("userId"), c.req.valid("json"));
    return c.json(await toMe(user), 200);
  },
);

router.openapi(
  createRoute({
    method: "put",
    path: "/me/username",
    tags: ["users"],
    summary: "Set or change your unique username",
    security: bearerSecurity,
    request: { body: jsonBody(z.object({ username: z.string().min(1).max(32) })) },
    responses: {
      200: jsonResponse(MeSchema, "Updated profile"),
      400: errorResponse("Username not allowed"),
      409: errorResponse("Username taken (USERNAME_TAKEN)"),
      ...authErrors,
    },
  }),
  async (c) => {
    const user = await users.setUsername(c.get("userId"), c.req.valid("json").username);
    return c.json(await toMe(user), 200);
  },
);

router.openapi(
  createRoute({
    method: "get",
    path: "/users/username-available",
    tags: ["users"],
    summary: "Check whether a username can be taken",
    security: bearerSecurity,
    request: { query: z.object({ u: z.string().min(1).max(32) }) },
    responses: {
      200: jsonResponse(
        z.object({ username: z.string(), available: z.boolean(), reason: z.string().nullable() }),
        "Availability",
      ),
      ...authErrors,
    },
  }),
  async (c) => {
    await consume("usernameCheck", c.get("userId"));
    return c.json(await users.usernameAvailability(c.req.valid("query").u, c.get("userId")), 200);
  },
);

router.openapi(
  createRoute({
    method: "get",
    path: "/users/search",
    tags: ["users"],
    summary: "Find people by username prefix or name (\"@abc\" = usernames only)",
    security: bearerSecurity,
    request: {
      query: z.object({
        q: z.string().min(1).max(32),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      }),
    },
    responses: { 200: jsonResponse(z.object({ users: z.array(PublicUserSchema) }), "Matches"), ...authErrors },
  }),
  async (c) => {
    const me = c.get("userId");
    await consume("search", me);
    const { q, limit } = c.req.valid("query");
    return c.json({ users: await toPublicUsers(await users.searchUsers(me, q, limit)) }, 200);
  },
);

router.openapi(
  createRoute({
    method: "get",
    path: "/users/by-username/{username}",
    tags: ["users"],
    summary: "Look up a user by exact username",
    security: bearerSecurity,
    request: { params: z.object({ username: z.string().min(1).max(32) }) },
    responses: { 200: jsonResponse(PublicUserSchema, "User"), 404: errorResponse("Not found"), ...authErrors },
  }),
  async (c) => {
    const username = users.normalizeUsername(c.req.valid("param").username);
    return c.json(await toPublicUser(await users.getVisibleUser(c.get("userId"), { username })), 200);
  },
);

const ProfileSchema = z
  .object({
    user: PublicUserSchema,
    isMe: z.boolean(),
    isConnected: z.boolean(),
    blockedByMe: z.boolean(),
    online: z.boolean().nullable().openapi({ description: "null when you can't see their presence" }),
    lastSeenAt: z.string().nullable(),
    commonGroups: z.array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        avatarFileId: z.string().uuid().nullable(),
        avatarUrl: z.string().url().nullable(),
        memberCount: z.number().int(),
      }),
    ),
  })
  .openapi("UserProfile");

router.openapi(
  createRoute({
    method: "get",
    path: "/users/{id}/profile",
    tags: ["users"],
    summary: "Profile screen: user, About, online/last seen, groups in common, block state",
    security: bearerSecurity,
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: { 200: jsonResponse(ProfileSchema, "Profile"), 404: errorResponse("Not found"), ...authErrors },
  }),
  async (c) => c.json(await users.userProfile(c.get("userId"), c.req.valid("param").id), 200),
);

router.openapi(
  createRoute({
    method: "get",
    path: "/users/{id}",
    tags: ["users"],
    summary: "Look up a user by id (e.g. the sender of an incoming message)",
    security: bearerSecurity,
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: { 200: jsonResponse(PublicUserSchema, "User"), 404: errorResponse("Not found"), ...authErrors },
  }),
  async (c) => c.json(await toPublicUser(await users.getVisibleUser(c.get("userId"), { id: c.req.valid("param").id })), 200),
);

export default router;
