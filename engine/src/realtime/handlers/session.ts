import { z } from "zod";
import { ack } from "../inbox.ts";
import { getPresence } from "../presence.ts";
import { isBlockedEitherWay } from "../../modules/blocks/service.ts";
import { isConnected } from "../../modules/connections/service.ts";
import { rooms } from "../io.ts";
import { tryConsume } from "../../lib/rateLimit.ts";
import { getGroupMeta, memberOf } from "../../modules/groups/cache.ts";
import { handle, type AppSocket } from "./util.ts";

const AckSchema = z.object({ eventIds: z.array(z.uuid()).max(1000) });
const PresenceQuerySchema = z.object({ userIds: z.array(z.uuid()).min(1).max(200) });
const TypingSchema = z.union([z.object({ to: z.uuid(), on: z.boolean() }), z.object({ groupId: z.uuid(), on: z.boolean() })]);

export function registerSessionHandlers(socket: AppSocket) {
  const me = socket.data.userId;

  handle(socket, "event:ack", AckSchema, async ({ eventIds }) => ({ removed: await ack(me, eventIds) }));

  handle(socket, "presence:query", PresenceQuerySchema, async ({ userIds }) => {
    const allowed: string[] = [];
    for (const id of new Set(userIds)) {
      if (id !== me && (await isConnected(me, id)) && !(await isBlockedEitherWay(me, id))) allowed.push(id);
    }
    return { presence: await getPresence(allowed) };
  });

  // Typing is fire-and-forget: never queued, dropped when the peer is offline.
  socket.on("typing", async (raw: unknown) => {
    const parsed = TypingSchema.safeParse(raw);
    if (!parsed.success || !(await tryConsume("socketEvents", me))) return;
    const data = parsed.data;
    if ("groupId" in data) {
      const meta = await getGroupMeta(data.groupId);
      if (!memberOf(meta, me)) return;
      const others = meta!.members.filter((m) => m.userId !== me).map((m) => rooms.user(m.userId));
      if (others.length) socket.to(others).volatile.emit("typing", { from: me, on: data.on, groupId: data.groupId });
      return;
    }
    const { to, on } = data;
    if (to === me) return;
    if (!(await isConnected(me, to)) || (await isBlockedEitherWay(me, to))) return;
    socket.to(rooms.user(to)).volatile.emit("typing", { from: me, on });
  });
}
