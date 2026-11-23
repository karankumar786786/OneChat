import { describe, expect, test } from "bun:test";
import { api, Client, makeUser, sleep, useServer, type Ctx, type TestUser } from "./helpers.ts";
import { pushQueue } from "../src/jobs/queue.ts";

const ctx = useServer();
const msgId = () => Bun.randomUUIDv7();

/** Makes `a` connected to everyone else (groups only take people you have chatted with). */
async function connectAll(ctx: Ctx, a: TestUser, others: TestUser[]) {
  const c = await Client.connect(ctx, a.token);
  for (const o of others) {
    const r = await c.emit("message:send", { id: msgId(), to: o.id, kind: "text", text: "hi" });
    expect(r.ok).toBe(true);
  }
  c.close();
}

async function makeGroup(ctx: Ctx, admin: TestUser, members: TestUser[], name = "Friends") {
  await connectAll(ctx, admin, members);
  const res = await api(ctx, "POST", "/groups", { token: admin.token, body: { name, memberIds: members.map((m) => m.id) } });
  expect(res.status).toBe(201);
  return res.body;
}

describe("groups: create and manage", () => {
  test("create: creator is admin, everyone gets a 'created' event, only connections can be added", async () => {
    const a = await makeUser(ctx, "ga");
    const b = await makeUser(ctx, "gb");
    const stranger = await makeUser(ctx, "gx");
    await connectAll(ctx, a, [b]);

    const bad = await api(ctx, "POST", "/groups", { token: a.token, body: { name: "x", memberIds: [stranger.id] } });
    expect(bad.status).toBe(400);

    const g = (await api(ctx, "POST", "/groups", { token: a.token, body: { name: " Trip ", description: "Goa", memberIds: [b.id] } })).body;
    expect(g).toMatchObject({ name: "Trip", description: "Goa", myRole: "admin", memberCount: 2, onlyAdminsCanSend: false });
    expect(g.members.find((m: any) => m.user.id === a.id)).toMatchObject({ role: "admin", isCreator: true });

    const bob = await Client.connect(ctx, b.token);
    const created = await bob.waitForEvent((e) => e.type === "group.update");
    expect(created.payload).toMatchObject({ groupId: g.id, action: "created", actor: { id: a.id }, targets: [{ id: b.id }] });

    expect((await api(ctx, "GET", "/groups", { token: b.token })).body.groups.map((x: any) => x.id)).toContain(g.id);
    expect((await api(ctx, "GET", `/groups/${g.id}`, { token: stranger.token })).status).toBe(404);
    bob.close();
  });

  test("roles: only admins add/remove/promote; creator is protected; settings and info rules", async () => {
    const a = await makeUser(ctx, "ra");
    const b = await makeUser(ctx, "rb");
    const c = await makeUser(ctx, "rc");
    const g = await makeGroup(ctx, a, [b, c]);

    // Members cannot manage.
    expect((await api(ctx, "DELETE", `/groups/${g.id}/members/${c.id}`, { token: b.token })).status).toBe(403);
    expect((await api(ctx, "PATCH", `/groups/${g.id}/settings`, { token: b.token, body: { onlyAdminsCanSend: true } })).status).toBe(403);

    // Promote b; b can now manage, but cannot remove or demote the creator.
    expect((await api(ctx, "POST", `/groups/${g.id}/admins/${b.id}`, { token: a.token })).body.members.find((m: any) => m.user.id === b.id).role).toBe("admin");
    expect((await api(ctx, "DELETE", `/groups/${g.id}/members/${a.id}`, { token: b.token })).status).toBe(403);
    expect((await api(ctx, "DELETE", `/groups/${g.id}/admins/${a.id}`, { token: b.token })).status).toBe(403);

    // Anyone can edit info until admins restrict it. Unchanged fields are not announced.
    const carolSock = await Client.connect(ctx, c.token);
    expect((await api(ctx, "PATCH", `/groups/${g.id}`, { token: c.token, body: { name: "Renamed", description: null } })).status).toBe(200);
    const info = await carolSock.waitForEvent((e) => e.type === "group.update" && e.payload.action === "info");
    expect(info.payload.changes).toEqual({ name: "Renamed" });
    carolSock.close();
    await api(ctx, "PATCH", `/groups/${g.id}/settings`, { token: a.token, body: { onlyAdminsCanEditInfo: true } });
    expect((await api(ctx, "PATCH", `/groups/${g.id}`, { token: c.token, body: { name: "Nope" } })).status).toBe(403);

    // Remove c: c gets the event and loses access.
    const carol = await Client.connect(ctx, c.token);
    expect((await api(ctx, "DELETE", `/groups/${g.id}/members/${c.id}`, { token: b.token })).status).toBe(204);
    const removed = await carol.waitForEvent((e) => e.type === "group.update" && e.payload.action === "removed");
    expect(removed.payload.targets[0].id).toBe(c.id);
    expect((await api(ctx, "GET", `/groups/${g.id}`, { token: c.token })).status).toBe(404);
    carol.close();
  });

  test("last admin leaving hands admin to the longest-standing member; last member deletes the group", async () => {
    const a = await makeUser(ctx, "la");
    const b = await makeUser(ctx, "lb");
    const c = await makeUser(ctx, "lc");
    const g = await makeGroup(ctx, a, [b, c]);

    expect((await api(ctx, "POST", `/groups/${g.id}/leave`, { token: a.token })).status).toBe(204);
    const after = (await api(ctx, "GET", `/groups/${g.id}`, { token: b.token })).body;
    expect(after.memberCount).toBe(2);
    // b and c joined at the same moment, so either may be picked; exactly one becomes admin.
    const admins = after.members.filter((m: any) => m.role === "admin").map((m: any) => m.user.id);
    expect(admins).toHaveLength(1);
    expect([b.id, c.id]).toContain(admins[0]);

    const bob = await Client.connect(ctx, b.token);
    const left = await bob.waitForEvent((e) => e.type === "group.update" && e.payload.action === "left");
    expect(left.payload.actor.id).toBe(a.id);
    await bob.waitForEvent((e) => e.type === "group.update" && e.payload.action === "promoted" && e.payload.targets[0].id === admins[0]);
    bob.close();

    await api(ctx, "POST", `/groups/${g.id}/leave`, { token: b.token });
    await api(ctx, "POST", `/groups/${g.id}/leave`, { token: c.token });
    expect((await api(ctx, "GET", `/groups/${g.id}`, { token: c.token })).status).toBe(404);
  });

  test("invite links: admins get a code, anyone can preview and join, reset kills the old code", async () => {
    const a = await makeUser(ctx, "ia");
    const b = await makeUser(ctx, "ib");
    const joiner = await makeUser(ctx, "ij");
    const g = await makeGroup(ctx, a, [b]);

    expect((await api(ctx, "GET", `/groups/${g.id}/invite`, { token: b.token })).status).toBe(403);
    const { code } = (await api(ctx, "GET", `/groups/${g.id}/invite`, { token: a.token })).body;
    expect((await api(ctx, "GET", `/groups/${g.id}/invite`, { token: a.token })).body.code).toBe(code);

    const preview = await api(ctx, "GET", `/groups/invite/${code}`, { token: joiner.token });
    expect(preview.body).toMatchObject({ groupId: g.id, name: "Friends", memberCount: 2, alreadyMember: false });

    const joined = await api(ctx, "POST", `/groups/invite/${code}/join`, { token: joiner.token });
    expect(joined.status).toBe(200);
    expect(joined.body).toMatchObject({ memberCount: 3, myRole: "member" });

    const reset = (await api(ctx, "POST", `/groups/${g.id}/invite/reset`, { token: a.token })).body.code;
    expect(reset).not.toBe(code);
    expect((await api(ctx, "GET", `/groups/invite/${code}`, { token: joiner.token })).status).toBe(404);
    await api(ctx, "DELETE", `/groups/${g.id}/invite`, { token: a.token });
    expect((await api(ctx, "GET", `/groups/invite/${reset}`, { token: joiner.token })).status).toBe(404);
  });
});

