import { Server } from "socket.io";
import { Server as Engine } from "@socket.io/bun-engine";
import { createAdapter } from "@socket.io/redis-adapter";
import { redisPub, redisSub } from "../lib/redis.ts";
import { prisma } from "../lib/prisma.ts";
import { AppError, unauthorized } from "../lib/errors.ts";
import { logger } from "../lib/logger.ts";
import { authenticateToken } from "../middleware/auth.ts";
import { rooms, setIo } from "./io.ts";
import { HEARTBEAT_MS, heartbeat, socketOffline, socketOnline } from "./presence.ts";
import { drain } from "./inbox.ts";
import { registerMessageHandlers } from "./handlers/message.ts";
import { registerSessionHandlers } from "./handlers/session.ts";
import type { AppSocket } from "./handlers/util.ts";
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from "./types.ts";

export const SOCKET_PATH = "/socket.io/";

export function createRealtime() {
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>({
    serveClient: false,
    adapter: createAdapter(redisPub, redisSub),
  });
  const engine = new Engine({
    path: SOCKET_PATH,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 256 * 1024,
  });
  io.bind(engine);

  io.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth as { token?: string } | undefined)?.token;
      const claims = await authenticateToken(token);
      const user = await prisma.user.findUnique({ where: { id: claims.sub }, select: { id: true, username: true } });
      if (!user) throw unauthorized("Account not found");
      if (!user.username) throw new AppError(403, "USERNAME_REQUIRED", "Pick a username first");
      socket.data = { userId: user.id, sessionId: claims.sid, username: user.username };
      next();
    } catch (err) {
      const e = new Error(err instanceof Error ? err.message : "Unauthorized") as Error & { data?: unknown };
      e.data = { code: err instanceof AppError ? err.code : "UNAUTHORIZED" };
      next(e);
    }
  });

  io.on("connection", (socket: AppSocket) => {
    const { userId, sessionId } = socket.data;

    // Handlers first, so nothing the client sends right after connecting is missed.
    registerMessageHandlers(socket);
    registerSessionHandlers(socket);

    void socket.join([rooms.user(userId), rooms.session(sessionId)]);

    const beat = setInterval(() => {
      heartbeat(userId, socket.id).catch((err) => logger.warn({ err }, "presence heartbeat failed"));
    }, HEARTBEAT_MS);

    socket.on("disconnect", () => {
      clearInterval(beat);
      socketOffline(userId, socket.id).catch((err) => logger.warn({ err }, "presence offline failed"));
    });

    (async () => {
      await socketOnline(userId, socket.id);
      await drain(socket, userId);
    })().catch((err) => logger.error({ err, userId }, "socket setup failed"));
  });

  setIo(io);
  return { io, engine };
}
