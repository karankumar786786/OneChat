import type { Server } from "socket.io";

/**
 * Holds the Socket.IO server so REST handlers and jobs can emit events
 * without importing the realtime bootstrap (avoids import cycles).
 * With the Redis adapter, emits reach sockets on every engine instance.
 */
let io: Server | null = null;

export function setIo(server: Server | null) {
  io = server;
}

export function getIo(): Server | null {
  return io;
}

export const rooms = {
  user: (userId: string) => `user:${userId}`,
  session: (sessionId: string) => `session:${sessionId}`,
};

export function emitToUsers(userIds: string[], event: string, payload: unknown) {
  if (!io || userIds.length === 0) return;
  io.to(userIds.map(rooms.user)).emit(event, payload);
}
