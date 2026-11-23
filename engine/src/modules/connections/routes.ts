import { createRoute, z } from "@hono/zod-openapi";
import { authErrors, bearerSecurity, createRouter, jsonResponse } from "../../lib/http.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { PublicUserSchema, toPublicUsers } from "../users/dto.ts";
import { listConnections } from "./service.ts";
import { blockedEitherWayIds, listBlocked } from "../blocks/service.ts";
import { getPresence } from "../../realtime/presence.ts";

const ConnectionSchema = z
  .object({
    user: PublicUserSchema,
    connectedAt: z.string(),
    online: z.boolean(),
    lastSeenAt: z.string().nullable(),
    blockedByMe: z.boolean(),
  })
  .openapi("Connection");

const router = createRouter();
router.use("/connections", requireAuth);

router.openapi(
  createRoute({
    method: "get",
    path: "/connections",
    tags: ["connections"],
    summary: "Everyone you have chatted with, with their online state",
    security: bearerSecurity,
    responses: { 200: jsonResponse(z.object({ connections: z.array(ConnectionSchema) }), "Connections"), ...authErrors },
  }),
  async (c) => {
    const me = c.get("userId");
    const [rows, hidden, blockedByMe] = await Promise.all([
      listConnections(me),
      blockedEitherWayIds(me),
      listBlocked(me).then((u) => new Set(u.map((x) => x.id))),
    ]);
    const users = await toPublicUsers(rows.map((r) => r.user));
    const visible = rows.filter((r) => !hidden.has(r.user.id));
    const presence = new Map(
      (await getPresence(visible.map((r) => r.user.id), new Map(visible.map((r) => [r.user.id, r.user.lastSeenAt])))).map(
        (p) => [p.userId, p],
      ),
    );
    return c.json(
      {
        connections: rows.map((r, i) => {
          const p = presence.get(r.user.id);
          return {
            user: users[i]!,
            connectedAt: r.connectedAt.toISOString(),
            online: p?.online ?? false,
            lastSeenAt: p?.lastSeenAt ?? null,
            blockedByMe: blockedByMe.has(r.user.id),
          };
        }),
      },
      200,
    );
  },
);

export default router;
