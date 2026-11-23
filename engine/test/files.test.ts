import { describe, expect, mock, test } from "bun:test";

/**
 * S3 is replaced with an in-memory fake so the file rules (grants, forward TTL refresh,
 * expiry) can be tested without a bucket. The real S3 calls are thin wrappers in src/lib/s3.ts.
 */
const uploaded = new Map<string, number>();
const refreshed: string[] = [];
const deleted: string[] = [];
mock.module("../src/lib/s3.ts", () => ({
  s3: {},
  UPLOAD_URL_TTL_SECONDS: 600,
  DOWNLOAD_URL_TTL_SECONDS: 300,
  storageConfigured: () => true,
  presignUpload: async (key: string, mime: string) => ({ url: "https://test-bucket.s3.test/", fields: { key, "Content-Type": mime } }),
  presignDownload: async (key: string) => `https://download.test/${key}`,
  headObject: async (key: string) => (uploaded.has(key) ? { size: uploaded.get(key)! } : null),
  refreshObjectAge: async (key: string) => void refreshed.push(key),
  deleteObjects: async (keys: string[]) => void deleted.push(...keys),
}));

const { api, Client, makeUser, useServer } = await import("./helpers.ts");
const { prisma } = await import("../src/lib/prisma.ts");
const { cleanupExpiredFiles } = await import("../src/modules/files/service.ts");

const ctx = useServer();
const DAY = 86_400_000;

async function upload(token: string, purpose: "chat" | "status" | "avatar", mime = "image/png", size = 1234) {
  const start = await api(ctx, "POST", "/files/upload-url", { token, body: { mime, size, name: "pic.png", purpose } });
  expect(start.status).toBe(201);
  uploaded.set(start.body.upload.fields.key, size);
  const done = await api(ctx, "POST", `/files/${start.body.file.id}/complete`, { token });
  expect(done.status).toBe(200);
  return done.body;
}

