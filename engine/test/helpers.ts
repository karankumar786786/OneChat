import { afterAll, beforeAll } from "bun:test";
import { io as ioc, type Socket } from "socket.io-client";
import { startServer } from "../src/index.ts";

export interface Ctx {
  port: number;
  base: string;
}

/** Starts one engine per test file on a random port. */
export function useServer(): Ctx {
  const ctx = { port: 0, base: "" };
  let stop: (() => Promise<void>) | null = null;
  beforeAll(async () => {
    const s = await startServer({ port: 0, workers: false });
    ctx.port = s.port;
    ctx.base = `http://localhost:${s.port}`;
    stop = s.stop;
  });
  afterAll(async () => {
    await stop?.();
  });
  return ctx;
}

export const uid = () => Math.random().toString(36).slice(2, 10);

export async function api<T = any>(
  ctx: Ctx,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${ctx.base}/api/v1${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : (undefined as T) };
}

export interface TestUser {
  id: string;
  email: string;
  username: string;
  token: string;
  refreshToken: string;
}

/** Registers a user and gives them a username. */
export async function makeUser(ctx: Ctx, prefix = "u"): Promise<TestUser> {
  const email = `${prefix}-${uid()}@test.dev`;
  const reg = await api(ctx, "POST", "/auth/register", { body: { email, password: "password123" } });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  const username = `${prefix}${uid()}`.slice(0, 20);
  const set = await api(ctx, "PUT", "/me/username", { token: reg.body.tokens.accessToken, body: { username } });
  if (set.status !== 200) throw new Error(`username failed: ${JSON.stringify(set.body)}`);
  return {
    id: reg.body.user.id,
    email,
    username,
    token: reg.body.tokens.accessToken,
    refreshToken: reg.body.tokens.refreshToken,
  };
}

export interface Envelope {
  eventId: string;
  type: string;
  from: string;
  payload: any;
  serverTs: string;
}

/**
 * Socket client that records everything it receives and acks queued events
 * the way a real app would (callback when given, event:ack otherwise).
 */
export class Client {
  events: Envelope[] = [];
  other: { event: string; data: any }[] = [];
  autoAck = true;

  private constructor(public socket: Socket) {
    socket.on("events", (batch: Envelope[], cb?: (r: { eventIds: string[] }) => void) => {
      this.events.push(...batch);
      if (!this.autoAck) return;
      const eventIds = batch.map((e) => e.eventId);
      if (typeof cb === "function") cb({ eventIds });
      else socket.emit("event:ack", { eventIds });
    });
    socket.onAny((event, data) => {
      if (event !== "events") this.other.push({ event, data });
    });
  }

  static connect(ctx: Ctx, token: string, opts: { autoAck?: boolean } = {}): Promise<Client> {
    const socket = ioc(ctx.base, {
      path: "/socket.io/",
      transports: ["websocket"],
      auth: { token },
      reconnection: false,
      forceNew: true,
    });
    const client = new Client(socket);
    if (opts.autoAck === false) client.autoAck = false;
    return new Promise((resolve, reject) => {
      socket.once("connect", () => resolve(client));
      socket.once("connect_error", (err) => {
        socket.close();
        reject(err);
      });
    });
  }

  emit<T = any>(event: string, data: unknown): Promise<T> {
    return this.socket.timeout(5000).emitWithAck(event, data) as Promise<T>;
  }

  async waitForEvent(pred: (e: Envelope) => boolean, timeoutMs = 4000): Promise<Envelope> {
    return waitFor(() => this.events.find(pred), timeoutMs, "queued event");
  }

  async waitForOther(event: string, pred: (d: any) => boolean = () => true, timeoutMs = 4000) {
    return waitFor(() => this.other.find((o) => o.event === event && pred(o.data))?.data, timeoutMs, event);
  }

  close() {
    this.socket.close();
  }
}

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 4000, what = "condition"): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

export const sleep = (ms: number) => Bun.sleep(ms);
