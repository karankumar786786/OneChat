import type { ChatRow, Db, FileMeta, MessageRow, Tick } from "./types";

export function previewText(kind: "text" | "file", text: string | null, file?: FileMeta | null) {
  if (kind === "file") {
    const mime = file?.mime ?? "";
    const label = mime.startsWith("image/") ? "📷 Photo" : mime.startsWith("video/") ? "🎥 Video" : `📎 ${file?.name ?? "File"}`;
    return text ? `${label} · ${text}` : label;
  }
  return text ?? "";
}

export async function ensureChat(db: Db, peerId: string, profile?: Partial<ChatRow>) {
  await db.run(
    `INSERT INTO chats (peerId, kind, username, displayName, avatarFileId, avatarUrl, unread)
     VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(peerId) DO UPDATE SET
       username = COALESCE(excluded.username, chats.username),
       displayName = COALESCE(excluded.displayName, chats.displayName),
       avatarFileId = COALESCE(excluded.avatarFileId, chats.avatarFileId),
       avatarUrl = COALESCE(excluded.avatarUrl, chats.avatarUrl)`,
    [peerId, profile?.kind ?? "direct", profile?.username ?? null, profile?.displayName ?? null, profile?.avatarFileId ?? null, profile?.avatarUrl ?? null],
  );
}

export async function touchChat(db: Db, peerId: string, lastText: string, lastAt: string, unreadDelta = 0) {
  await db.run(
    `UPDATE chats SET
       lastText = CASE WHEN lastAt IS NULL OR lastAt <= ? THEN ? ELSE lastText END,
       lastAt = CASE WHEN lastAt IS NULL OR lastAt <= ? THEN ? ELSE lastAt END,
       unread = unread + ?
     WHERE peerId = ?`,
    [lastAt, lastText, lastAt, lastAt, unreadDelta, peerId],
  );
}

export async function insertMessage(db: Db, m: MessageRow): Promise<boolean> {
  const res = await db.run(
    `INSERT OR IGNORE INTO messages
      (id, peerId, fromMe, kind, text, fileJson, localUri, replyTo, forwarded, tick, sentAt, myReaction, peerReaction, deleted, senderId, recipientsJson, mentionsJson)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?)`,
    [
      m.id, m.peerId, m.fromMe, m.kind, m.text, m.fileJson, m.localUri, m.replyTo, m.forwarded, m.tick, m.sentAt,
      m.senderId ?? null, m.recipientsJson ?? null, m.mentionsJson ?? null,
    ],
  );
  return res.changes > 0;
}

export function listChats(db: Db) {
  return db.all<ChatRow>("SELECT * FROM chats ORDER BY COALESCE(lastAt, '') DESC, username ASC");
}

export function getChat(db: Db, peerId: string) {
  return db.first<ChatRow>("SELECT * FROM chats WHERE peerId = ?", [peerId]);
}

export function listMessages(db: Db, peerId: string, limit = 200) {
  return db.all<MessageRow>(
    `SELECT m.*, (SELECT GROUP_CONCAT(r.emoji, '') FROM reactions r WHERE r.messageId = m.id) AS otherReactions
     FROM messages m WHERE m.peerId = ? ORDER BY m.sentAt DESC LIMIT ?`,
    [peerId, limit],
  );
}

export function getMessage(db: Db, id: string) {
  return db.first<MessageRow>("SELECT * FROM messages WHERE id = ?", [id]);
}

export async function setTick(db: Db, id: string, tick: Tick, sentAt?: string) {
  await db.run(`UPDATE messages SET tick = ?, sentAt = COALESCE(?, sentAt) WHERE id = ?`, [tick, sentAt ?? null, id]);
}

/** Incoming messages that have not been reported as read yet (with their sender, for groups). */
export async function unseenIncoming(db: Db, peerId: string) {
  return db.all<{ id: string; senderId: string | null }>(
    "SELECT id, senderId FROM messages WHERE peerId = ? AND fromMe = 0 AND kind != 'system' AND tick = 'received' AND deleted = 0",
    [peerId],
  );
}

export async function markSeen(db: Db, peerId: string, ids: string[]) {
  if (ids.length) {
    await db.run(`UPDATE messages SET tick = 'seen' WHERE peerId = ? AND id IN (${ids.map(() => "?").join(",")})`, [peerId, ...ids]);
  }
  await db.run("UPDATE chats SET unread = 0 WHERE peerId = ?", [peerId]);
}

export async function setMyReaction(db: Db, id: string, emoji: string | null) {
  await db.run("UPDATE messages SET myReaction = ? WHERE id = ?", [emoji, id]);
}

export async function markDeletedByMe(db: Db, id: string) {
  await db.run("UPDATE messages SET deleted = 1, text = NULL, fileJson = NULL, localUri = NULL WHERE id = ? AND fromMe = 1", [id]);
}

export async function setLocalUri(db: Db, id: string, uri: string) {
  await db.run("UPDATE messages SET localUri = ? WHERE id = ?", [uri, id]);
}

export async function deleteChat(db: Db, peerId: string) {
  await db.tx(async () => {
    await db.run("DELETE FROM messages WHERE peerId = ?", [peerId]);
    await db.run("DELETE FROM chats WHERE peerId = ?", [peerId]);
    await db.run("DELETE FROM groups WHERE id = ?", [peerId]);
  });
}

export async function deleteChatHistory(db: Db, peerId: string) {
  await db.tx(async () => {
    await db.run("DELETE FROM messages WHERE peerId = ?", [peerId]);
    await db.run("UPDATE chats SET lastText = NULL, unread = 0 WHERE peerId = ?", [peerId]);
  });
}

// Outbox: messages that still need the server's ack.
export async function addToOutbox(db: Db, id: string, payload: object) {
  await db.run("INSERT OR REPLACE INTO outbox (id, payload, createdAt) VALUES (?, ?, ?)", [id, JSON.stringify(payload), new Date().toISOString()]);
}
export function listOutbox(db: Db) {
  return db.all<{ id: string; payload: string }>("SELECT id, payload FROM outbox ORDER BY createdAt ASC");
}
export async function removeFromOutbox(db: Db, id: string) {
  await db.run("DELETE FROM outbox WHERE id = ?", [id]);
}
