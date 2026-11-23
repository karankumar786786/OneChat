/**
 * Socket contract, kept in step with engine/contracts/socket-events.md by hand.
 * (REST types are generated from engine/contracts/openapi.json into src/api/schema.d.ts.)
 */
import type { FileMeta } from "../db/types";
import type { GroupUpdate } from "../groups/describe";

export type QueuedType = "message" | "receipt.delivered" | "receipt.read" | "reaction" | "message.deleted" | "group.update";

export interface MessagePayload {
  id: string;
  kind: "text" | "file";
  text: string | null;
  file: (FileMeta & { purpose: string; state: string }) | null;
  replyTo: string | null;
  forwarded: boolean;
  sentAt: string;
  groupId?: string | null;
  mentions?: string[];
}
export interface ReceiptPayload {
  messageIds: string[];
  at: string;
  groupId?: string | null;
}
export interface ReactionPayload {
  messageId: string;
  emoji: string | null;
  at: string;
  groupId?: string | null;
}
export interface DeletedPayload {
  messageId: string;
  at: string;
  groupId?: string | null;
  asAdmin?: boolean;
}

export type Envelope =
  | { eventId: string; type: "message"; from: string; serverTs: string; payload: MessagePayload }
  | { eventId: string; type: "receipt.delivered" | "receipt.read"; from: string; serverTs: string; payload: ReceiptPayload }
  | { eventId: string; type: "reaction"; from: string; serverTs: string; payload: ReactionPayload }
  | { eventId: string; type: "message.deleted"; from: string; serverTs: string; payload: DeletedPayload }
  | { eventId: string; type: "group.update"; from: string; serverTs: string; payload: GroupUpdate };

export type Ack<T extends object = object> = ({ ok: true } & T) | { ok: false; error: { code: string; message: string } };

export interface SendMessage {
  id: string;
  /** Exactly one of `to` (a person) or `groupId`. */
  to?: string;
  groupId?: string;
  kind: "text" | "file";
  text?: string;
  fileId?: string;
  replyTo?: string;
  forwarded?: boolean;
}

export interface PresenceState {
  userId: string;
  online: boolean;
  lastSeenAt: string | null;
}
