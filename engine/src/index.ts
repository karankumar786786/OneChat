import { env } from "./config/env.ts";
import { buildApp } from "./app.ts";
import { createRealtime, SOCKET_PATH } from "./realtime/server.ts";
import { setIo } from "./realtime/io.ts";
import { closeJobs, scheduleMaintenance, startWorkers } from "./jobs/queue.ts";
import { logger } from "./lib/logger.ts";
import { prisma } from "./lib/prisma.ts";
import { closeRedis, redis } from "./lib/redis.ts";

export async function startServer(opts: { port?: number; workers?: boolean } = {}) {
  await redis.connect().catch((err) => {
    if (!String(err?.message).includes("already")) throw err;
  });

  const { app } = buildApp();
  const { io, engine } = createRealtime();
  const socketHandler = engine.handler();

  const server = Bun.serve({
    port: opts.port ?? env.PORT,
    idleTimeout: socketHandler.idleTimeout,
    maxRequestBodySize: 2 * 1024 * 1024,
    websocket: socketHandler.websocket,
    fetch(req, srv) {
      if (new URL(req.url).pathname.startsWith(SOCKET_PATH)) return engine.handleRequest(req, srv);
      return app.fetch(req, srv);
    },
  });

  const runWorkers = opts.workers ?? env.RUN_WORKERS;
  if (runWorkers) {
    await scheduleMaintenance();
    startWorkers();
  }

  logger.info({ port: server.port, workers: runWorkers }, "chat engine listening");

  async function stop() {
    // io.close() drops connections without a "you were disconnected" packet, so clients
    // treat it as a network blip and reconnect (to this instance after a restart, or another one).
    await new Promise<void>((resolve) => io.close(() => resolve()));
    setIo(null);
    server.stop(true);
    await closeJobs();
  }

  return { server, io, port: server.port!, stop };
}

if (import.meta.main) {
  const { stop } = await startServer();
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    await stop();
    await prisma.$disconnect();
    await closeRedis();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
