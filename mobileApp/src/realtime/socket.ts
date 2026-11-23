import { io, type Socket } from "socket.io-client";
import { Alert } from "react-native";
import { API_URL } from "../config";
import { useAuth } from "../auth/store";
import { getDb } from "../db";
import { emitDbChange } from "../db/changes";
import { addToOutbox, ensureChat, listOutbox, markSeen, removeFromOutbox, setTick, unseenIncoming } from "../db/queries";
import { markNotMember, saveGroup } from "../db/groups";
import { applyEvents, recomputeGroupTick } from "./apply";
import { useRealtime } from "./store";
import type { Ack, Envelope, PresenceState, SendMessage } from "./events";
import { api } from "../api/client";
import { queryClient } from "../lib/queryClient";

/** Errors that will never succeed on retry: the message is marked failed instead of retried. */
const FINAL_ERRORS = new Set(["VALIDATION_FAILED", "BAD_REQUEST", "FORBIDDEN", "NOT_FOUND", "GONE"]);

let socket: Socket | null = null;
// Event batches are applied strictly one after another.
let chain: Promise<unknown> = Promise.resolve();

export function getSocket() {
  return socket;
}

export function startRealtime() {
  if (socket) return;
  const s = io(API_URL, {
    path: "/socket.io/",
    transports: ["websocket"],
    // Called on every (re)connect, so a refreshed token is always used.
    auth: (cb) => {
      useAuth
        .getState()
        .getFreshAccessToken()
        .then((token) => cb({ token }));
    },
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
  });
  socket = s;

  s.on("connect", () => {
    useRealtime.getState().setConnected(true);
    void flushOutbox();
    void refreshPresence();
  });
  s.on("disconnect", (reason) => {
    useRealtime.getState().setConnected(false);
    // Socket.IO does not reconnect by itself after a server-side disconnect; do it unless we were stopped.
    if (reason === "io server disconnect") setTimeout(() => socket === s && s.connect(), 1000);
  });

  s.on("connect_error", async (err: Error & { data?: { code?: string } }) => {
    const code = err.data?.code;
    if (code === "TOKEN_EXPIRED") {
      if (await useAuth.getState().refresh()) s.connect();
    } else if (code === "SESSION_REVOKED" || code === "UNAUTHORIZED") {
      await useAuth.getState().signOut({ remote: false, reason: "You were signed out." });
    } else if (!s.active) {
      // Refused by the server for another reason; try again shortly.
      setTimeout(() => s.connect(), 5000);
    }
  });

  s.on("events", (events: Envelope[], cb?: (r: { eventIds: string[] }) => void) => {
    chain = chain.then(() => handleEvents(events, cb)).catch((err) => console.warn("event batch failed", err));
  });

  s.on("presence:update", (p: PresenceState) => useRealtime.getState().setPresence([p]));
  s.on("typing", (t: { from: string; on: boolean; groupId?: string }) => useRealtime.getState().setTyping(t.from, t.on, t.groupId));

  for (const ev of ["status:new", "status:deleted"]) s.on(ev, () => queryClient.invalidateQueries({ queryKey: ["statusFeed"] }));
  for (const ev of ["status:viewed", "status:reaction", "status:comment"]) {
    s.on(ev, (d: { statusId: string }) => {
      void queryClient.invalidateQueries({ queryKey: ["myStatuses"] });
      void queryClient.invalidateQueries({ queryKey: ["status", d.statusId] });
    });
  }

  s.on("session:revoked", async (d: { reason: string }) => {
    const why = d.reason === "signed_in_elsewhere" ? "Your account was opened on another device." : "You were signed out.";
    await useAuth.getState().signOut({ remote: false, reason: why });
    Alert.alert("Signed out", why);
  });
}

export function stopRealtime() {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
  useRealtime.getState().setConnected(false);
}

async function handleEvents(events: Envelope[], cb?: (r: { eventIds: string[] }) => void) {
  const db = getDb();
  const activePeerId = useRealtime.getState().activePeerId;
  // Saved to SQLite first; only then acked, so nothing is lost if the app dies mid-way.
  const res = await applyEvents(db, events, { activePeerId, myId: useAuth.getState().me?.id ?? null });
  const eventIds = events.map((e) => e.eventId);
  if (typeof cb === "function") cb({ eventIds });
  else socket?.emit("event:ack", { eventIds });

  if (activePeerId && res.newIncoming.has(activePeerId)) await markChatRead(activePeerId);
  for (const peerId of res.unknownPeers) void loadPeerProfile(peerId);
  for (const groupId of res.refreshGroups) void loadGroup(groupId);
  if (res.unknownPeers.size) void queryPresence([...res.unknownPeers]);
  if (res.changedPeers.size) emitDbChange(res.changedPeers);
}

