import { describe, expect, test } from "bun:test";
import { api, Client, makeUser, uid, useServer } from "./helpers.ts";

const ctx = useServer();

describe("usernames and search", () => {
  test("username rules and case-insensitive uniqueness", async () => {
    const a = await makeUser(ctx, "una");
    const b = await makeUser(ctx, "unb");
    const name = `Karan_${uid()}`.slice(0, 18);

    const set = await api(ctx, "PUT", "/me/username", { token: a.token, body: { username: `@${name}` } });
    expect(set.status).toBe(200);
    expect(set.body.username).toBe(name.toLowerCase());

    const taken = await api(ctx, "PUT", "/me/username", { token: b.token, body: { username: name.toUpperCase() } });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe("USERNAME_TAKEN");

    const avail = await api(ctx, "GET", `/users/username-available?u=${name}`, { token: b.token });
    expect(avail.body).toMatchObject({ available: false, reason: "Already taken" });
    const mine = await api(ctx, "GET", `/users/username-available?u=${name}`, { token: a.token });
    expect(mine.body.available).toBe(true);

    for (const bad of ["ab", "has space", "_start", "end.", "a..b", "admin", "x".repeat(21)]) {
      const r = await api(ctx, "PUT", "/me/username", { token: b.token, body: { username: bad } });
      expect(r.status).toBe(400);
    }
  });

  test("socket refuses users without a username", async () => {
    const reg = await api(ctx, "POST", "/auth/register", { body: { email: `nou-${uid()}@test.dev`, password: "password123" } });
    const err = await Client.connect(ctx, reg.body.tokens.accessToken).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.data?.code).toBe("USERNAME_REQUIRED");
  });

  test("prefix search, exact match first, wildcards are literal, blocks hide", async () => {
    const tag = uid().slice(0, 5);
    const me = await makeUser(ctx, "srch");
    const exact = await makeUser(ctx, "s1");
    const longer = await makeUser(ctx, "s2");
    const blocker = await makeUser(ctx, "s3");
    await api(ctx, "PUT", "/me/username", { token: exact.token, body: { username: `q${tag}` } });
    await api(ctx, "PUT", "/me/username", { token: longer.token, body: { username: `q${tag}_more` } });
    await api(ctx, "PUT", "/me/username", { token: blocker.token, body: { username: `q${tag}zz` } });

    const r = await api(ctx, "GET", `/users/search?q=Q${tag}`, { token: me.token });
    expect(r.status).toBe(200);
    expect(r.body.users.map((u: any) => u.username)).toEqual([`q${tag}`, `q${tag}zz`, `q${tag}_more`]);

    // "_" must not act as a LIKE wildcard.
    const wild = await api(ctx, "GET", `/users/search?q=q${tag}_`, { token: me.token });
    expect(wild.body.users.map((u: any) => u.username)).toEqual([`q${tag}_more`]);

    // A user who blocked me disappears from my search and profile lookups.
    expect((await api(ctx, "POST", `/blocks/${me.id}`, { token: blocker.token })).status).toBe(204);
    const after = await api(ctx, "GET", `/users/search?q=q${tag}`, { token: me.token });
    expect(after.body.users.map((u: any) => u.username)).not.toContain(`q${tag}zz`);
    expect((await api(ctx, "GET", `/users/${blocker.id}`, { token: me.token })).status).toBe(404);
    expect((await api(ctx, "GET", `/users/by-username/q${tag}zz`, { token: me.token })).status).toBe(404);

    // Unblocking brings them back.
    await api(ctx, "DELETE", `/blocks/${me.id}`, { token: blocker.token });
    expect((await api(ctx, "GET", `/users/${blocker.id}`, { token: me.token })).status).toBe(200);
  });
});
