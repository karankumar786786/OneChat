import { createRoute, z } from "@hono/zod-openapi";
import {
  authErrors,
  bearerSecurity,
  clientIp,
  createRouter,
  errorResponse,
  jsonBody,
  jsonResponse,
  noContent,
} from "../../lib/http.ts";
import { consume } from "../../lib/rateLimit.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { MeSchema } from "../users/dto.ts";
import * as auth from "./service.ts";

const TokensSchema = z
  .object({
    accessToken: z.string(),
    accessTokenExpiresAt: z.string(),
    refreshToken: z.string(),
    refreshTokenExpiresAt: z.string(),
  })
  .openapi("Tokens");

const AuthResultSchema = z.object({ user: MeSchema, tokens: TokensSchema }).openapi("AuthResult");

const CredentialsSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(8, "Password must be at least 8 characters").max(128),
    deviceId: z.string().max(100).optional(),
  })
  .openapi("Credentials");

const router = createRouter();

router.openapi(
  createRoute({
    method: "post",
    path: "/auth/register",
    tags: ["auth"],
    summary: "Create an account with email and password",
    request: { body: jsonBody(CredentialsSchema) },
    responses: {
      201: jsonResponse(AuthResultSchema, "Account created and signed in"),
      400: errorResponse("Invalid input"),
      409: errorResponse("Email already registered (EMAIL_TAKEN)"),
      429: errorResponse("Rate limited"),
    },
  }),
  async (c) => {
    await consume("authByIp", clientIp(c));
    const result = await auth.register(c.req.valid("json"));
    return c.json(result, 201);
  },
);

router.openapi(
  createRoute({
    method: "post",
    path: "/auth/login",
    tags: ["auth"],
    summary: "Sign in. Signs out any other device (one active device per account).",
    request: { body: jsonBody(CredentialsSchema) },
    responses: {
      200: jsonResponse(AuthResultSchema, "Signed in"),
      401: errorResponse("Wrong email or password (INVALID_CREDENTIALS)"),
      429: errorResponse("Rate limited"),
    },
  }),
  async (c) => {
    await consume("authByIp", clientIp(c));
    return c.json(await auth.login(c.req.valid("json")), 200);
  },
);

router.openapi(
  createRoute({
    method: "post",
    path: "/auth/refresh",
    tags: ["auth"],
    summary: "Swap a refresh token for a new token pair. Each refresh token works once.",
    request: { body: jsonBody(z.object({ refreshToken: z.string().min(10) })) },
    responses: {
      200: jsonResponse(z.object({ tokens: TokensSchema }), "New tokens"),
      401: errorResponse("Unknown, expired, revoked or reused token"),
    },
  }),
  async (c) => {
    await consume("authByIp", clientIp(c));
    return c.json({ tokens: await auth.refresh(c.req.valid("json").refreshToken) }, 200);
  },
);

router.openapi(
  createRoute({
    method: "post",
    path: "/auth/logout",
    tags: ["auth"],
    summary: "Sign out the current session",
    security: bearerSecurity,
    middleware: [requireAuth] as const,
    responses: { 204: noContent, ...authErrors },
  }),
  async (c) => {
    await auth.logout(c.get("sessionId"));
    return c.body(null, 204);
  },
);

export default router;
