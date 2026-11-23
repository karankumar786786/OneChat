import type { Db, FileMeta } from "../db/types";
import { ensureChat, insertMessage, previewText, touchChat } from "../db/queries";
import { getGroup, isGroupAdmin, markNotMember, memberName } from "../db/groups";
import { describeGroupUpdate, membershipChange } from "../groups/describe";
import type { Envelope } from "./events";

export interface ApplyResult {
  /** Chats whose rows changed (screens re-read these). */
  changedPeers: Set<string>;
  /** Incoming messages per chat, so an open chat can send read receipts at once. */
  newIncoming: Map<string, string[]>;
  /** People we have no profile for yet. */
  unknownPeers: Set<string>;
  /** Groups whose details (name, members, roles) should be fetched again. */
  refreshGroups: Set<string>;
}

const TICK_ORDER = ["pending", "sent", "delivered", "read"] as const;

/**
 * A group message is ✓✓ once every recipient has received it and blue once every one read it.
 * Recipients come from the server's ack; receipts arrive one per member.
 */
export async function recomputeGroupTick(db: Db, messageId: string) {
  const m = await db.first<{ recipientsJson: string | null; tick: string }>("SELECT recipientsJson, tick FROM messages WHERE id = ? AND fromMe = 1", [messageId]);
  if (!m?.recipientsJson) return false;
  const recipients = JSON.parse(m.recipientsJson) as string[];
  if (recipients.length === 0) return false;
  const marks = recipients.map(() => "?").join(",");
  const counts = await db.first<{ d: number | null; r: number | null }>(
    `SELECT SUM(deliveredAt IS NOT NULL) AS d, SUM(readAt IS NOT NULL) AS r FROM receipts WHERE messageId = ? AND userId IN (${marks})`,
    [messageId, ...recipients],
  );
  const next = (counts?.r ?? 0) >= recipients.length ? "read" : (counts?.d ?? 0) >= recipients.length ? "delivered" : null;
  if (!next) return false;
  const cur = TICK_ORDER.indexOf(m.tick as (typeof TICK_ORDER)[number]);
  if (cur >= TICK_ORDER.indexOf(next)) return false;
  await db.run("UPDATE messages SET tick = ? WHERE id = ?", [next, messageId]);
  return true;
}

/**
 * Applies a batch of queued events to the local database in one transaction.
 * Safe to call twice with the same events: duplicates are skipped by eventId and message id.
 *
 * The server stores no message metadata, so authorship is checked here:
 * a delete only applies when it comes from the message's sender (or, in a group, from an
 * admin deleting as admin), and reactions/receipts only from the chat's peer or group members.
 */