async function loadPeerProfile(peerId: string) {
  const { data } = await api.GET("/users/{id}", { params: { path: { id: peerId } } });
  if (!data) return;
  await ensureChat(getDb(), peerId, data);
  emitDbChange([peerId]);
}

/** Fetches a group's details (name, members, roles) into the local DB. */
export async function loadGroup(groupId: string) {
  const { data, response } = await api.GET("/groups/{id}", { params: { path: { id: groupId } } });
  const db = getDb();
  if (data) await saveGroup(db, data);
  else if (response.status === 404) await markNotMember(db, groupId);
  emitDbChange([groupId]);
}

/** Pulls the list of groups you are in (after a reinstall the server is the only source). */
export async function syncGroups() {
  const { data } = await api.GET("/groups");
  if (!data) return;
  const db = getDb();
  for (const g of data.groups) await saveGroup(db, g);
  emitDbChange(data.groups.map((g) => g.id));
}

/** Sends blue ticks for everything unread in this chat (in a group: one receipt per sender). */
export async function markChatRead(peerId: string) {
  const db = getDb();
  const unseen = await unseenIncoming(db, peerId);
  await markSeen(db, peerId, unseen.map((u) => u.id));
  emitDbChange([peerId]);
  const chat = await db.first<{ kind: string }>("SELECT kind FROM chats WHERE peerId = ?", [peerId]);
  if (chat?.kind === "group") {
    const bySender = new Map<string, string[]>();
    for (const u of unseen) if (u.senderId) bySender.set(u.senderId, [...(bySender.get(u.senderId) ?? []), u.id]);
    for (const [senderId, ids] of bySender) {
      for (let i = 0; i < ids.length; i += 500) {
        socket?.emit("message:read", { groupId: peerId, senderId, messageIds: ids.slice(i, i + 500) });
      }
    }
    return;
  }
  const ids = unseen.map((u) => u.id);
  for (let i = 0; i < ids.length; i += 500) {
    socket?.emit("message:read", { peerId, messageIds: ids.slice(i, i + 500) });
  }
}

/** Queues a message locally, then tries to send it. Survives app restarts via the outbox. */
export async function sendMessage(msg: SendMessage) {
  await addToOutbox(getDb(), msg.id, msg);
  await trySend(msg);
}

async function trySend(msg: SendMessage) {
  if (!socket?.connected) return;
  try {
    const ack = (await socket.timeout(10_000).emitWithAck("message:send", msg)) as Ack<{ serverTs: string; recipients?: string[] }>;
    const db = getDb();
    if (ack.ok) {
      await setTick(db, msg.id, "sent", ack.serverTs);
      await removeFromOutbox(db, msg.id);
      if (msg.groupId) {
        // Group ticks are worked out from per-member receipts against this list.
        await db.run("UPDATE messages SET recipientsJson = ? WHERE id = ?", [JSON.stringify(ack.recipients ?? []), msg.id]);
        await recomputeGroupTick(db, msg.id);
      } else if (msg.to && !useRealtime.getState().presence[msg.to]) {
        void queryPresence([msg.to]);
      }
    } else if (FINAL_ERRORS.has(ack.error.code)) {
      await setTick(db, msg.id, "failed");
      await removeFromOutbox(db, msg.id);
    }
    emitDbChange([msg.groupId ?? msg.to!]);
  } catch {
    // Timed out: stays in the outbox and is retried on the next connect.
  }
}

async function flushOutbox() {
  const items = await listOutbox(getDb());
  for (const item of items) await trySend(JSON.parse(item.payload) as SendMessage);
}

async function refreshPresence() {
  const rows = await getDb().all<{ peerId: string }>("SELECT peerId FROM chats LIMIT 200");
  await queryPresence(rows.map((r) => r.peerId));
}

/** Asks for the current online state of these users (only connections are answered). */
export async function queryPresence(userIds: string[]) {
  if (!userIds.length || !socket?.connected) return;
  try {
    const ack = (await socket.timeout(5000).emitWithAck("presence:query", { userIds })) as Ack<{ presence: PresenceState[] }>;
    if (ack.ok) useRealtime.getState().setPresence(ack.presence);
  } catch {}
}

export function emitTyping(chat: { id: string; kind: "direct" | "group" }, on: boolean) {
  socket?.emit("typing", chat.kind === "group" ? { groupId: chat.id, on } : { to: chat.id, on });
}

export async function emitAck<T extends object>(event: string, data: unknown): Promise<Ack<T>> {
  if (!socket?.connected) return { ok: false, error: { code: "OFFLINE", message: "You are offline" } };
  try {
    return (await socket.timeout(8000).emitWithAck(event, data)) as Ack<T>;
  } catch {
    return { ok: false, error: { code: "TIMEOUT", message: "No answer from the server" } };
  }
}
