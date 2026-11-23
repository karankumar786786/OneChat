import { beforeEach, describe, expect, test } from "bun:test";
import { memoryDb } from "./sqlite";
import { migrate } from "../src/db/schema";
import { applyEvents } from "../src/realtime/apply";
import { insertMessage, listChats, getMessage } from "../src/db/queries";
import type { Db } from "../src/db/types";
import type { Envelope } from "../src/realtime/events";

const ALICE = "a0000000-0000-4000-8000-000000000001";
const BOB = "b0000000-0000-4000-8000-000000000002";
const MALLORY = "c0000000-0000-4000-8000-000000000003";

let db: Db;
let n = 0;
const ev = (e: Omit<Envelope, "eventId" | "serverTs">): Envelope =>
  ({ ...e, eventId: `e${++n}`, serverTs: new Date().toISOString() }) as Envelope;
const msg = (from: string, id: string, text = "hi") =>
  ev({ type: "message", from, payload: { id, kind: "text", text, file: null, replyTo: null, forwarded: false, sentAt: new Date(Date.now() + n).toISOString() } });

async function mine(id: string, peerId: string) {
  await insertMessage(db, {
    id, peerId, fromMe: 1, kind: "text", text: "mine", fileJson: null, localUri: null, replyTo: null,
    forwarded: 0, tick: "sent", sentAt: new Date().toISOString(), myReaction: null, peerReaction: null, deleted: 0,
  });
}

beforeEach(async () => {
  db = memoryDb();
  await migrate(db);
});

describe("applyEvents", () => {
  test("incoming messages create the chat, count unread, and dedupe", async () => {
    const e = msg(ALICE, "m1", "hello");
    const r = await applyEvents(db, [e, e, { ...msg(ALICE, "m1"), eventId: "other" }]);
    expect(r.newIncoming.get(ALICE)).toEqual(["m1"]);
    expect(r.unknownPeers.has(ALICE)).toBe(true);
    const chats = await listChats(db);
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ peerId: ALICE, lastText: "hello", unread: 1 });
  });

  test("no unread bump when the chat is open", async () => {
    await applyEvents(db, [msg(ALICE, "m2")], { activePeerId: ALICE });
    expect((await listChats(db))[0]!.unread).toBe(0);
  });

  test("ticks only move forward and only from the right peer", async () => {
    await mine("x1", BOB);
    await applyEvents(db, [ev({ type: "receipt.delivered", from: MALLORY, payload: { messageIds: ["x1"], at: "" } })]);
    expect((await getMessage(db, "x1"))!.tick).toBe("sent");
    await applyEvents(db, [ev({ type: "receipt.read", from: BOB, payload: { messageIds: ["x1"], at: "" } })]);
    expect((await getMessage(db, "x1"))!.tick).toBe("read");
    await applyEvents(db, [ev({ type: "receipt.delivered", from: BOB, payload: { messageIds: ["x1"], at: "" } })]);
    expect((await getMessage(db, "x1"))!.tick).toBe("read");
  });

  test("a forged delete from someone else is ignored; the real sender's delete applies", async () => {
    await applyEvents(db, [msg(ALICE, "d1", "secret")]);
    await applyEvents(db, [ev({ type: "message.deleted", from: MALLORY, payload: { messageId: "d1", at: "" } })]);
    expect((await getMessage(db, "d1"))).toMatchObject({ deleted: 0, text: "secret" });
    // Bob cannot delete Alice's message by pretending, either; and nobody can delete my own messages remotely.
    await mine("d2", ALICE);
    await applyEvents(db, [ev({ type: "message.deleted", from: ALICE, payload: { messageId: "d2", at: "" } })]);
    expect((await getMessage(db, "d2"))!.deleted).toBe(0);

    await applyEvents(db, [ev({ type: "message.deleted", from: ALICE, payload: { messageId: "d1", at: "" } })]);
    expect((await getMessage(db, "d1"))).toMatchObject({ deleted: 1, text: null });
  });

  test("reactions apply only from the chat peer", async () => {
    await mine("r1", BOB);
    await applyEvents(db, [ev({ type: "reaction", from: MALLORY, payload: { messageId: "r1", emoji: "😈", at: "" } })]);
    expect((await getMessage(db, "r1"))!.peerReaction).toBeNull();
    await applyEvents(db, [ev({ type: "reaction", from: BOB, payload: { messageId: "r1", emoji: "❤️", at: "" } })]);
    expect((await getMessage(db, "r1"))!.peerReaction).toBe("❤️");
    await applyEvents(db, [ev({ type: "reaction", from: BOB, payload: { messageId: "r1", emoji: null, at: "" } })]);
    expect((await getMessage(db, "r1"))!.peerReaction).toBeNull();
  });
});
