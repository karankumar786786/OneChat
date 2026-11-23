/**
 * Development helper: a second user to chat with when you only have one simulator.
 *
 *   ENGINE_URL=http://localhost:4000 bun scripts/demo-peer.ts
 *
 * It signs in as @demo_bot (creating the account on first run), posts a status, and for
 * every message you send it (1:1 or in a group it is in): acks it (your ✓✓), reads it
 * (blue ✓✓), shows "typing…", reacts 👍, and replies. Everything it receives is printed here.
 *
 *   GREET=<username>        message that user first
 *   GROUP_WITH=<username>   create a group "Demo group" with that user (the bot is admin)
 * The account below is a local test account only.
 */
import { io } from "socket.io-client";

const BASE = (process.env.ENGINE_URL ?? `http://localhost:${process.env.PORT ?? 4000}`).replace(/\/$/, "");
const EMAIL = "demo-bot@example.test";
const PASSWORD = "demo-bot-password-1";
const USERNAME = "demo_bot";

async function call<T = any>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

let auth = await call("POST", "/auth/login", { email: EMAIL, password: PASSWORD });
if (auth.status === 401) auth = await call("POST", "/auth/register", { email: EMAIL, password: PASSWORD });
if (auth.status >= 300) throw new Error(`sign-in failed: ${JSON.stringify(auth.body)}`);
const token: string = auth.body.tokens.accessToken;
const me = auth.body.user;
if (!me.username) {
  const r = await call("PUT", "/me/username", { username: USERNAME }, token);
  if (r.status !== 200) throw new Error(`username failed: ${JSON.stringify(r.body)}`);
  await call("PATCH", "/me", { displayName: "Demo Bot" }, token);
}
console.log(`signed in as @${USERNAME} (${me.id})`);

const mine = await call("GET", "/statuses/mine", undefined, token);
if (!mine.body.statuses.length) {
  await call("POST", "/statuses", { type: "text", text: "Hello from the demo bot 👋", bg: "#0EA5E9" }, token);
  console.log("posted a status");
}

const socket = io(BASE, { path: "/socket.io/", transports: ["websocket"], auth: { token } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// GREET=<username>: message that user first, so the chat shows up on their phone.
const greet = process.env.GREET;
let greeted = false;
socket.on("connect", async () => {
  console.log("socket connected");
  if (!greet || greeted) return;
  greeted = true;
  const target = await call("GET", `/users/by-username/${encodeURIComponent(greet)}`, undefined, token);
  if (target.status !== 200) return console.log(`GREET: @${greet} not found`);
  socket.emit("typing", { to: target.body.id, on: true });
  await sleep(1200);
  for (const text of [`Hi @${greet}! I'm the demo bot 🤖`, "Send me anything and I'll read it, react 👍 and reply."]) {
    const ack = await socket.timeout(5000).emitWithAck("message:send", { id: Bun.randomUUIDv7(), to: target.body.id, kind: "text", text });
    console.log("greeting sent", ack);
    await sleep(400);
  }
  socket.emit("typing", { to: target.body.id, on: false });
});

const groupWith = process.env.GROUP_WITH;
let grouped = false;
socket.on("connect", async () => {
  if (!groupWith || grouped) return;
  grouped = true;
  const target = await call("GET", `/users/by-username/${encodeURIComponent(groupWith)}`, undefined, token);
  if (target.status !== 200) return console.log(`GROUP_WITH: @${groupWith} not found`);
  const g = await call("POST", "/groups", { name: "Demo group", description: "Made by the demo bot", memberIds: [target.body.id] }, token);
  if (g.status !== 201) return console.log("group create failed", g.body);
  console.log(`created group ${g.body.id}`);
  await sleep(800);
  const ack = await socket.timeout(5000).emitWithAck("message:send", {
    id: Bun.randomUUIDv7(),
    groupId: g.body.id,
    kind: "text",
    text: `Welcome @${groupWith}! This is a group. Try replying, reacting, or opening Group info.`,
  });
  console.log("group welcome sent", ack);
});
socket.on("connect_error", (e: Error & { data?: unknown }) => console.log("connect_error", e.message, e.data));
socket.on("disconnect", (reason) => {
  console.log("disconnected:", reason);
  if (reason === "io server disconnect") setTimeout(() => socket.connect(), 1000);
});
socket.on("session:revoked", (d) => {
  console.log("session revoked", d);
  process.exit(1);
});
socket.on("typing", (d) => console.log("typing", d));
socket.on("presence:update", (d) => console.log("presence", d));
for (const ev of ["status:viewed", "status:reaction", "status:comment"]) socket.on(ev, (d) => console.log(ev, JSON.stringify(d)));

socket.on("events", async (events: any[], cb?: (r: { eventIds: string[] }) => void) => {
  const eventIds = events.map((e) => e.eventId);
  if (cb) cb({ eventIds });
  else socket.emit("event:ack", { eventIds });

  for (const e of events) {
    console.log(`event ${e.type} from ${e.from}: ${JSON.stringify(e.payload)}`);
    if (e.type !== "message") continue;
    const msg = e.payload;
    const groupId: string | null = msg.groupId ?? null;
    // 1:1 uses `to`/`peerId`; groups use `groupId` (read receipts also name the sender).
    const where = groupId ? { groupId } : { peerId: e.from };
    await sleep(700);
    socket.emit("message:read", groupId ? { groupId, senderId: e.from, messageIds: [msg.id] } : { peerId: e.from, messageIds: [msg.id] });
    await sleep(500);
    socket.emit("message:react", { ...where, messageId: msg.id, emoji: "👍" });
    socket.emit("typing", groupId ? { groupId, on: true } : { to: e.from, on: true });
    await sleep(1500);
    socket.emit("typing", groupId ? { groupId, on: false } : { to: e.from, on: false });
    const reply = msg.kind === "file" ? `Got your file "${msg.file?.name ?? "file"}" 📎` : `You said: ${msg.text}`;
    const ack = await socket.timeout(5000).emitWithAck("message:send", {
      id: Bun.randomUUIDv7(),
      ...(groupId ? { groupId } : { to: e.from }),
      kind: "text",
      text: reply,
      replyTo: msg.id,
    });
    console.log("reply sent", ack);
  }
});

// Keep the process alive across engine restarts (the socket reconnects by itself).
setInterval(() => {}, 1 << 30);