describe("files", () => {
  test("upload limits and completion", async () => {
    const a = await makeUser(ctx, "fa");
    const big = await api(ctx, "POST", "/files/upload-url", { token: a.token, body: { mime: "video/mp4", size: 500 * 1024 * 1024, purpose: "chat" } });
    expect(big.status).toBe(413);
    const pdfAvatar = await api(ctx, "POST", "/files/upload-url", { token: a.token, body: { mime: "application/pdf", size: 10, purpose: "avatar" } });
    expect(pdfAvatar.status).toBe(400);

    const start = await api(ctx, "POST", "/files/upload-url", { token: a.token, body: { mime: "application/pdf", size: 99, purpose: "chat" } });
    expect(start.body.upload.fields.key).toBe(`chat/${start.body.file.id}`);
    const early = await api(ctx, "POST", `/files/${start.body.file.id}/complete`, { token: a.token });
    expect(early.status).toBe(400);

    uploaded.set(start.body.upload.fields.key, 99);
    const done = await api(ctx, "POST", `/files/${start.body.file.id}/complete`, { token: a.token });
    expect(done.body.state).toBe("ready");
    const expires = new Date(done.body.expiresAt).getTime();
    expect(Math.abs(expires - (Date.now() + 30 * DAY))).toBeLessThan(60_000);
  });

  test("sharing grants access; forwarding resets the 30-day clock; expiry blocks downloads", async () => {
    const a = await makeUser(ctx, "sa");
    const b = await makeUser(ctx, "sb");
    const c = await makeUser(ctx, "sc");
    const stranger = await makeUser(ctx, "sx");
    const file = await upload(a.token, "chat", "image/jpeg");

    const alice = await Client.connect(ctx, a.token);
    const bob = await Client.connect(ctx, b.token);
    const carol = await Client.connect(ctx, c.token);

    const send = await alice.emit("message:send", { id: Bun.randomUUIDv7(), to: b.id, kind: "file", fileId: file.id, text: "look" });
    expect(send.ok).toBe(true);
    const msg = await bob.waitForEvent((e) => e.type === "message");
    expect(msg.payload.file).toMatchObject({ id: file.id, mime: "image/jpeg", name: "pic.png" });

    expect((await api(ctx, "GET", `/files/${file.id}/download-url`, { token: b.token })).status).toBe(200);
    expect((await api(ctx, "GET", `/files/${file.id}/download-url`, { token: stranger.token })).status).toBe(404);
    // A stranger cannot send someone else's file either.
    const steal = await Client.connect(ctx, stranger.token);
    const stolen = await steal.emit("message:send", { id: Bun.randomUUIDv7(), to: c.id, kind: "file", fileId: file.id });
    expect(stolen.error.code).toBe("FORBIDDEN");
    steal.close();

    // Uploaded two days ago: a forward copies the object in place and moves expiry to now + 30d.
    const twoDaysAgo = new Date(Date.now() - 2 * DAY);
    await prisma.file.update({ where: { id: file.id }, data: { lastRefreshedAt: twoDaysAgo, expiresAt: new Date(twoDaysAgo.getTime() + 30 * DAY) } });
    const fwd = await bob.emit("message:send", { id: Bun.randomUUIDv7(), to: c.id, kind: "file", fileId: file.id, forwarded: true });
    expect(fwd.ok).toBe(true);
    const forwarded = await carol.waitForEvent((e) => e.type === "message");
    expect(forwarded.payload.forwarded).toBe(true);
    expect(refreshed).toContain(`chat/${file.id}`);
    const after = await prisma.file.findUniqueOrThrow({ where: { id: file.id } });
    expect(Math.abs(after.expiresAt!.getTime() - (Date.now() + 30 * DAY))).toBeLessThan(60_000);
    expect((await api(ctx, "GET", `/files/${file.id}/download-url`, { token: c.token })).status).toBe(200);

    // A second forward the same day does not copy again (S3 lifecycle counts whole days).
    const copies = refreshed.length;
    await carol.emit("message:send", { id: Bun.randomUUIDv7(), to: a.id, kind: "file", fileId: file.id, forwarded: true });
    expect(refreshed.length).toBe(copies);

    // Expired: no downloads, no sending, and the cleanup job removes it.
    await prisma.file.update({ where: { id: file.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await api(ctx, "GET", `/files/${file.id}/download-url`, { token: b.token });
    expect(expired.status).toBe(410);
    const resend = await alice.emit("message:send", { id: Bun.randomUUIDv7(), to: b.id, kind: "file", fileId: file.id });
    expect(resend.error.code).toBe("GONE");

    expect(await cleanupExpiredFiles()).toBeGreaterThanOrEqual(1);
    expect(deleted).toContain(`chat/${file.id}`);
    expect(await prisma.file.findUnique({ where: { id: file.id } })).toBeNull();
    for (const s of [alice, bob, carol]) s.close();
  });

  test("avatar upload shows up on the profile", async () => {
    const a = await makeUser(ctx, "av");
    const file = await upload(a.token, "avatar");
    expect(file.expiresAt).toBeNull();
    const me = await api(ctx, "PATCH", "/me", { token: a.token, body: { avatarFileId: file.id, displayName: "Ava" } });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ displayName: "Ava", avatarFileId: file.id, avatarUrl: `https://download.test/avatar/${file.id}` });
  });

  test("image status needs a status upload of the right type", async () => {
    const a = await makeUser(ctx, "is");
    const chatFile = await upload(a.token, "chat");
    const wrongPurpose = await api(ctx, "POST", "/statuses", { token: a.token, body: { type: "image", fileId: chatFile.id } });
    expect(wrongPurpose.status).toBe(400);
    const video = await upload(a.token, "status", "video/mp4");
    const wrongType = await api(ctx, "POST", "/statuses", { token: a.token, body: { type: "image", fileId: video.id } });
    expect(wrongType.status).toBe(400);
    const img = await upload(a.token, "status", "image/webp");
    const ok = await api(ctx, "POST", "/statuses", { token: a.token, body: { type: "image", fileId: img.id, text: "caption" } });
    expect(ok.status).toBe(201);
    expect(ok.body.media).toMatchObject({ fileId: img.id, mime: "image/webp", url: `https://download.test/status/${img.id}` });
    const f = await prisma.file.findUniqueOrThrow({ where: { id: img.id } });
    expect(f.expiresAt!.toISOString()).toBe(ok.body.expiresAt);
  });
});
