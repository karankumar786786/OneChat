import { describe, expect, test } from "bun:test";
import { api, Client, makeUser, sleep, useServer, waitFor } from "./helpers.ts";

const ctx = useServer();
const msgId = () => Bun.randomUUIDv7();

describe("messaging and ticks", () => {
  test("offline recipient: 1 tick → delivered on connect → read; sender offline still gets receipts", async () => {
    const a = await makeUser(ctx, "ma");
    const b = await makeUser(ctx, "mb");
    const alice = await Client.connect(ctx, a.token);

    // 1 grey tick: the server accepted it while bob is offline.
    const id = msgId();
    const sent = await alice.emit("message:send", { id, to: b.id, kind: "text", text: "  hi bob  " });
    expect(sent).toMatchObject({ ok: true, messageId: id });
    expect(typeof sent.serverTs).toBe("string");

    // It is now a connection for both sides.
    const conns = await api(ctx, "GET", "/connections", { token: b.token });
    expect(conns.body.connections.map((c: any) => c.user.id)).toContain(a.id);

    // Bob connects and the queue drains.
    const bob = await Client.connect(ctx, b.token);
    const got = await bob.waitForEvent((e) => e.type === "message" && e.payload.id === id);
    expect(got.from).toBe(a.id);
    expect(got.payload.text).toBe("hi bob");

    // 2 grey ticks.
    const delivered = await alice.waitForEvent((e) => e.type === "receipt.delivered");
    expect(delivered.payload.messageIds).toEqual([id]);
    expect(delivered.from).toBe(b.id);

    // Alice goes offline before bob reads it.
    alice.close();
    await sleep(100);
    expect(await bob.emit("message:read", { peerId: a.id, messageIds: [id] })).toEqual({ ok: true });

    // 2 blue ticks arrive when alice comes back.
    const alice2 = await Client.connect(ctx, a.token);
    const read = await alice2.waitForEvent((e) => e.type === "receipt.read");
    expect(read.payload.messageIds).toEqual([id]);

    // Nothing left on the server for either of them.
    await sleep(150);
    const again = await Client.connect(ctx, b.token);
    await sleep(300);
    expect(again.events.filter((e) => e.payload.id === id)).toHaveLength(0);
    for (const c of [alice2, bob, again]) c.close();
  });

  test("live delivery, retry dedupe, reactions, and delete for everyone", async () => {
    const a = await makeUser(ctx, "la");
    const b = await makeUser(ctx, "lb");
    const alice = await Client.connect(ctx, a.token);
    const bob = await Client.connect(ctx, b.token);

    const id = msgId();
    const first = await alice.emit("message:send", { id, to: b.id, kind: "text", text: "live" });
    const retry = await alice.emit("message:send", { id, to: b.id, kind: "text", text: "live" });
    expect(retry).toEqual(first);
    await bob.waitForEvent((e) => e.payload?.id === id);
    await sleep(200);
    expect(bob.events.filter((e) => e.type === "message" && e.payload.id === id)).toHaveLength(1);

    expect(await bob.emit("message:react", { peerId: a.id, messageId: id, emoji: "❤️" })).toEqual({ ok: true });
    const reaction = await alice.waitForEvent((e) => e.type === "reaction");
    expect(reaction.payload).toMatchObject({ messageId: id, emoji: "❤️" });
    expect(reaction.from).toBe(b.id);

    const del = await alice.emit("message:delete", { peerId: b.id, messageId: id });
    expect(del).toEqual({ ok: true, retracted: false });
    const gone = await bob.waitForEvent((e) => e.type === "message.deleted");
    expect(gone.payload.messageId).toBe(id);
    expect(gone.from).toBe(a.id);
    alice.close();
    bob.close();
  });

  test("deleting an undelivered message pulls it from the queue", async () => {
    const a = await makeUser(ctx, "da");
    const b = await makeUser(ctx, "db");
    const alice = await Client.connect(ctx, a.token);
    const id = msgId();
    await alice.emit("message:send", { id, to: b.id, kind: "text", text: "oops" });
    expect(await alice.emit("message:delete", { peerId: b.id, messageId: id })).toEqual({ ok: true, retracted: true });

    const bob = await Client.connect(ctx, b.token);
    await sleep(400);
    expect(bob.events).toHaveLength(0);
    alice.close();
    bob.close();
  });

  test("unacked events are sent again on the next connect", async () => {
    const a = await makeUser(ctx, "ua");
    const b = await makeUser(ctx, "ub");
    const alice = await Client.connect(ctx, a.token);
    const id = msgId();
    await alice.emit("message:send", { id, to: b.id, kind: "text", text: "are you there" });

    const lazy = await Client.connect(ctx, b.token, { autoAck: false });
    await lazy.waitForEvent((e) => e.payload?.id === id);
    lazy.close();
    await sleep(100);

    const bob = await Client.connect(ctx, b.token);
    await bob.waitForEvent((e) => e.payload?.id === id);
    // Delivered tick only after the real ack.
    await alice.waitForEvent((e) => e.type === "receipt.delivered");
    alice.close();
    bob.close();
  });

  test("validation and self-messages are rejected", async () => {
    const a = await makeUser(ctx, "va");
    const alice = await Client.connect(ctx, a.token);
    const bad = await alice.emit("message:send", { id: "nope", to: a.id, kind: "text" });
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe("VALIDATION_FAILED");
    const self = await alice.emit("message:send", { id: msgId(), to: a.id, kind: "text", text: "me" });
    expect(self.error.code).toBe("BAD_REQUEST");
    const ghost = await alice.emit("message:send", { id: msgId(), to: crypto.randomUUID(), kind: "text", text: "?" });
    expect(ghost.error.code).toBe("NOT_FOUND");
    alice.close();
  });
});

