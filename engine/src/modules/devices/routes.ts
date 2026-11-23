import { createRoute, z } from "@hono/zod-openapi";
import { authErrors, bearerSecurity, createRouter, jsonBody, noContent } from "../../lib/http.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { prisma } from "../../lib/prisma.ts";

const router = createRouter();
router.use("/devices/*", requireAuth);

router.openapi(
  createRoute({
    method: "put",
    path: "/devices/push-token",
    tags: ["devices"],
    summary: "Register this device's Expo push token",
    security: bearerSecurity,
    request: {
      body: jsonBody(
        z.object({
          token: z.string().regex(/^(Exponent|Expo)PushToken\[.+\]$/, "Expected an Expo push token"),
          platform: z.enum(["ios", "android"]),
        }),
      ),
    },
    responses: { 204: noContent, ...authErrors },
  }),
  async (c) => {
    const { token, platform } = c.req.valid("json");
    const userId = c.get("userId");
    const sessionId = c.get("sessionId");
    await prisma.$transaction([
      // One token per session: a reinstall replaces the old one.
      prisma.pushToken.deleteMany({ where: { sessionId, token: { not: token } } }),
      prisma.pushToken.upsert({
        where: { token },
        create: { token, userId, sessionId, platform },
        update: { userId, sessionId, platform },
      }),
    ]);
    return c.body(null, 204);
  },
);

router.openapi(
  createRoute({
    method: "delete",
    path: "/devices/push-token",
    tags: ["devices"],
    summary: "Stop push notifications for this device",
    security: bearerSecurity,
    request: { body: jsonBody(z.object({ token: z.string() })) },
    responses: { 204: noContent, ...authErrors },
  }),
  async (c) => {
    await prisma.pushToken.deleteMany({ where: { token: c.req.valid("json").token, userId: c.get("userId") } });
    return c.body(null, 204);
  },
);

export default router;
