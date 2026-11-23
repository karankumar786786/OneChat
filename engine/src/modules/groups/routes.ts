import { createRoute, z } from "@hono/zod-openapi";
import { authErrors, bearerSecurity, createRouter, errorResponse, jsonBody, jsonResponse, noContent } from "../../lib/http.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { consume } from "../../lib/rateLimit.ts";
import { PublicUserSchema } from "../users/dto.ts";
import * as groups from "./service.ts";

const Role = z.enum(["member", "admin"]);

const GroupSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable(),
    avatarFileId: z.string().uuid().nullable(),
    avatarUrl: z.string().url().nullable(),
    onlyAdminsCanSend: z.boolean(),
    onlyAdminsCanEditInfo: z.boolean(),
    createdById: z.string().uuid(),
    createdAt: z.string(),
    memberCount: z.number().int(),
    myRole: Role,
    mutedUntil: z.string().nullable(),
  })
  .openapi("GroupSummary");

const GroupMemberSchema = z
  .object({ user: PublicUserSchema, role: Role, joinedAt: z.string(), isCreator: z.boolean() })
  .openapi("GroupMember");

const GroupDetailsSchema = GroupSummarySchema.extend({ members: z.array(GroupMemberSchema) }).openapi("GroupDetails");

const InvitePreviewSchema = z
  .object({
    groupId: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable(),
    avatarFileId: z.string().uuid().nullable(),
    avatarUrl: z.string().url().nullable(),
    memberCount: z.number().int(),
    alreadyMember: z.boolean(),
  })
  .openapi("GroupInvitePreview");

const idParam = z.object({ id: z.string().uuid() });
const memberParam = z.object({ id: z.string().uuid(), userId: z.string().uuid() });
const codeParam = z.object({ code: z.string().min(8).max(32) });

const common = {
  ...authErrors,
  400: errorResponse("Invalid request"),
  403: errorResponse("Not allowed (e.g. admins only)"),
  404: errorResponse("Group not found or you are not a member"),
};

const router = createRouter();
router.use("/groups", requireAuth);
router.use("/groups/*", requireAuth);

router.openapi(
  createRoute({
    method: "post",
    path: "/groups",
    tags: ["groups"],
    summary: "Create a group. You become its admin; members must be people you have chatted with.",
    security: bearerSecurity,
    request: {
      body: jsonBody(
        z.object({
          name: z.string().trim().min(1).max(100),
          description: z.string().max(512).nullable().optional(),
          avatarFileId: z.string().uuid().nullable().optional(),
          memberIds: z.array(z.string().uuid()).min(1).max(groups.MAX_GROUP_SIZE - 1),
        }),
      ),
    },
    responses: { 201: jsonResponse(GroupDetailsSchema, "Created"), ...common },
  }),
  async (c) => {
    const me = c.get("userId");
    await consume("statusWrites", me);
    return c.json(await groups.createGroup(me, c.req.valid("json")), 201);
  },
);

router.openapi(
  createRoute({
    method: "get",
    path: "/groups",
    tags: ["groups"],
    summary: "Groups you are in",
    security: bearerSecurity,
    responses: { 200: jsonResponse(z.object({ groups: z.array(GroupSummarySchema) }), "Groups"), ...authErrors },
  }),
  async (c) => c.json({ groups: await groups.listGroups(c.get("userId")) }, 200),
);

router.openapi(
  createRoute({
    method: "get",
    path: "/groups/{id}",
    tags: ["groups"],
    summary: "Group info with members and their roles",
    security: bearerSecurity,
    request: { params: idParam },
    responses: { 200: jsonResponse(GroupDetailsSchema, "Group"), ...common },
  }),
  async (c) => c.json(await groups.groupDetails(c.get("userId"), c.req.valid("param").id), 200),
);

router.openapi(
  createRoute({
    method: "patch",
    path: "/groups/{id}",
    tags: ["groups"],
    summary: "Change name, description or icon (admins only when 'edit group info' is restricted)",
    security: bearerSecurity,
    request: {
      params: idParam,
      body: jsonBody(
        z.object({
          name: z.string().trim().min(1).max(100).optional(),
          description: z.string().max(512).nullable().optional(),
          avatarFileId: z.string().uuid().nullable().optional(),
        }),
      ),
    },
    responses: { 200: jsonResponse(GroupDetailsSchema, "Updated"), ...common },
  }),
  async (c) => c.json(await groups.updateInfo(c.get("userId"), c.req.valid("param").id, c.req.valid("json")), 200),
);

router.openapi(
  createRoute({
    method: "patch",
    path: "/groups/{id}/settings",
    tags: ["groups"],
    summary: "Admins: who can send messages and who can edit group info",
    security: bearerSecurity,
    request: {
      params: idParam,
      body: jsonBody(z.object({ onlyAdminsCanSend: z.boolean().optional(), onlyAdminsCanEditInfo: z.boolean().optional() })),
    },
    responses: { 200: jsonResponse(GroupDetailsSchema, "Updated"), ...common },
  }),
  async (c) => c.json(await groups.updateSettings(c.get("userId"), c.req.valid("param").id, c.req.valid("json")), 200),
);

