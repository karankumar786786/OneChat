import { beforeEach, describe, expect, test } from "bun:test";
import { memoryDb } from "./sqlite";
import { migrate } from "../src/db/schema";
import { applyEvents, recomputeGroupTick } from "../src/realtime/apply";
import { getMessage, insertMessage, listChats, listMessages } from "../src/db/queries";
import { getGroup, saveGroup } from "../src/db/groups";
import { describeGroupUpdate } from "../src/groups/describe";
import type { Db } from "../src/db/types";
import type { Envelope } from "../src/realtime/events";

const ME = "00000000-0000-4000-8000-00000000000a";
const BOB = "00000000-0000-4000-8000-00000000000b";
const CAROL = "00000000-0000-4000-8000-00000000000c";
const G = "99999999-0000-4000-8000-000000000001";

let db: Db;
let n = 0;
const ev = (e: Omit<Envelope, "eventId" | "serverTs">): Envelope => ({ ...e, eventId: `e${++n}`, serverTs: new Date().toISOString() }) as Envelope;
const user = (id: string, username: string) => ({ id, username, displayName: null, avatarFileId: null, avatarUrl: null });

beforeEach(async () => {
  db = memoryDb();
  await migrate(db);
  await saveGroup(db, {
    id: G, name: "Trip", description: null, avatarFileId: null, avatarUrl: null, onlyAdminsCanSend: false,
    onlyAdminsCanEditInfo: false, createdById: BOB, myRole: "member", mutedUntil: null,
    members: [
      { user: user(BOB, "bob"), role: "admin", isCreator: true },
      { user: user(ME, "me"), role: "member", isCreator: false },
      { user: user(CAROL, "carol"), role: "member", isCreator: false },
    ],
  });
});

async function myGroupMessage(id: string) {
  await insertMessage(db, {
    id, peerId: G, fromMe: 1, kind: "text", text: "hi all", fileJson: null, localUri: null, replyTo: null, forwarded: 0,
    tick: "sent", sentAt: new Date().toISOString(), myReaction: null, peerReaction: null, deleted: 0,
    recipientsJson: JSON.stringify([BOB, CAROL]),
  });
}