describe("groups: messaging", () => {
  test("fan-out, per-member delivered and read receipts, typing, reactions", async () => {
    const a = await makeUser(ctx, "ma");
    const b = await makeUser(ctx, "mb");
    const c = await makeUser(ctx, "mc");
    const g = await makeGroup(ctx, a, [b, c]);

    const alice = await Client.connect(ctx, a.token);
    const bob = await Client.connect(ctx, b.token);

    const id = msgId();
    const sent = await alice.emit("message:send", { id, groupId: g.id, kind: "text", text: "hello all" });
    expect(sent.ok).toBe(true);
    expect([...sent.recipients].sort()).toEqual([b.id, c.id].sort());

    const got = await bob.waitForEvent((e) => e.type === "message" && e.payload.id === id);
    expect(got.from).toBe(a.id);
    expect(got.payload).toMatchObject({ groupId: g.id, text: "hello all" });

    // Bob's copy is delivered; Carol (offline) has not received hers yet.
    const d1 = await alice.waitForEvent((e) => e.type === "receipt.delivered" && e.from === b.id && e.payload.groupId === g.id);
    expect(d1.payload).toMatchObject({ messageIds: [id], groupId: g.id });

    const carol = await Client.connect(ctx, c.token);
    await carol.waitForEvent((e) => e.payload?.id === id);
    await alice.waitForEvent((e) => e.type === "receipt.delivered" && e.from === c.id && e.payload.groupId === g.id);

    // Read receipts go to the sender, one per reader.
    bob.socket.emit("message:read", { groupId: g.id, senderId: a.id, messageIds: [id] });
    const r1 = await alice.waitForEvent((e) => e.type === "receipt.read" && e.from === b.id && e.payload.groupId === g.id);
    expect(r1.payload.groupId).toBe(g.id);

    // Typing reaches every other online member with the group id.
    carol.socket.emit("typing", { groupId: g.id, on: true });
    expect(await alice.waitForOther("typing", (d) => d.groupId === g.id)).toEqual({ from: c.id, on: true, groupId: g.id });
    await bob.waitForOther("typing", (d) => d.groupId === g.id);

    // Reactions fan out to all other members.
    expect((await bob.emit("message:react", { groupId: g.id, messageId: id, emoji: "🎉" })).ok).toBe(true);
    const ra = await alice.waitForEvent((e) => e.type === "reaction");
    expect(ra.payload).toMatchObject({ messageId: id, emoji: "🎉", groupId: g.id });
    expect(ra.from).toBe(b.id);
    await carol.waitForEvent((e) => e.type === "reaction");

    // Retried send is deduplicated and returns the same recipients.
    const again = await alice.emit("message:send", { id, groupId: g.id, kind: "text", text: "hello all" });
    expect(again).toEqual(sent);
    for (const s of [alice, bob, carol]) s.close();
  });

  test("admins-only sending, admin delete, delete before delivery, non-members rejected", async () => {
    const a = await makeUser(ctx, "da");
    const b = await makeUser(ctx, "db");
    const c = await makeUser(ctx, "dc");
    const outsider = await makeUser(ctx, "do");
    const g = await makeGroup(ctx, a, [b, c]);
    const alice = await Client.connect(ctx, a.token);
    const bob = await Client.connect(ctx, b.token);

    // Outsider cannot send.
    const out = await Client.connect(ctx, outsider.token);
    expect((await out.emit("message:send", { id: msgId(), groupId: g.id, kind: "text", text: "hi" })).error.code).toBe("NOT_FOUND");
    out.close();

    // Bob's message is delivered to alice; alice (admin) deletes it for everyone.
    const bobsMsg = msgId();
    await bob.emit("message:send", { id: bobsMsg, groupId: g.id, kind: "text", text: "oops" });
    await alice.waitForEvent((e) => e.payload?.id === bobsMsg);
    expect((await bob.emit("message:delete", { groupId: g.id, messageId: bobsMsg, asAdmin: true })).error.code).toBe("FORBIDDEN");
    const del = await alice.emit("message:delete", { groupId: g.id, messageId: bobsMsg, asAdmin: true });
    expect(del.ok).toBe(true);
    const gone = await bob.waitForEvent((e) => e.type === "message.deleted");
    expect(gone.payload).toMatchObject({ messageId: bobsMsg, groupId: g.id, asAdmin: true });
    expect(gone.from).toBe(a.id);

    // Carol is offline: alice's own message is pulled from carol's queue before she connects.
    const early = msgId();
    await alice.emit("message:send", { id: early, groupId: g.id, kind: "text", text: "never mind" });
    await bob.waitForEvent((e) => e.payload?.id === early);
    await alice.emit("message:delete", { groupId: g.id, messageId: early });
    const carol = await Client.connect(ctx, c.token);
    await carol.waitForEvent((e) => e.type === "message.deleted" && e.payload.messageId === early);
    await sleep(200);
    expect(carol.events.find((e) => e.type === "message" && e.payload.id === early)).toBeUndefined();

    // Announcement mode: only admins may post.
    await api(ctx, "PATCH", `/groups/${g.id}/settings`, { token: a.token, body: { onlyAdminsCanSend: true } });
    const blocked = await bob.emit("message:send", { id: msgId(), groupId: g.id, kind: "text", text: "can I?" });
    expect(blocked.error.code).toBe("FORBIDDEN");
    expect((await alice.emit("message:send", { id: msgId(), groupId: g.id, kind: "text", text: "announcement" })).ok).toBe(true);
    const settings = await bob.waitForEvent((e) => e.type === "group.update" && e.payload.action === "settings");
    expect(settings.payload.changes).toEqual({ onlyAdminsCanSend: true });
    for (const s of [alice, bob, carol]) s.close();
  });

  test("push: offline members are notified unless muted; @mentions get through mute", async () => {
    const a = await makeUser(ctx, "pa");
    const b = await makeUser(ctx, "pb");
    const c = await makeUser(ctx, "pc");
    const g = await makeGroup(ctx, a, [b, c], "Family");
    const muted = await api(ctx, "PUT", `/groups/${g.id}/mute`, { token: c.token, body: { until: new Date(Date.now() + 3_600_000).toISOString() } });
    expect(muted.body.mutedUntil).not.toBeNull();

    const alice = await Client.connect(ctx, a.token);
    await alice.emit("message:send", { id: msgId(), groupId: g.id, kind: "text", text: "dinner?" });
    const jobs = async (userId: string) => (await pushQueue().getJobs(["delayed", "waiting"])).filter((j) => j.data.recipientId === userId && j.data.groupId === g.id);
    expect(await jobs(b.id)).toHaveLength(1);
    expect((await jobs(b.id))[0]!.data).toMatchObject({ groupName: "Family", senderUsername: a.username });
    expect(await jobs(c.id)).toHaveLength(0);

    await sleep(15_100); // next coalescing window
    const m = await alice.emit("message:send", { id: msgId(), groupId: g.id, kind: "text", text: `@${c.username} you too` });
    expect(m.ok).toBe(true);
    expect(await jobs(c.id)).toHaveLength(1);
    alice.close();
  }, 30_000);
});