router.openapi(
  createRoute({
    method: "post",
    path: "/groups/{id}/members",
    tags: ["groups"],
    summary: "Admins: add people you have chatted with",
    security: bearerSecurity,
    request: { params: idParam, body: jsonBody(z.object({ userIds: z.array(z.string().uuid()).min(1).max(groups.MAX_GROUP_SIZE) })) },
    responses: { 200: jsonResponse(GroupDetailsSchema, "Updated"), ...common },
  }),
  async (c) => c.json(await groups.addMembers(c.get("userId"), c.req.valid("param").id, c.req.valid("json").userIds), 200),
);

router.openapi(
  createRoute({
    method: "delete",
    path: "/groups/{id}/members/{userId}",
    tags: ["groups"],
    summary: "Admins: remove a member (the creator cannot be removed). Your own id means leave.",
    security: bearerSecurity,
    request: { params: memberParam },
    responses: { 204: noContent, ...common },
  }),
  async (c) => {
    const { id, userId } = c.req.valid("param");
    await groups.removeMember(c.get("userId"), id, userId);
    return c.body(null, 204);
  },
);

router.openapi(
  createRoute({
    method: "post",
    path: "/groups/{id}/admins/{userId}",
    tags: ["groups"],
    summary: "Admins: make a member an admin",
    security: bearerSecurity,
    request: { params: memberParam },
    responses: { 200: jsonResponse(GroupDetailsSchema, "Updated"), ...common },
  }),
  async (c) => {
    const { id, userId } = c.req.valid("param");
    return c.json(await groups.setRole(c.get("userId"), id, userId, "admin"), 200);
  },
);

router.openapi(
  createRoute({
    method: "delete",
    path: "/groups/{id}/admins/{userId}",
    tags: ["groups"],
    summary: "Admins: dismiss an admin (not the creator)",
    security: bearerSecurity,
    request: { params: memberParam },
    responses: { 200: jsonResponse(GroupDetailsSchema, "Updated"), ...common },
  }),
  async (c) => {
    const { id, userId } = c.req.valid("param");
    return c.json(await groups.setRole(c.get("userId"), id, userId, "member"), 200);
  },
);

router.openapi(
  createRoute({
    method: "post",
    path: "/groups/{id}/leave",
    tags: ["groups"],
    summary: "Leave the group. If you were the last admin, the longest-standing member becomes admin.",
    security: bearerSecurity,
    request: { params: idParam },
    responses: { 204: noContent, ...common },
  }),
  async (c) => {
    await groups.leaveGroup(c.get("userId"), c.req.valid("param").id);
    return c.body(null, 204);
  },
);

router.openapi(
  createRoute({
    method: "put",
    path: "/groups/{id}/mute",
    tags: ["groups"],
    summary: "Mute push notifications until a time (null to unmute). @mentions still notify.",
    security: bearerSecurity,
    request: { params: idParam, body: jsonBody(z.object({ until: z.string().datetime().nullable() })) },
    responses: { 200: jsonResponse(GroupSummarySchema, "Updated"), ...common },
  }),
  async (c) => {
    const { until } = c.req.valid("json");
    return c.json(await groups.setMute(c.get("userId"), c.req.valid("param").id, until ? new Date(until) : null), 200);
  },
);

router.openapi(
  createRoute({
    method: "get",
    path: "/groups/{id}/invite",
    tags: ["groups"],
    summary: "Admins: the group's invite code (created on first use)",
    security: bearerSecurity,
    request: { params: idParam },
    responses: { 200: jsonResponse(z.object({ code: z.string() }), "Invite code"), ...common },
  }),
  async (c) => c.json(await groups.getInvite(c.get("userId"), c.req.valid("param").id), 200),
);

router.openapi(
  createRoute({
    method: "post",
    path: "/groups/{id}/invite/reset",
    tags: ["groups"],
    summary: "Admins: replace the invite code; the old link stops working",
    security: bearerSecurity,
    request: { params: idParam },
    responses: { 200: jsonResponse(z.object({ code: z.string() }), "New invite code"), ...common },
  }),
  async (c) => c.json(await groups.getInvite(c.get("userId"), c.req.valid("param").id, { reset: true }), 200),
);

router.openapi(
  createRoute({
    method: "delete",
    path: "/groups/{id}/invite",
    tags: ["groups"],
    summary: "Admins: turn the invite link off",
    security: bearerSecurity,
    request: { params: idParam },
    responses: { 204: noContent, ...common },
  }),
  async (c) => {
    await groups.disableInvite(c.get("userId"), c.req.valid("param").id);
    return c.body(null, 204);
  },
);

router.openapi(
  createRoute({
    method: "get",
    path: "/groups/invite/{code}",
    tags: ["groups"],
    summary: "See which group an invite code is for, before joining",
    security: bearerSecurity,
    request: { params: codeParam },
    responses: { 200: jsonResponse(InvitePreviewSchema, "Preview"), ...common },
  }),
  async (c) => c.json(await groups.previewInvite(c.get("userId"), c.req.valid("param").code), 200),
);

router.openapi(
  createRoute({
    method: "post",
    path: "/groups/invite/{code}/join",
    tags: ["groups"],
    summary: "Join a group with an invite code",
    security: bearerSecurity,
    request: { params: codeParam },
    responses: { 200: jsonResponse(GroupDetailsSchema, "Joined"), ...common },
  }),
  async (c) => {
    const me = c.get("userId");
    await consume("statusWrites", me);
    return c.json(await groups.joinByInvite(me, c.req.valid("param").code), 200);
  },
);

export default router;