describe("group events", () => {
  test("incoming group message lands in the group chat with sender and preview", async () => {
    await applyEvents(db, [ev({ type: "message", from: BOB, payload: { id: "m1", kind: "text", text: "hello @me", file: null, replyTo: null, forwarded: false, sentAt: new Date().toISOString(), groupId: G, mentions: [ME] } })], { myId: ME });
    const [msg] = await listMessages(db, G);
    expect(msg).toMatchObject({ peerId: G, senderId: BOB, tick: "received", mentionsJson: JSON.stringify([ME]) });
    expect((await listChats(db))[0]).toMatchObject({ peerId: G, kind: "group", lastText: "@bob: hello @me", unread: 1 });
  });

  test("ticks: ✓✓ only when every recipient got it, blue only when every one read it", async () => {
    await myGroupMessage("x1");
    const r = (type: "receipt.delivered" | "receipt.read", from: string) =>
      ev({ type, from, payload: { messageIds: ["x1"], at: new Date().toISOString(), groupId: G } });

    await applyEvents(db, [r("receipt.delivered", BOB)]);
    expect((await getMessage(db, "x1"))!.tick).toBe("sent");
    await applyEvents(db, [r("receipt.delivered", CAROL)]);
    expect((await getMessage(db, "x1"))!.tick).toBe("delivered");
    await applyEvents(db, [r("receipt.read", BOB)]);
    expect((await getMessage(db, "x1"))!.tick).toBe("delivered");
    await applyEvents(db, [r("receipt.read", CAROL)]);
    expect((await getMessage(db, "x1"))!.tick).toBe("read");
    // Re-evaluating never moves backwards.
    expect(await recomputeGroupTick(db, "x1")).toBe(false);
    const rows = await db.all<{ userId: string; deliveredAt: string; readAt: string }>("SELECT * FROM receipts WHERE messageId = 'x1'");
    expect(rows).toHaveLength(2);
    expect(rows.every((x) => x.deliveredAt && x.readAt)).toBe(true);
  });

  test("delete: sender can, an admin can (marked as admin), a plain member cannot", async () => {
    const msg = (id: string, from: string) => ev({ type: "message", from, payload: { id, kind: "text", text: "t", file: null, replyTo: null, forwarded: false, sentAt: new Date().toISOString(), groupId: G, mentions: [] } });
    await applyEvents(db, [msg("d1", CAROL), msg("d2", CAROL)]);
    const del = (id: string, from: string, asAdmin: boolean) => ev({ type: "message.deleted", from, payload: { messageId: id, at: "", groupId: G, asAdmin } });

    // Bob is an admin but did not claim admin; he is not the sender, so nothing happens.
    await applyEvents(db, [del("d1", BOB, false)]);
    expect((await getMessage(db, "d1"))!.deleted).toBe(0);
    // Carol is not an admin; claiming admin does not help her delete others' messages (d1 is hers anyway).
    await applyEvents(db, [del("d1", CAROL, false)]);
    expect((await getMessage(db, "d1"))!.deleted).toBe(1);
    await applyEvents(db, [del("d2", BOB, true)]);
    expect((await getMessage(db, "d2"))).toMatchObject({ deleted: 2, text: null });

    await myGroupMessage("d3");
    await applyEvents(db, [del("d3", CAROL, true)]); // not an admin
    expect((await getMessage(db, "d3"))!.deleted).toBe(0);
  });

  test("reactions from several members are all kept", async () => {
    await myGroupMessage("r1");
    const react = (from: string, emoji: string | null) => ev({ type: "reaction", from, payload: { messageId: "r1", emoji, at: "", groupId: G } });
    await applyEvents(db, [react(BOB, "❤️"), react(CAROL, "😂")]);
    expect((await listMessages(db, G))[0]!.otherReactions?.length).toBeGreaterThan(0);
    await applyEvents(db, [react(BOB, null)]);
    expect((await listMessages(db, G))[0]!.otherReactions).toBe("😂");
  });

  test("group updates become system lines; being removed ends membership", async () => {
    const upd = (payload: any) => ev({ type: "group.update", from: payload.actor.id, payload: { groupId: G, at: new Date().toISOString(), targets: [], changes: null, ...payload } });
    const res = await applyEvents(db, [upd({ action: "info", actor: { id: BOB, username: "bob" }, changes: { name: "Goa trip" } })], { myId: ME });
    expect(res.refreshGroups.has(G)).toBe(true);
    expect((await getGroup(db, G))!.name).toBe("Goa trip");
    expect((await listChats(db))[0]!.displayName).toBe("Goa trip");

    await applyEvents(db, [upd({ action: "removed", actor: { id: BOB, username: "bob" }, targets: [{ id: ME, username: "me" }] })], { myId: ME });
    expect((await getGroup(db, G))!.isMember).toBe(0);
    const lines = (await listMessages(db, G)).filter((m) => m.kind === "system").map((m) => m.text);
    expect(lines).toContain('@bob changed the group name to "Goa trip"');
    expect(lines).toContain("@bob removed You");
  });

  test("system line wording", () => {
    const base = { groupId: G, at: "", targets: [], changes: null };
    expect(describeGroupUpdate({ ...base, action: "added", actor: { id: ME, username: "me" }, targets: [{ id: BOB, username: "bob" }, { id: CAROL, username: "carol" }] }, ME)).toBe("You added @bob, @carol");
    expect(describeGroupUpdate({ ...base, action: "promoted", actor: { id: BOB, username: "bob" }, targets: [{ id: ME, username: "me" }] }, ME)).toBe("You're now an admin");
    expect(describeGroupUpdate({ ...base, action: "settings", actor: { id: BOB, username: "bob" }, changes: { onlyAdminsCanSend: true } }, ME)).toBe("@bob changed this group's settings to allow only admins to send messages");
  });
});
