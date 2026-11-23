/**
 * The small database surface the chat logic needs. The app backs it with expo-sqlite;
 * tests back it with bun:sqlite, so the event logic is tested against real SQL.
 */
export type Param = string | number | null;

export interface Db {
  run(sql: string, params?: Param[]): Promise<{ changes: number }>;
  all<T>(sql: string, params?: Param[]): Promise<T[]>;
  first<T>(sql: string, params?: Param[]): Promise<T | null>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: () => Promise<T>): Promise<T>;
}

export type Tick = "pending" | "sent" | "delivered" | "read" | "failed" | "received" | "seen";

export interface FileMeta {
  id: string;
  mime: string;
  size: number;
  name: string | null;
  expiresAt: string | null;
}

export interface MessageRow {
  id: string;
  /** The chat: the other person's id for 1:1 chats, the group id for groups. */
  peerId: string;
  fromMe: 0 | 1;
  kind: "text" | "file" | "system";
  text: string | null;
  fileJson: string | null;
  localUri: string | null;
  replyTo: string | null;
  forwarded: 0 | 1;
  tick: Tick;
  sentAt: string;
  myReaction: string | null;
  peerReaction: string | null;
  /** 1 = deleted by its sender, 2 = deleted by a group admin. */
  deleted: 0 | 1 | 2;
  /** Group messages: who sent it (null for your own). */
  senderId?: string | null;
  /** Your group messages: who it was sent to (from the server's ack). */
  recipientsJson?: string | null;
  mentionsJson?: string | null;
  /** Other members' reactions in a group, concatenated (read-only, from a join). */
  otherReactions?: string | null;
}

export interface GroupMemberRow {
  id: string;
  username: string;
  displayName: string | null;
  avatarFileId: string | null;
  avatarUrl: string | null;
  role: "member" | "admin";
  isCreator: boolean;
}

export interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  avatarFileId: string | null;
  avatarUrl: string | null;
  onlyAdminsCanSend: 0 | 1;
  onlyAdminsCanEditInfo: 0 | 1;
  createdById: string | null;
  myRole: "member" | "admin";
  isMember: 0 | 1;
  mutedUntil: string | null;
  membersJson: string;
}

export interface ChatRow {
  /** Person id for 1:1 chats, group id for groups. */
  peerId: string;
  kind: "direct" | "group";
  username: string | null;
  displayName: string | null;
  avatarFileId: string | null;
  avatarUrl: string | null;
  lastText: string | null;
  lastAt: string | null;
  unread: number;
}
