import { z } from "zod";
import { prisma } from "../../lib/prisma.ts";
import { redis } from "../../lib/redis.ts";
import { AppError, badRequest } from "../../lib/errors.ts";
import { hasBlocked, isBlockedEitherWay } from "../../modules/blocks/service.ts";
import { ensureConnection, isConnected } from "../../modules/connections/service.ts";
import { shareFile } from "../../modules/files/service.ts";
import { getGroupMeta, memberOf, type GroupMeta } from "../../modules/groups/cache.ts";
import { enqueue, enqueueMany } from "../inbox.ts";
import { getPresence, isOnline } from "../presence.ts";
import { queuePush } from "../../jobs/queue.ts";
import { previewFor } from "../../jobs/sendPush.ts";
import { handle, type AppSocket } from "./util.ts";

const MAX_TEXT = 4000;
const DEDUPE_TTL_SECONDS = 7 * 86_400;

/** Exactly one of `to` (a person) or `groupId`. */
const oneTarget = (d: { to?: string; peerId?: string; groupId?: string }) => Boolean(d.to ?? d.peerId) !== Boolean(d.groupId);

const SendSchema = z
  .object({
    id: z.uuid(),
    to: z.uuid().optional(),
    groupId: z.uuid().optional(),
    kind: z.enum(["text", "file"]),
    text: z.string().max(MAX_TEXT).optional(),
    fileId: z.uuid().optional(),
    replyTo: z.uuid().optional(),
    forwarded: z.boolean().optional(),
  })
  .refine(oneTarget, { message: "send to exactly one of `to` or `groupId`" })
  .refine((d) => (d.kind === "text" ? Boolean(d.text?.trim()) : Boolean(d.fileId)), {
    message: "text messages need text; file messages need fileId",
  });

const ReadSchema = z.union([
  z.object({ peerId: z.uuid(), messageIds: z.array(z.uuid()).min(1).max(500) }),
  // In a group, read receipts go to each message's sender, so the client sends one per sender.
  z.object({ groupId: z.uuid(), senderId: z.uuid(), messageIds: z.array(z.uuid()).min(1).max(500) }),
]);
const ReactSchema = z
  .object({ peerId: z.uuid().optional(), groupId: z.uuid().optional(), messageId: z.uuid(), emoji: z.string().min(1).max(16).nullable() })
  .refine(oneTarget, { message: "give exactly one of `peerId` or `groupId`" });
const DeleteSchema = z
  .object({ peerId: z.uuid().optional(), groupId: z.uuid().optional(), messageId: z.uuid(), asAdmin: z.boolean().optional() })
  .refine(oneTarget, { message: "give exactly one of `peerId` or `groupId`" });

const dedupeKey = (senderId: string, messageId: string) => `msg-seen:${senderId}:${messageId}`;

type SendResult = { messageId: string; serverTs: string; recipients?: string[] };

/** Read receipts, reactions and deletes only make sense between connected users with no block. */
async function canInteract(me: string, peerId: string) {
  if (me === peerId) return false;
  if (!(await isConnected(me, peerId))) return false;
  return !(await isBlockedEitherWay(me, peerId));
}

async function requireGroupMember(me: string, groupId: string): Promise<GroupMeta & { myRole: "member" | "admin" }> {
  const meta = await getGroupMeta(groupId);
  const mine = memberOf(meta, me);
  if (!meta || !mine) throw new AppError(404, "NOT_FOUND", "Group not found");
  return { ...meta, myRole: mine.role };
}

function othersIn(meta: GroupMeta, me: string) {
  return meta.members.filter((m) => m.userId !== me).map((m) => m.userId);
}

/** @username mentions that match current members. */
function mentionsIn(text: string | undefined, meta: GroupMeta, me: string) {
  if (!text) return [];
  const byName = new Map(meta.members.map((m) => [m.username, m.userId]));
  const ids = new Set<string>();
  for (const match of text.matchAll(/@([a-z0-9_.]{3,20})/gi)) {
    const id = byName.get(match[1]!.toLowerCase());
    if (id && id !== me) ids.add(id);
  }
  return [...ids];
}

