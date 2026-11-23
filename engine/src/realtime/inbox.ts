import type { Socket } from "socket.io";
import { prisma, type Prisma } from "../lib/prisma.ts";
import { getIo, rooms } from "./io.ts";
import { logger } from "../lib/logger.ts";
import type { Envelope, PayloadFor, QueuedEventType } from "./types.ts";

/**
 * Store-until-delivered queue.
 * Every event that must survive the recipient being offline is written to PendingEvent,
 * pushed live if the recipient is connected, and deleted only when their device acks it.
 * Delivery is at-least-once: clients drop duplicates by eventId (and messages by id).
 */

const DRAIN_PAGE = 200;
const DRAIN_ACK_TIMEOUT_MS = 15_000;
export const PENDING_TTL_DAYS = 30;

type Row = { id: string; type: string; senderId: string; payload: Prisma.JsonValue; createdAt: Date };

function toEnvelope(row: Row): Envelope {
  return {
    eventId: row.id,
    type: row.type as QueuedEventType,
    from: row.senderId,
    payload: row.payload as unknown as Envelope["payload"],
    serverTs: row.createdAt.toISOString(),
  };
}

export interface EnqueueInput<T extends QueuedEventType> {
  recipientId: string;
  senderId: string;
  type: T;
  payload: PayloadFor<T>;
  messageId?: string;
  groupId?: string;
}

export async function enqueue<T extends QueuedEventType>(input: EnqueueInput<T>): Promise<Envelope<T>> {
  const [envelope] = await enqueueMany(input.type, input.senderId, [input.recipientId], input.payload, {
    messageId: input.messageId,
    groupId: input.groupId,
  });
  return envelope!;
}

/**
 * The same event for many recipients (group fan-out): one row per recipient,
 * written in a single statement, then pushed live to whoever is connected.
 */
export async function enqueueMany<T extends QueuedEventType>(
  type: T,
  senderId: string,
  recipientIds: string[],
  payload: PayloadFor<T>,
  opts: { messageId?: string; groupId?: string } = {},
): Promise<Envelope<T>[]> {
  if (recipientIds.length === 0) return [];
  const rows = await prisma.pendingEvent.createManyAndReturn({
    data: recipientIds.map((recipientId) => ({
      recipientId,
      senderId,
      type,
      messageId: opts.messageId ?? null,
      groupId: opts.groupId ?? null,
      payload: payload as unknown as Prisma.InputJsonValue,
    })),
  });
  const io = getIo();
  return rows.map((row) => {
    const envelope = toEnvelope(row) as Envelope<T>;
    io?.to(rooms.user(row.recipientId)).emit("events", [envelope]);
    return envelope;
  });
}

/**
 * Deletes acked events and sends "delivered" receipts for any messages among them.
 * DELETE ... RETURNING makes this safe when the same ids are acked twice at once:
 * only one caller gets the rows back, so receipts are not duplicated.
 */
export async function ack(recipientId: string, eventIds: string[]): Promise<number> {
  if (eventIds.length === 0) return 0;
  const removed = await prisma.$queryRaw<
    { id: string; type: string; senderId: string; messageId: string | null; groupId: string | null }[]
  >`
    DELETE FROM "PendingEvent"
    WHERE id = ANY(${eventIds}::uuid[]) AND "recipientId" = ${recipientId}::uuid
    RETURNING id, type, "senderId", "messageId", "groupId"
  `;

  // One receipt per (sender, chat): the sender's device learns that THIS user got these messages.
  const delivered = new Map<string, { senderId: string; groupId: string | null; messageIds: string[] }>();
  for (const r of removed) {
    if (r.type !== "message" || !r.messageId) continue;
    const k = `${r.senderId}|${r.groupId ?? ""}`;
    const entry = delivered.get(k) ?? { senderId: r.senderId, groupId: r.groupId, messageIds: [] };
    entry.messageIds.push(r.messageId);
    delivered.set(k, entry);
  }
  const at = new Date().toISOString();
  await Promise.all(
    [...delivered.values()].map(({ senderId, groupId, messageIds }) =>
      enqueue({
        recipientId: senderId,
        senderId: recipientId,
        type: "receipt.delivered",
        payload: { messageIds, at, groupId },
        groupId: groupId ?? undefined,
      }),
    ),
  );
  return removed.length;
}

/**
 * Sends everything waiting for this user, oldest first, a page at a time.
 * Each page waits for the client's ack before the next one is sent.
 */
export async function drain(socket: Socket, userId: string) {
  let cursor: { createdAt: Date; id: string } | null = null;
  for (;;) {
    if (!socket.connected) return;
    const rows: Row[] = await prisma.pendingEvent.findMany({
      where: {
        recipientId: userId,
        ...(cursor
          ? { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: DRAIN_PAGE,
      select: { id: true, type: true, senderId: true, payload: true, createdAt: true },
    });
    if (rows.length === 0) return;
    const last = rows[rows.length - 1]!;
    cursor = { createdAt: last.createdAt, id: last.id };

    try {
      const res = (await socket.timeout(DRAIN_ACK_TIMEOUT_MS).emitWithAck("events", rows.map(toEnvelope))) as
        | { eventIds?: unknown }
        | undefined;
      const ids = Array.isArray(res?.eventIds) ? res.eventIds.filter((x): x is string => typeof x === "string") : [];
      await ack(userId, ids);
    } catch (err) {
      // No ack in time: stop here. Whatever was not acked is sent again on the next connect.
      logger.debug({ err, userId }, "drain paused: no ack");
      return;
    }
    if (rows.length < DRAIN_PAGE) return;
  }
}

/** Drops events nobody collected within PENDING_TTL_DAYS (their files have expired by then anyway). */
export async function cleanupStalePending() {
  const cutoff = new Date(Date.now() - PENDING_TTL_DAYS * 86_400_000);
  const res = await prisma.pendingEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return res.count;
}
