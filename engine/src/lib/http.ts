import { OpenAPIHono, z, type RouteConfig } from "@hono/zod-openapi";
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";

export type AppEnv = {
  Variables: {
    userId: string;
    sessionId: string;
  };
};

export type AppContext = Context<AppEnv>;

/** Every router shares the same validation-error shape. */
export function createRouter() {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: {
              code: "VALIDATION_FAILED",
              message: "Request is invalid",
              details: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
            },
          },
          400,
        );
      }
    },
  });
}

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .openapi("Error");

export const jsonBody = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { "application/json": { schema } },
});

export const jsonResponse = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

export const errorResponse = (description: string) => jsonResponse(ErrorSchema, description);

/** Common error responses attached to authenticated routes. */
export const authErrors = {
  401: errorResponse("Missing, invalid or expired access token"),
  429: errorResponse("Rate limited"),
} satisfies RouteConfig["responses"];

export const noContent = { description: "Done" };

export const bearerSecurity = [{ bearer: [] }];

export function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const UuidParam = z.string().uuid();
