import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { env } from "./config/env.ts";
import { AppError } from "./lib/errors.ts";
import { logger } from "./lib/logger.ts";
import { prisma } from "./lib/prisma.ts";
import { redis } from "./lib/redis.ts";
import type { AppEnv } from "./lib/http.ts";
import authRoutes from "./modules/auth/routes.ts";
import userRoutes from "./modules/users/routes.ts";
import connectionRoutes from "./modules/connections/routes.ts";
import blockRoutes from "./modules/blocks/routes.ts";
import fileRoutes from "./modules/files/routes.ts";
import statusRoutes from "./modules/statuses/routes.ts";
import deviceRoutes from "./modules/devices/routes.ts";
import groupRoutes from "./modules/groups/routes.ts";

export const API_PREFIX = "/api/v1";

export const openApiInfo = {
  openapi: "3.1.0",
  info: {
    title: "Chat Engine API",
    version: "1.0.0",
    description:
      "REST API of the chat engine. Realtime messaging runs over Socket.IO at /socket.io/; see contracts/socket-events.md.",
  },
  servers: [{ url: API_PREFIX }],
};

export function buildApp() {
  const app = new OpenAPIHono<AppEnv>();

  const origins = env.CORS_ORIGINS.split(",").map((o) => o.trim());
  app.use("*", cors({ origin: origins.includes("*") ? "*" : origins, allowHeaders: ["Authorization", "Content-Type"] }));

  app.get("/health", async (c) => {
    const [db, cache] = await Promise.allSettled([prisma.$queryRaw`SELECT 1`, redis.ping()]);
    const ok = db.status === "fulfilled" && cache.status === "fulfilled";
    return c.json({ ok, db: db.status === "fulfilled", redis: cache.status === "fulfilled" }, ok ? 200 : 503);
  });

  const api = new OpenAPIHono<AppEnv>();
  for (const r of [authRoutes, userRoutes, connectionRoutes, blockRoutes, fileRoutes, statusRoutes, deviceRoutes, groupRoutes]) {
    api.route("/", r);
  }
  api.openAPIRegistry.registerComponent("securitySchemes", "bearer", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
  });
  api.doc31("/openapi.json", openApiInfo);
  app.route(API_PREFIX, api);

  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "No such route" } }, 404));

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
    }
    if (err instanceof HTTPException) {
      return c.json({ error: { code: err.status === 400 ? "BAD_REQUEST" : "INTERNAL", message: err.message } }, err.status);
    }
    logger.error({ err, path: c.req.path }, "unhandled error");
    return c.json({ error: { code: "INTERNAL", message: "Something went wrong" } }, 500);
  });

  return { app, api };
}
