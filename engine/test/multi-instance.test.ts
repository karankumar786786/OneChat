import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, Client, makeUser, type Ctx } from "./helpers.ts";

/**
 * Two separate engine processes sharing Postgres and Redis, the way they run behind a
 * load balancer. Alice is on one, Bob on the other; everything must still flow.
 */
const procs: ReturnType<typeof Bun.spawn>[] = [];
const one: Ctx = { port: 0, base: "" };
const two: Ctx = { port: 0, base: "" };

async function spawnEngine(ctx: Ctx, port: number) {
  const proc = Bun.spawn(["bun", "src/index.ts"], {
    env: { ...process.env, PORT: String(port), RUN_WORKERS: "false" },
    stdout: "ignore",
    stderr: "inherit",
  });
  procs.push(proc);
  ctx.port = port;
  ctx.base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${ctx.base}/health`)).ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`engine on ${port} did not start`);
}

beforeAll(async () => {
  const base = 20000 + Math.floor(Math.random() * 20000);
  await Promise.all([spawnEngine(one, base), spawnEngine(two, base + 1)]);
});

afterAll(() => {
  for (const p of procs) p.kill();
});

describe("multiple engine instances", () => {
  test("messages, receipts and presence cross instances through Redis", async () => {
    const a = await makeUser(one, "mia");
    const b = await makeUser(two, "mib");
    const alice = await Client.connect(one, a.token);

    const id = Bun.randomUUIDv7();
    expect((await alice.emit("message:send", { id, to: b.id, kind: "text", text: "cross" })).ok).toBe(true);

    const bob = await Client.connect(two, b.token);
    expect((await bob.waitForEvent((e) => e.payload?.id === id)).from).toBe(a.id);
    expect((await alice.waitForEvent((e) => e.type === "receipt.delivered")).payload.messageIds).toEqual([id]);
    await alice.waitForOther("presence:update", (d) => d.userId === b.id && d.online);

    // Live (not queued-then-drained) delivery across instances.
    const live = Bun.randomUUIDv7();
    await alice.emit("message:send", { id: live, to: b.id, kind: "text", text: "live cross" });
    await bob.waitForEvent((e) => e.payload?.id === live);

    bob.socket.emit("typing", { to: a.id, on: true });
    expect(await alice.waitForOther("typing")).toEqual({ from: b.id, on: true });

    // Signing in on instance one kicks the socket on instance two.
    const relog = await api(one, "POST", "/auth/login", { body: { email: b.email, password: "password123" } });
    expect(relog.status).toBe(200);
    expect((await bob.waitForOther("session:revoked")).reason).toBe("signed_in_elsewhere");
    alice.close();
    bob.close();
  });
});
