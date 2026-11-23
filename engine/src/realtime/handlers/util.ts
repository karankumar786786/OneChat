import type { Socket } from "socket.io";
import type { z } from "zod";
import { AppError } from "../../lib/errors.ts";
import { tryConsume, type LimiterName } from "../../lib/rateLimit.ts";
import { logger } from "../../lib/logger.ts";
import type { Ack, ClientToServerEvents, ServerToClientEvents, SocketData } from "../types.ts";

export type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

/**
 * Registers a socket event with rate limiting, zod validation and a uniform ack shape:
 * { ok: true, ...result } or { ok: false, error: { code, message } }.
 */
export function handle<S extends z.ZodType, R extends object>(
  socket: AppSocket,
  event: keyof ClientToServerEvents,
  schema: S,
  fn: (data: z.infer<S>) => Promise<R>,
  opts: { limiter?: LimiterName } = {},
) {
  const reply = (ack: unknown, res: Ack<R>) => {
    if (typeof ack === "function") (ack as (r: Ack<R>) => void)(res);
  };
  (socket as unknown as Socket).on(event, async (raw: unknown, ack?: unknown) => {
    try {
      const limiter = opts.limiter ?? "socketEvents";
      if (!(await tryConsume(limiter, socket.data.userId))) {
        return reply(ack, { ok: false, error: { code: "RATE_LIMITED", message: "Slow down" } });
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        return reply(ack, {
          ok: false,
          error: { code: "VALIDATION_FAILED", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
        });
      }
      reply(ack, { ok: true, ...(await fn(parsed.data)) });
    } catch (err) {
      if (err instanceof AppError) return reply(ack, { ok: false, error: { code: err.code, message: err.message } });
      logger.error({ err, event, userId: socket.data.userId }, "socket handler failed");
      reply(ack, { ok: false, error: { code: "INTERNAL", message: "Something went wrong" } });
    }
  });
}
