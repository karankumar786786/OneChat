import type { FileDto } from "../modules/files/service.ts";
import type { PresenceState } from "./presence.ts";

/** Events that go through the store-until-delivered queue. */
export type QueuedEventType = "message" | "receipt.delivered" | "receipt.read" | "reaction" | "message.deleted" | "group.update";

export interface MessagePayload {
  id: string;
  kind: "text" | "file";
  text: string | null;
  file: FileDto | null;
  replyTo: string | null;
  forwarded: boolean;
  sentAt: string;
  /** Set when the message was sent to a group. */
  groupId: string | null;
  /** Group members @mentioned in the text. */
  mentions: string[];
}
export interface ReceiptPayload {
  messageIds: string[];
  at: string;
  groupId: string | null;
}
export interface ReactionPayload {
  messageId: string;
  emoji: string | null;
  at: string;
  groupId: string | null;
}
export interface DeletedPayload {
  messageId: string;
  at: string;
  groupId: string | null;
  /** A group admin deleted someone else's message. */
  asAdmin: boolean;
}

export type GroupAction = "created" | "added" | "removed" | "left" | "joined" | "promoted" | "demoted" | "info" | "settings";
export interface GroupUpdatePayload {
  groupId: string;
  action: GroupAction;
  actor: { id: string; username: string };
  targets: { id: string; username: string }[];
  changes: {
    name?: string;
    description?: string | null;
    avatarFileId?: string | null;
    onlyAdminsCanSend?: boolean;
    onlyAdminsCanEditInfo?: boolean;
  } | null;
  at: string;
}

export type PayloadFor<T extends QueuedEventType> = T extends "message"
  ? MessagePayload
  : T extends "receipt.delivered" | "receipt.read"
    ? ReceiptPayload
    : T extends "reaction"
      ? ReactionPayload
      : T extends "group.update"
        ? GroupUpdatePayload
        : DeletedPayload;

export interface Envelope<T extends QueuedEventType = QueuedEventType> {
  eventId: string;
  type: T;
  /** Set by the server from the authenticated sender; clients must trust only this. */
  from: string;
  payload: PayloadFor<T>;
  serverTs: string;
}

export type AckError = { ok: false; error: { code: string; message: string } };
export type Ack<T extends object = object> = ({ ok: true } & T) | AckError;
export type AckFn<T extends object = object> = (res: Ack<T>) => void;

export interface ClientToServerEvents {
  "message:send": (data: unknown, ack?: AckFn<{ messageId: string; serverTs: string }>) => void;
  "message:read": (data: unknown, ack?: AckFn) => void;
  "message:react": (data: unknown, ack?: AckFn) => void;
  "message:delete": (data: unknown, ack?: AckFn<{ retracted: boolean }>) => void;
  "event:ack": (data: unknown, ack?: AckFn<{ removed: number }>) => void;
  typing: (data: unknown) => void;
  "presence:query": (data: unknown, ack?: AckFn<{ presence: PresenceState[] }>) => void;
}

export interface ServerToClientEvents {
  /** Queued events. When the server passes an ack callback, answer it with { eventIds }; otherwise emit event:ack. */
  events: (events: Envelope[], ack?: (res: { eventIds: string[] }) => void) => void;
  typing: (data: { from: string; on: boolean; groupId?: string }) => void;
  "presence:update": (data: PresenceState) => void;
  "status:new": (data: { userId: string; statusId: string; createdAt: string }) => void;
  "status:deleted": (data: { userId: string; statusId: string }) => void;
  "status:viewed": (data: unknown) => void;
  "status:reaction": (data: unknown) => void;
  "status:comment": (data: unknown) => void;
  "session:revoked": (data: { reason: string }) => void;
}

export interface SocketData {
  userId: string;
  sessionId: string;
  username: string;
}