export async function applyEvents(
  db: Db,
  events: Envelope[],
  opts: { activePeerId?: string | null; myId?: string | null } = {},
): Promise<ApplyResult> {
  const result: ApplyResult = { changedPeers: new Set(), newIncoming: new Map(), unknownPeers: new Set(), refreshGroups: new Set() };
  const now = new Date().toISOString();
  const myId = opts.myId ?? null;

  await db.tx(async () => {
    for (const e of events) {
      const fresh = await db.run("INSERT OR IGNORE INTO seen_events (eventId, at) VALUES (?, ?)", [e.eventId, now]);
      if (fresh.changes === 0) continue;

      switch (e.type) {
        case "message": {
          const m = e.payload;
          const groupId = m.groupId ?? null;
          const chatId = groupId ?? e.from;
          await ensureChat(db, chatId, groupId ? { kind: "group" } : undefined);
          const file: FileMeta | null = m.file
            ? { id: m.file.id, mime: m.file.mime, size: m.file.size, name: m.file.name, expiresAt: m.file.expiresAt }
            : null;
          const inserted = await insertMessage(db, {
            id: m.id,
            peerId: chatId,
            fromMe: 0,
            kind: m.kind,
            text: m.text,
            fileJson: file ? JSON.stringify(file) : null,
            localUri: null,
            replyTo: m.replyTo,
            forwarded: m.forwarded ? 1 : 0,
            tick: "received",
            sentAt: m.sentAt,
            myReaction: null,
            peerReaction: null,
            deleted: 0,
            senderId: groupId ? e.from : null,
            mentionsJson: m.mentions?.length ? JSON.stringify(m.mentions) : null,
          });
          if (!inserted) break;
          const isOpen = opts.activePeerId === chatId;
          let preview = previewText(m.kind, m.text, file);
          if (groupId) {
            const name = await memberName(db, groupId, e.from);
            if (name) preview = `${name}: ${preview}`;
            if (!(await getGroup(db, groupId))) result.refreshGroups.add(groupId);
          }
          await touchChat(db, chatId, preview, m.sentAt, isOpen ? 0 : 1);
          result.newIncoming.set(chatId, [...(result.newIncoming.get(chatId) ?? []), m.id]);
          if (!groupId) {
            const chat = await db.first<{ username: string | null }>("SELECT username FROM chats WHERE peerId = ?", [e.from]);
            if (!chat?.username) result.unknownPeers.add(e.from);
          }
          result.changedPeers.add(chatId);
          break;
        }
        case "receipt.delivered":
        case "receipt.read": {
          const ids = e.payload.messageIds;
          if (!ids.length) break;
          const groupId = e.payload.groupId ?? null;
          const read = e.type === "receipt.read";
          if (groupId) {
            // Record this member's receipt for each of my messages in the group, then re-evaluate the ticks.
            for (const id of ids) {
              const mine = await db.first<{ id: string }>("SELECT id FROM messages WHERE id = ? AND peerId = ? AND fromMe = 1", [id, groupId]);
              if (!mine) continue;
              await db.run(
                `INSERT INTO receipts (messageId, userId, deliveredAt, readAt) VALUES (?, ?, ?, ?)
                 ON CONFLICT(messageId, userId) DO UPDATE SET
                   deliveredAt = COALESCE(receipts.deliveredAt, excluded.deliveredAt),
                   readAt = COALESCE(receipts.readAt, excluded.readAt)`,
                [id, e.from, e.payload.at, read ? e.payload.at : null],
              );
              await recomputeGroupTick(db, id);
            }
            result.changedPeers.add(groupId);
            break;
          }
          const marks = ids.map(() => "?").join(",");
          // Never move a tick backwards (a late "delivered" must not undo "read").
          const allowed = read ? "('pending','sent','delivered')" : "('pending','sent')";
          const res = await db.run(
            `UPDATE messages SET tick = ? WHERE fromMe = 1 AND peerId = ? AND tick IN ${allowed} AND id IN (${marks})`,
            [read ? "read" : "delivered", e.from, ...ids],
          );
          if (res.changes) result.changedPeers.add(e.from);
          break;
        }
        case "reaction": {
          const groupId = e.payload.groupId ?? null;
          if (groupId) {
            const exists = await db.first<{ id: string }>("SELECT id FROM messages WHERE id = ? AND peerId = ?", [e.payload.messageId, groupId]);
            if (!exists) break;
            if (e.payload.emoji) {
              await db.run("INSERT OR REPLACE INTO reactions (messageId, userId, emoji) VALUES (?, ?, ?)", [e.payload.messageId, e.from, e.payload.emoji]);
            } else {
              await db.run("DELETE FROM reactions WHERE messageId = ? AND userId = ?", [e.payload.messageId, e.from]);
            }
            result.changedPeers.add(groupId);
            break;
          }
          const res = await db.run("UPDATE messages SET peerReaction = ? WHERE id = ? AND peerId = ?", [
            e.payload.emoji,
            e.payload.messageId,
            e.from,
          ]);
          if (res.changes) result.changedPeers.add(e.from);
          break;
        }
        case "message.deleted": {
          const groupId = e.payload.groupId ?? null;
          if (groupId) {
            const msg = await db.first<{ fromMe: number; senderId: string | null }>(
              "SELECT fromMe, senderId FROM messages WHERE id = ? AND peerId = ?",
              [e.payload.messageId, groupId],
            );
            if (!msg) break;
            const bySender = msg.fromMe === 0 && msg.senderId === e.from;
            const byAdmin = Boolean(e.payload.asAdmin) && (await isGroupAdmin(db, groupId, e.from));
            if (!bySender && !byAdmin) break;
            await db.run("UPDATE messages SET deleted = ?, text = NULL, fileJson = NULL, localUri = NULL WHERE id = ?", [
              bySender ? 1 : 2,
              e.payload.messageId,
            ]);
            result.changedPeers.add(groupId);
            break;
          }
          const res = await db.run(
            "UPDATE messages SET deleted = 1, text = NULL, fileJson = NULL, localUri = NULL WHERE id = ? AND peerId = ? AND fromMe = 0",
            [e.payload.messageId, e.from],
          );
          if (res.changes) result.changedPeers.add(e.from);
          break;
        }
        case "group.update": {
          const u = e.payload;
          await ensureChat(db, u.groupId, { kind: "group", displayName: u.changes?.name });
          const text = describeGroupUpdate(u, myId);
          await insertMessage(db, {
            id: e.eventId,
            peerId: u.groupId,
            fromMe: 0,
            kind: "system",
            text,
            fileJson: null,
            localUri: null,
            replyTo: null,
            forwarded: 0,
            tick: "seen",
            sentAt: u.at,
            myReaction: null,
            peerReaction: null,
            deleted: 0,
          });
          await touchChat(db, u.groupId, text.split("\n")[0]!, u.at, 0);
          // Keep the local copy usable until the fresh details arrive.
          if (u.changes?.name) {
            await db.run("UPDATE groups SET name = ? WHERE id = ?", [u.changes.name, u.groupId]);
            await db.run("UPDATE chats SET displayName = ? WHERE peerId = ?", [u.changes.name, u.groupId]);
          }
          if (u.changes?.onlyAdminsCanSend !== undefined) {
            await db.run("UPDATE groups SET onlyAdminsCanSend = ? WHERE id = ?", [u.changes.onlyAdminsCanSend ? 1 : 0, u.groupId]);
          }
          if (u.changes?.onlyAdminsCanEditInfo !== undefined) {
            await db.run("UPDATE groups SET onlyAdminsCanEditInfo = ? WHERE id = ?", [u.changes.onlyAdminsCanEditInfo ? 1 : 0, u.groupId]);
          }
          const membership = membershipChange(u, myId);
          if (membership === "left") await markNotMember(db, u.groupId);
          else result.refreshGroups.add(u.groupId);
          result.changedPeers.add(u.groupId);
          break;
        }
      }
    }
  });
  return result;
}
