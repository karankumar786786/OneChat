import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../lib/http.ts";
import { verifyAccessToken } from "../lib/jwt.ts";
import { unauthorized } from "../lib/errors.ts";
import { isSessionRevoked } from "../modules/auth/sessions.ts";

export async function authenticateToken(token: string | undefined) {
  if (!token) throw unauthorized();
  const claims = await verifyAccessToken(token);
  if (await isSessionRevoked(claims.sid)) {
    throw unauthorized("This session was signed out", "SESSION_REVOKED");
  }
  return claims;
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const claims = await authenticateToken(token);
  c.set("userId", claims.sub);
  c.set("sessionId", claims.sid);
  await next();
});
