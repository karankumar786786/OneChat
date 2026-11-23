import { api } from "./api/client";
import { useAuth } from "./auth/store";
import { closeUserDb, getDb, openUserDb } from "./db";
import { emitDbChange } from "./db/changes";
import { ensureChat } from "./db/queries";
import { queryClient } from "./lib/queryClient";
import { startRealtime, stopRealtime, syncGroups } from "./realtime/socket";
import { useRealtime } from "./realtime/store";
import { registerForPush } from "./notifications";

/** Everything that happens once a signed-in user with a username opens the app. */
export async function startSession(userId: string) {
  await openUserDb(userId);
  startRealtime();
  void refreshMe();
  void syncConnections();
  void syncGroups();
  void registerForPush();
}

/** The saved profile can be stale (e.g. avatar URL expired); fetch a fresh one. */
async function refreshMe() {
  const { data } = await api.GET("/me");
  if (data) await useAuth.getState().setMe(data);
}

export async function endSession() {
  stopRealtime();
  queryClient.clear();
  await closeUserDb();
}

/**
 * Brings the server's connection list into the local chat list. After a reinstall the
 * history is gone (the server never had it), but the people you talk to come back.
 */
export async function syncConnections() {
  const { data } = await api.GET("/connections");
  if (!data) return;
  const db = getDb();
  for (const c of data.connections) await ensureChat(db, c.user.id, c.user);
  useRealtime.getState().setPresence(
    data.connections.map((c) => ({ userId: c.user.id, online: c.online, lastSeenAt: c.lastSeenAt })),
  );
  emitDbChange(data.connections.map((c) => c.user.id));
}
