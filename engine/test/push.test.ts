import { describe, expect, test } from "bun:test";
import { api, Client, makeUser, useServer } from "./helpers.ts";
import { isOnline } from "../src/realtime/presence.ts";
import { prisma } from "../src/lib/prisma.ts";
import { pushQueue } from "../src/jobs/queue.ts";
import { previewFor, sendPush, type PushClient } from "../src/jobs/sendPush.ts";

const ctx = useServer();

function fakeExpo(failToken?: string) {
  const sent: any[] = [];
  const client: PushClient = {
    chunkPushNotifications: (m) => [m],
    sendPushNotificationsAsync: async (chunk) => {
      sent.push(...chunk);
      return chunk.map((m) =>
        m.to === failToken
          ? { status: "error" as const, message: "gone", details: { error: "DeviceNotRegistered" as const } }
          : { status: "ok" as const, id: "ticket" },
      );
    },
  };
  return { client, sent };
}

describe("push notifications", () => {
  test("a message to an offline user queues one coalesced push job", async () => {
    const a = await makeUser(ctx, "pa");
    const b = await makeUser(ctx, "pb");
    const alice = await Client.connect(ctx, a.token);
    await alice.emit("message:send", { id: Bun.randomUUIDv7(), to: b.id, kind: "text", text: "wake up" });
    await alice.emit("message:send", { id: Bun.randomUUIDv7(), to: b.id, kind: "text", text: "again" });
    const jobs = (await pushQueue().getJobs(["delayed", "waiting"])).filter((j) => j.data.recipientId === b.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toMatchObject({ senderId: a.id, senderUsername: a.username, preview: "wake up" });
    alice.close();
  });

  test("sendPush skips online users, sends to tokens, and drops dead tokens", async () => {
    const b = await makeUser(ctx, "pt");
    const good = `ExponentPushToken[good-${b.id}]`;
    const dead = `ExponentPushToken[dead-${b.id}]`;
    expect((await api(ctx, "PUT", "/devices/push-token", { token: b.token, body: { token: dead, platform: "ios" } })).status).toBe(204);
    const session = await prisma.pushToken.findUniqueOrThrow({ where: { token: dead } });
    await prisma.pushToken.create({ data: { token: good, userId: b.id, sessionId: session.sessionId, platform: "android" } });

    const job = { recipientId: b.id, senderId: b.id, senderUsername: "someone", preview: "hello" };
    const { client, sent } = fakeExpo(dead);
    expect(await sendPush(job, client)).toEqual({ sent: 1 });
    expect(sent.map((m) => m.to).sort()).toEqual([dead, good].sort());
    expect(sent[0]).toMatchObject({ title: "@someone", body: "hello", data: { type: "message" } });
    expect(await prisma.pushToken.findUnique({ where: { token: dead } })).toBeNull();

    const online = await Client.connect(ctx, b.token);
    for (let i = 0; i < 40 && !(await isOnline(b.id)); i++) await Bun.sleep(25);
    expect(await isOnline(b.id)).toBe(true);
    const second = fakeExpo();
    expect(await sendPush(job, second.client)).toEqual({ skipped: "online" });
    expect(second.sent).toHaveLength(0);
    online.close();
  });

  test("previews", () => {
    expect(previewFor("file", null, "image/png")).toBe("📷 Photo");
    expect(previewFor("file", "see this", "application/pdf")).toBe("📎 File: see this");
    expect(previewFor("text", "x".repeat(150))).toHaveLength(101);
  });
});