describe("typing and presence", () => {
  test("typing reaches an online connection and is never queued", async () => {
    const a = await makeUser(ctx, "ta");
    const b = await makeUser(ctx, "tb");
    const alice = await Client.connect(ctx, a.token);
    // Not connected yet: typing is ignored.
    alice.socket.emit("typing", { to: b.id, on: true });
    await alice.emit("message:send", { id: msgId(), to: b.id, kind: "text", text: "hey" });

    // Bob offline: typing is dropped.
    alice.socket.emit("typing", { to: b.id, on: true });
    await sleep(100);
    const bob = await Client.connect(ctx, b.token);
    await sleep(300);
    expect(bob.other.filter((o) => o.event === "typing")).toHaveLength(0);

    alice.socket.emit("typing", { to: b.id, on: true });
    const t = await bob.waitForOther("typing");
    expect(t).toEqual({ from: a.id, on: true });
    alice.close();
    bob.close();
  });

  test("presence updates go to connections only, with last seen", async () => {
    const a = await makeUser(ctx, "pa");
    const b = await makeUser(ctx, "pb");
    const stranger = await makeUser(ctx, "ps");
    const alice = await Client.connect(ctx, a.token);
    await alice.emit("message:send", { id: msgId(), to: b.id, kind: "text", text: "yo" });

    const bob = await Client.connect(ctx, b.token);
    const watcher = await Client.connect(ctx, stranger.token);
    const online = await alice.waitForOther("presence:update", (d) => d.userId === b.id && d.online);
    expect(online.lastSeenAt).toBeNull();

    const q = await alice.emit("presence:query", { userIds: [b.id, stranger.id] });
    expect(q.presence).toEqual([{ userId: b.id, online: true, lastSeenAt: null }]);

    bob.close();
    const offline = await alice.waitForOther("presence:update", (d) => d.userId === b.id && !d.online);
    expect(typeof offline.lastSeenAt).toBe("string");

    const list = await api(ctx, "GET", "/connections", { token: a.token });
    const entry = list.body.connections.find((c: any) => c.user.id === b.id);
    expect(entry).toMatchObject({ online: false });
    expect(entry.lastSeenAt).toBe(offline.lastSeenAt);

    await sleep(200);
    expect(watcher.other.filter((o) => o.event === "presence:update")).toHaveLength(0);
    alice.close();
    watcher.close();
  });
});

describe("blocking", () => {
  test("messages from a blocked user are silently dropped; blocker cannot send", async () => {
    const a = await makeUser(ctx, "ba");
    const b = await makeUser(ctx, "bb");
    const alice = await Client.connect(ctx, a.token);
    await alice.emit("message:send", { id: msgId(), to: b.id, kind: "text", text: "before" });
    const bob = await Client.connect(ctx, b.token);
    await bob.waitForEvent((e) => e.type === "message");

    await api(ctx, "POST", `/blocks/${a.id}`, { token: b.token });

    const dropped = msgId();
    const res = await alice.emit("message:send", { id: dropped, to: b.id, kind: "text", text: "after" });
    expect(res.ok).toBe(true); // alice sees one tick, nothing more
    const back = await bob.emit("message:send", { id: msgId(), to: a.id, kind: "text", text: "hi" });
    expect(back.error.code).toBe("FORBIDDEN");

    alice.socket.emit("typing", { to: b.id, on: true });
    await sleep(400);
    expect(bob.events.find((e) => e.payload?.id === dropped)).toBeUndefined();
    expect(bob.other.filter((o) => o.event === "typing")).toHaveLength(0);

    const q = await alice.emit("presence:query", { userIds: [b.id] });
    expect(q.presence).toEqual([]);

    const list = await api(ctx, "GET", "/connections", { token: b.token });
    expect(list.body.connections.find((c: any) => c.user.id === a.id)).toMatchObject({ blockedByMe: true, online: false });
    alice.close();
    bob.close();
  });
});

describe("rate of many messages", () => {
  test("a large offline backlog drains in order across pages", async () => {
    const a = await makeUser(ctx, "ra");
    const b = await makeUser(ctx, "rb");
    const alice = await Client.connect(ctx, a.token);
    const ids: string[] = [];
    for (let i = 0; i < 230; i++) {
      const id = msgId();
      ids.push(id);
      const r = await alice.emit("message:send", { id, to: b.id, kind: "text", text: `m${i}` });
      expect(r.ok).toBe(true);
    }
    const bob = await Client.connect(ctx, b.token);
    await waitFor(() => bob.events.filter((e) => e.type === "message").length >= 230, 8000, "backlog");
    expect(bob.events.filter((e) => e.type === "message").map((e) => e.payload.id)).toEqual(ids);
    alice.close();
    bob.close();
  });
});