export function registerMessageHandlers(socket: AppSocket) {
  const me = socket.data.userId;

  async function sendDirect(msg: z.infer<typeof SendSchema> & { to: string }, serverTs: string): Promise<SendResult> {
    if (msg.to === me) throw badRequest("You cannot message yourself");
    const recipient = await prisma.user.findUnique({ where: { id: msg.to }, select: { id: true, username: true } });
    if (!recipient?.username) throw new AppError(404, "NOT_FOUND", "User not found");

    if (await hasBlocked(me, msg.to)) throw new AppError(403, "FORBIDDEN", "Unblock this user to message them");
    // If they blocked you, the message is accepted but never delivered (you only see one tick).
    if (await hasBlocked(msg.to, me)) return { messageId: msg.id, serverTs };

    await ensureConnection(me, msg.to);
    const file = msg.kind === "file" && msg.fileId ? await shareFile(me, [msg.to], msg.fileId, Boolean(msg.forwarded)) : null;

    await enqueue({
      recipientId: msg.to,
      senderId: me,
      type: "message",
      messageId: msg.id,
      payload: {
        id: msg.id,
        kind: msg.kind,
        text: msg.text?.trim() || null,
        file,
        replyTo: msg.replyTo ?? null,
        forwarded: Boolean(msg.forwarded),
        sentAt: serverTs,
        groupId: null,
        mentions: [],
      },
    });

    if (!(await isOnline(msg.to))) {
      await queuePush({
        recipientId: msg.to,
        senderId: me,
        senderUsername: socket.data.username,
        preview: previewFor(msg.kind, msg.text ?? null, file?.mime),
      });
    }
    return { messageId: msg.id, serverTs };
  }

  /**
   * Group send: one queued copy per member (fan-out on write). The ack lists who it went to,
   * so the sender's device can show ✓✓ / blue ✓✓ once every one of them has received / read it.
   */
  async function sendGroup(msg: z.infer<typeof SendSchema> & { groupId: string }, serverTs: string): Promise<SendResult> {
    const meta = await requireGroupMember(me, msg.groupId);
    if (meta.onlyAdminsCanSend && meta.myRole !== "admin") {
      throw new AppError(403, "FORBIDDEN", "Only admins can send messages to this group");
    }
    const recipients = othersIn(meta, me);
    const file = msg.kind === "file" && msg.fileId ? await shareFile(me, recipients, msg.fileId, Boolean(msg.forwarded)) : null;
    const mentions = mentionsIn(msg.text, meta, me);

    await enqueueMany(
      "message",
      me,
      recipients,
      {
        id: msg.id,
        kind: msg.kind,
        text: msg.text?.trim() || null,
        file,
        replyTo: msg.replyTo ?? null,
        forwarded: Boolean(msg.forwarded),
        sentAt: serverTs,
        groupId: msg.groupId,
        mentions,
      },
      { messageId: msg.id, groupId: msg.groupId },
    );

    // Push to offline members, except those who muted the group (an @mention still gets through).
    const presence = await getPresence(recipients);
    const now = Date.now();
    const preview = previewFor(msg.kind, msg.text ?? null, file?.mime);
    for (const p of presence) {
      if (p.online) continue;
      const member = meta.members.find((m) => m.userId === p.userId);
      const muted = member?.mutedUntil && new Date(member.mutedUntil).getTime() > now;
      if (muted && !mentions.includes(p.userId)) continue;
      await queuePush({
        recipientId: p.userId,
        senderId: me,
        senderUsername: socket.data.username,
        preview,
        groupId: msg.groupId,
        groupName: meta.name,
      });
    }
    return { messageId: msg.id, serverTs, recipients };
  }

  handle(
    socket,
    "message:send",
    SendSchema,
    async (msg) => {
      // A retry of a message we already accepted (lost ack, outbox resend) gets the same answer.
      const serverTs = new Date().toISOString();
      const first = await redis.set(dedupeKey(me, msg.id), JSON.stringify({ messageId: msg.id, serverTs }), "EX", DEDUPE_TTL_SECONDS, "NX");
      if (first !== "OK") {
        const earlier = await redis.get(dedupeKey(me, msg.id));
        try {
          return JSON.parse(earlier ?? "") as SendResult;
        } catch {
          return { messageId: msg.id, serverTs: earlier ?? serverTs };
        }
      }
      try {
        const result = msg.groupId
          ? await sendGroup(msg as typeof msg & { groupId: string }, serverTs)
          : await sendDirect(msg as typeof msg & { to: string }, serverTs);
        await redis.set(dedupeKey(me, msg.id), JSON.stringify(result), "EX", DEDUPE_TTL_SECONDS);
        return result;
      } catch (err) {
        // Let the client retry a message that failed for a real reason.
        await redis.del(dedupeKey(me, msg.id));
        throw err;
      }
    },
    { limiter: "messages" },
  );

  handle(socket, "message:read", ReadSchema, async (data) => {
    const at = new Date().toISOString();
    if ("groupId" in data) {
      await requireGroupMember(me, data.groupId);
      if (data.senderId !== me) {
        await enqueue({
          recipientId: data.senderId,
          senderId: me,
          type: "receipt.read",
          payload: { messageIds: data.messageIds, at, groupId: data.groupId },
          groupId: data.groupId,
        });
      }
    } else if (await canInteract(me, data.peerId)) {
      await enqueue({ recipientId: data.peerId, senderId: me, type: "receipt.read", payload: { messageIds: data.messageIds, at, groupId: null } });
    }
    return {};
  });

  handle(socket, "message:react", ReactSchema, async ({ peerId, groupId, messageId, emoji }) => {
    const at = new Date().toISOString();
    if (groupId) {
      const meta = await requireGroupMember(me, groupId);
      await enqueueMany("reaction", me, othersIn(meta, me), { messageId, emoji, at, groupId }, { groupId });
    } else if (peerId && (await canInteract(me, peerId))) {
      await enqueue({ recipientId: peerId, senderId: me, type: "reaction", payload: { messageId, emoji, at, groupId: null } });
    }
    return {};
  });

  handle(socket, "message:delete", DeleteSchema, async ({ peerId, groupId, messageId, asAdmin }) => {
    const at = new Date().toISOString();
    if (groupId) {
      const meta = await requireGroupMember(me, groupId);
      if (asAdmin && meta.myRole !== "admin") throw new AppError(403, "FORBIDDEN", "Only group admins can delete other people's messages");
      const others = othersIn(meta, me);
      // Copies not delivered yet are simply pulled out of members' queues.
      const pulled = await prisma.pendingEvent.deleteMany({
        where: { type: "message", messageId, groupId, ...(asAdmin ? {} : { senderId: me }) },
      });
      await enqueueMany("message.deleted", me, others, { messageId, at, groupId, asAdmin: Boolean(asAdmin) }, { groupId });
      return { retracted: others.length > 0 && pulled.count >= others.length };
    }
    if (!peerId) throw badRequest("peerId is required");
    // Not delivered yet: just pull it out of their queue.
    const pulled = await prisma.pendingEvent.deleteMany({
      where: { recipientId: peerId, senderId: me, type: "message", messageId },
    });
    if (pulled.count > 0) return { retracted: true };
    if (!(await hasBlocked(peerId, me))) {
      await enqueue({ recipientId: peerId, senderId: me, type: "message.deleted", payload: { messageId, at, groupId: null, asAdmin: false } });
    }
    return { retracted: false };
  });
}
