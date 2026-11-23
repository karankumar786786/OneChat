import { describe, expect, test } from "bun:test";
import { api, Client, makeUser, uid, useServer, waitFor } from "./helpers.ts";

const ctx = useServer();

describe("auth", () => {
  test("register, duplicate email (any case), login", async () => {
    const email = `Mixed-${uid()}@Test.dev`;
    const reg = await api(ctx, "POST", "/auth/register", { body: { email, password: "password123" } });
    expect(reg.status).toBe(201);
    expect(reg.body.user.email).toBe(email.toLowerCase());
    expect(reg.body.user.username).toBeNull();

    const dup = await api(ctx, "POST", "/auth/register", { body: { email: email.toUpperCase(), password: "password123" } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("EMAIL_TAKEN");

    const bad = await api(ctx, "POST", "/auth/login", { body: { email, password: "wrong-password" } });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("INVALID_CREDENTIALS");

    const ok = await api(ctx, "POST", "/auth/login", { body: { email, password: "password123" } });
    expect(ok.status).toBe(200);
    const me = await api(ctx, "GET", "/me", { token: ok.body.tokens.accessToken });
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(reg.body.user.id);
  });

  test("validation errors have a uniform shape", async () => {
    const res = await api(ctx, "POST", "/auth/register", { body: { email: "not-an-email", password: "short" } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  test("refresh rotates; reusing an old refresh token revokes everything", async () => {
    const u = await makeUser(ctx, "rot");
    const r1 = await api(ctx, "POST", "/auth/refresh", { body: { refreshToken: u.refreshToken } });
    expect(r1.status).toBe(200);
    const fresh = r1.body.tokens;
    expect(fresh.refreshToken).not.toBe(u.refreshToken);

    // Old token again: treated as stolen.
    const reuse = await api(ctx, "POST", "/auth/refresh", { body: { refreshToken: u.refreshToken } });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe("SESSION_REVOKED");

    // The newest token is dead too, and so is the access token.
    const after = await api(ctx, "POST", "/auth/refresh", { body: { refreshToken: fresh.refreshToken } });
    expect(after.status).toBe(401);
    const me = await api(ctx, "GET", "/me", { token: fresh.accessToken });
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe("SESSION_REVOKED");
  });

  test("logout revokes the session", async () => {
    const u = await makeUser(ctx, "out");
    expect((await api(ctx, "POST", "/auth/logout", { token: u.token })).status).toBe(204);
    expect((await api(ctx, "GET", "/me", { token: u.token })).status).toBe(401);
    expect((await api(ctx, "POST", "/auth/refresh", { body: { refreshToken: u.refreshToken } })).status).toBe(401);
  });

  test("signing in on a new device signs out the old one, including its socket", async () => {
    const u = await makeUser(ctx, "dev");
    const oldDevice = await Client.connect(ctx, u.token);

    const login = await api(ctx, "POST", "/auth/login", { body: { email: u.email, password: "password123" } });
    expect(login.status).toBe(200);

    const revoked = await oldDevice.waitForOther("session:revoked");
    expect(revoked.reason).toBe("signed_in_elsewhere");
    await waitFor(() => !oldDevice.socket.connected, 3000, "old socket to disconnect");

    expect((await api(ctx, "GET", "/me", { token: u.token })).status).toBe(401);
    expect((await api(ctx, "GET", "/me", { token: login.body.tokens.accessToken })).status).toBe(200);
    await expect(Client.connect(ctx, u.token)).rejects.toThrow();
  });
});
