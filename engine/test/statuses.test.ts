import { describe, expect, test } from "bun:test";
import { api, Client, makeUser, useServer, type Ctx, type TestUser } from "./helpers.ts";
import { prisma } from "../src/lib/prisma.ts";
import { cleanupExpiredStatuses } from "../src/modules/statuses/service.ts";

const ctx = useServer();

async function connect(ctx: Ctx, a: TestUser, b: TestUser) {
  const c = await Client.connect(ctx, a.token);
  const r = await c.emit("message:send", { id: Bun.randomUUIDv7(), to: b.id, kind: "text", text: "hi" });
  expect(r.ok).toBe(true);
  c.close();
}

describe("statuses", () => {
  test("visible to connections only, with live notification and view log", async () => {
    const a = await makeUser(ctx, "sta");
    const b = await makeUser(ctx, "stb");
    const stranger = await makeUser(ctx, "stx");
    await connect(ctx, a, b);

    const bob = await Client.connect(ctx, b.token);
    const alice = await Client.connect(ctx, a.token);
    const created = await api(ctx, "POST", "/statuses", { token: a.token, body: { type: "text", text: "Good morning", bg: "#123456" } });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const ttl = new Date(created.body.expiresAt).getTime() - new Date(created.body.createdAt).getTime();
    expect(ttl).toBe(24 * 3_600_000);

    expect((await bob.waitForOther("status:new")).statusId).toBe(id);

    const feed = await api(ctx, "GET", "/statuses/feed", { token: b.token });
    expect(feed.body.feed).toHaveLength(1);
    expect(feed.body.feed[0]).toMatchObject({ user: { id: a.id }, hasUnviewed: true });
    expect(feed.body.feed[0].statuses[0]).toMatchObject({ id, text: "Good morning", viewedByMe: false, myReaction: null });

    expect((await api(ctx, "GET", "/statuses/feed", { token: stranger.token })).body.feed).toHaveLength(0);
    expect((await api(ctx, "GET", `/statuses/${id}`, { token: stranger.token })).status).toBe(404);
    expect((await api(ctx, "POST", `/statuses/${id}/view`, { token: stranger.token })).status).toBe(404);

    // Viewing twice logs once. The owner's own view is not logged.
    expect((await api(ctx, "POST", `/statuses/${id}/view`, { token: b.token })).status).toBe(204);
    expect((await api(ctx, "POST", `/statuses/${id}/view`, { token: b.token })).status).toBe(204);
    expect((await api(ctx, "POST", `/statuses/${id}/view`, { token: a.token })).status).toBe(204);
    const viewed = await alice.waitForOther("status:viewed");
    expect(viewed.viewer.id).toBe(b.id);

    expect((await api(ctx, "POST", `/statuses/${id}/react`, { token: b.token, body: { emoji: "🔥" } })).status).toBe(204);
    expect((await alice.waitForOther("status:reaction")).reaction).toBe("🔥");
    expect((await api(ctx, "POST", `/statuses/${id}/react`, { token: a.token, body: { emoji: "🔥" } })).status).toBe(403);

    const views = await api(ctx, "GET", `/statuses/${id}/views`, { token: a.token });
    expect(views.body.views).toHaveLength(1);
    expect(views.body.views[0]).toMatchObject({ viewer: { id: b.id }, reaction: "🔥" });
    expect((await api(ctx, "GET", `/statuses/${id}/views`, { token: b.token })).status).toBe(404);

    const feed2 = await api(ctx, "GET", "/statuses/feed", { token: b.token });
    expect(feed2.body.feed[0]).toMatchObject({ hasUnviewed: false });
    expect(feed2.body.feed[0].statuses[0]).toMatchObject({ viewedByMe: true, myReaction: "🔥" });

    const mine = await api(ctx, "GET", "/statuses/mine", { token: a.token });
    expect(mine.body.statuses[0]).toMatchObject({ id, viewCount: 1, commentCount: 0 });
    alice.close();
    bob.close();
  });

  test("comments are private between the commenter and the owner", async () => {
    const owner = await makeUser(ctx, "co");
    const b = await makeUser(ctx, "cb");
    const d = await makeUser(ctx, "cd");
    await connect(ctx, owner, b);
    await connect(ctx, d, owner);
    const ownerSock = await Client.connect(ctx, owner.token);
    const { body: status } = await api(ctx, "POST", "/statuses", { token: owner.token, body: { type: "text", text: "Q?" } });

    const c1 = await api(ctx, "POST", `/statuses/${status.id}/comments`, { token: b.token, body: { text: "from b" } });
    expect(c1.status).toBe(201);
    expect((await ownerSock.waitForOther("status:comment")).text).toBe("from b");
    await api(ctx, "POST", `/statuses/${status.id}/comments`, { token: d.token, body: { text: "from d" } });
    expect((await api(ctx, "POST", `/statuses/${status.id}/comments`, { token: owner.token, body: { text: "self" } })).status).toBe(403);

    const forOwner = await api(ctx, "GET", `/statuses/${status.id}/comments`, { token: owner.token });
    expect(forOwner.body.comments.map((c: any) => c.text)).toEqual(["from b", "from d"]);
    const forB = await api(ctx, "GET", `/statuses/${status.id}/comments`, { token: b.token });
    expect(forB.body.comments.map((c: any) => c.text)).toEqual(["from b"]);

    // Commenting counts as a view.
    const views = await api(ctx, "GET", `/statuses/${status.id}/views`, { token: owner.token });
    expect(views.body.views).toHaveLength(2);
    ownerSock.close();
  });

  test("blocking hides statuses; expired statuses vanish and are cleaned up", async () => {
    const a = await makeUser(ctx, "ea");
    const b = await makeUser(ctx, "eb");
    await connect(ctx, a, b);
    const { body: s } = await api(ctx, "POST", "/statuses", { token: a.token, body: { type: "text", text: "brb" } });
    await api(ctx, "POST", `/statuses/${s.id}/view`, { token: b.token });
    await api(ctx, "POST", `/statuses/${s.id}/comments`, { token: b.token, body: { text: "ok" } });

    await api(ctx, "POST", `/blocks/${b.id}`, { token: a.token });
    expect((await api(ctx, "GET", "/statuses/feed", { token: b.token })).body.feed).toHaveLength(0);
    await api(ctx, "DELETE", `/blocks/${b.id}`, { token: a.token });
    expect((await api(ctx, "GET", "/statuses/feed", { token: b.token })).body.feed).toHaveLength(1);

    await prisma.status.update({ where: { id: s.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await api(ctx, "GET", "/statuses/feed", { token: b.token })).body.feed).toHaveLength(0);
    expect((await api(ctx, "GET", `/statuses/${s.id}`, { token: b.token })).status).toBe(404);
    expect((await api(ctx, "GET", "/statuses/mine", { token: a.token })).body.statuses).toHaveLength(0);

    expect(await cleanupExpiredStatuses()).toBeGreaterThanOrEqual(1);
    expect(await prisma.status.findUnique({ where: { id: s.id } })).toBeNull();
    expect(await prisma.statusView.count({ where: { statusId: s.id } })).toBe(0);
    expect(await prisma.statusComment.count({ where: { statusId: s.id } })).toBe(0);
  });

  test("text status validation and deleting early", async () => {
    const a = await makeUser(ctx, "dv");
    expect((await api(ctx, "POST", "/statuses", { token: a.token, body: { type: "text", text: "   " } })).status).toBe(400);
    expect((await api(ctx, "POST", "/statuses", { token: a.token, body: { type: "text", text: "x", bg: "red" } })).status).toBe(400);
    expect((await api(ctx, "POST", "/statuses", { token: a.token, body: { type: "image" } })).status).toBe(400);
    const { body: s } = await api(ctx, "POST", "/statuses", { token: a.token, body: { type: "text", text: "temp" } });
    expect((await api(ctx, "DELETE", `/statuses/${s.id}`, { token: a.token })).status).toBe(204);
    expect((await api(ctx, "GET", `/statuses/${s.id}`, { token: a.token })).status).toBe(404);
  });
});
