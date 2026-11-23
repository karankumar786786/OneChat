import type { Db } from "./types";

const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    peerId TEXT NOT NULL,
    fromMe INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT,
    fileJson TEXT,
    localUri TEXT,
    replyTo TEXT,
    forwarded INTEGER NOT NULL DEFAULT 0,
    tick TEXT NOT NULL,
    sentAt TEXT NOT NULL,
    myReaction TEXT,
    peerReaction TEXT,
    deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS messages_peer_time ON messages(peerId, sentAt);
  CREATE TABLE IF NOT EXISTS chats (
    peerId TEXT PRIMARY KEY,
    username TEXT,
    displayName TEXT,
    avatarFileId TEXT,
    avatarUrl TEXT,
    lastText TEXT,
    lastAt TEXT,
    unread INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS seen_events (
    eventId TEXT PRIMARY KEY,
    at TEXT NOT NULL
  );
  `,
  // v2: groups
  `
  ALTER TABLE chats ADD COLUMN kind TEXT NOT NULL DEFAULT 'direct';
  ALTER TABLE messages ADD COLUMN senderId TEXT;
  ALTER TABLE messages ADD COLUMN recipientsJson TEXT;
  ALTER TABLE messages ADD COLUMN mentionsJson TEXT;
  CREATE TABLE IF NOT EXISTS receipts (
    messageId TEXT NOT NULL,
    userId TEXT NOT NULL,
    deliveredAt TEXT,
    readAt TEXT,
    PRIMARY KEY (messageId, userId)
  );
  CREATE TABLE IF NOT EXISTS reactions (
    messageId TEXT NOT NULL,
    userId TEXT NOT NULL,
    emoji TEXT NOT NULL,
    PRIMARY KEY (messageId, userId)
  );
  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    description TEXT,
    avatarFileId TEXT,
    avatarUrl TEXT,
    onlyAdminsCanSend INTEGER NOT NULL DEFAULT 0,
    onlyAdminsCanEditInfo INTEGER NOT NULL DEFAULT 0,
    createdById TEXT,
    myRole TEXT NOT NULL DEFAULT 'member',
    isMember INTEGER NOT NULL DEFAULT 1,
    mutedUntil TEXT,
    membersJson TEXT NOT NULL DEFAULT '[]'
  );
  `,
];

export async function migrate(db: Db) {
  await db.exec("PRAGMA journal_mode = WAL;");
  const row = await db.first<{ user_version: number }>("PRAGMA user_version");
  let version = row?.user_version ?? 0;
  for (; version < MIGRATIONS.length; version++) {
    await db.exec(MIGRATIONS[version]!);
    await db.exec(`PRAGMA user_version = ${version + 1}`);
  }
  // Duplicate-tracking only needs to outlive the server's 30-day pending window.
  await db.run("DELETE FROM seen_events WHERE at < ?", [new Date(Date.now() - 35 * 86_400_000).toISOString()]);
}
