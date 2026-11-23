import { getDb } from "../db";
import { emitDbChange } from "../db/changes";
import { ensureChat, getMessage, insertMessage, markDeletedByMe, previewText, setMyReaction, setTick, touchChat } from "../db/queries";
import type { FileMeta, MessageRow } from "../db/types";
import { uuidv7 } from "../lib/ids";
import { emitAck, sendMessage } from "../realtime/socket";
import { uploadFile, type PickedFile } from "../files/upload";
import type { SendMessage } from "../realtime/events";

/** Where a message goes: a person (1:1) or a group. */
export interface ChatTarget {
  id: string;
  kind: "direct" | "group";
}

const address = (t: ChatTarget): Pick<SendMessage, "to" | "groupId"> => (t.kind === "group" ? { groupId: t.id } : { to: t.id });

/** Group previews in the chat list start with "You: ". */
const ownPreview = (t: ChatTarget, text: string) => (t.kind === "group" ? `You: ${text}` : text);

export async function chatTargetFor(chatId: string): Promise<ChatTarget> {
  const row = await getDb().first<{ kind: "direct" | "group" }>("SELECT kind FROM chats WHERE peerId = ?", [chatId]);
  return { id: chatId, kind: row?.kind ?? "direct" };
}

function localRow(peerId: string, partial: Partial<MessageRow> & Pick<MessageRow, "id" | "kind">): MessageRow {
  return {
    peerId,
    fromMe: 1,
    text: null,
    fileJson: null,
    localUri: null,
    replyTo: null,
    forwarded: 0,
    tick: "pending",
    sentAt: new Date().toISOString(),
    myReaction: null,
    peerReaction: null,
    deleted: 0,
    ...partial,
  };
}

export async function sendText(target: ChatTarget, text: string, replyTo?: string | null) {
  const db = getDb();
  const id = uuidv7();
  const row = localRow(target.id, { id, kind: "text", text, replyTo: replyTo ?? null });
  await insertMessage(db, row);
  await touchChat(db, target.id, ownPreview(target, text), row.sentAt);
  emitDbChange([target.id]);
  await sendMessage({ id, ...address(target), kind: "text", text, replyTo: replyTo ?? undefined });
}

/** Shows the file in the chat right away, uploads it, then sends it. */
export async function sendFile(target: ChatTarget, picked: PickedFile, caption?: string, replyTo?: string | null) {
  const db = getDb();
  const id = uuidv7();
  const draft: FileMeta = { id: "", mime: picked.mime, size: picked.size, name: picked.name, expiresAt: null };
  const row = localRow(target.id, { id, kind: "file", text: caption || null, fileJson: JSON.stringify(draft), localUri: picked.uri, replyTo: replyTo ?? null });
  await insertMessage(db, row);
  await touchChat(db, target.id, ownPreview(target, previewText("file", caption ?? null, draft)), row.sentAt);
  emitDbChange([target.id]);
  try {
    const file = await uploadFile(picked, "chat");
    const meta: FileMeta = { id: file.id, mime: file.mime, size: file.size, name: file.name, expiresAt: file.expiresAt };
    await db.run("UPDATE messages SET fileJson = ? WHERE id = ?", [JSON.stringify(meta), id]);
    await sendMessage({ id, ...address(target), kind: "file", fileId: file.id, text: caption || undefined, replyTo: replyTo ?? undefined });
  } catch (err) {
    console.warn("upload failed", err);
    await setTick(db, id, "failed");
    emitDbChange([target.id]);
  }
}

/** Forwarding a file resets its 30-day expiry on the server. */
export async function forwardMessage(messageId: string, toChatId: string) {
  const db = getDb();
  const original = await getMessage(db, messageId);
  if (!original || original.deleted || original.kind === "system") return;
  const target = await chatTargetFor(toChatId);
  if (target.kind === "direct") await ensureChat(db, toChatId);
  const id = uuidv7();
  const kind = original.kind;
  const file = original.fileJson ? (JSON.parse(original.fileJson) as FileMeta) : null;
  const row = localRow(toChatId, { id, kind, text: original.text, fileJson: original.fileJson, localUri: original.localUri, forwarded: 1 });
  await insertMessage(db, row);
  await touchChat(db, toChatId, ownPreview(target, previewText(kind, original.text, file)), row.sentAt);
  emitDbChange([toChatId]);
  await sendMessage({
    id,
    ...address(target),
    kind,
    text: original.text ?? undefined,
    fileId: file?.id || undefined,
    forwarded: true,
  });
}

export async function react(target: ChatTarget, m: MessageRow, emoji: string | null) {
  const next = m.myReaction === emoji ? null : emoji;
  await setMyReaction(getDb(), m.id, next);
  emitDbChange([m.peerId]);
  await emitAck("message:react", { ...(target.kind === "group" ? { groupId: target.id } : { peerId: target.id }), messageId: m.id, emoji: next });
}

/** In a group, admins may delete other people's messages for everyone. */
export async function deleteForEveryone(target: ChatTarget, m: MessageRow) {
  const asAdmin = target.kind === "group" && m.fromMe === 0;
  const res = await emitAck("message:delete", {
    ...(target.kind === "group" ? { groupId: target.id, asAdmin } : { peerId: target.id }),
    messageId: m.id,
  });
  if (!res.ok) return res;
  if (asAdmin) {
    await getDb().run("UPDATE messages SET deleted = 2, text = NULL, fileJson = NULL, localUri = NULL WHERE id = ?", [m.id]);
  } else {
    await markDeletedByMe(getDb(), m.id);
  }
  emitDbChange([m.peerId]);
  return res;
}

export async function deleteForMe(m: MessageRow) {
  await getDb().run("DELETE FROM messages WHERE id = ?", [m.id]);
  emitDbChange([m.peerId]);
}
