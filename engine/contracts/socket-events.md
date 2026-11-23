# Socket events contract

Realtime chat runs over **Socket.IO v4** (Engine.IO protocol 4). Any client that speaks Socket.IO can use it: socket.io-client (JS/TS), socket.io-client-swift, socket.io-client-java/Kotlin, socket_io_client (Dart).

- **URL**: the engine origin, path `/socket.io/`.
- **Transport**: use `websocket` only. Polling works but needs sticky sessions behind a load balancer.
- **Auth**: send `{ token: "<access token>" }` as the handshake `auth` payload.
- **Connection rejected**: the client gets `connect_error` with `err.data.code`, which is one of:
  - `UNAUTHORIZED`
  - `TOKEN_EXPIRED`: refresh, then reconnect with the new token
  - `SESSION_REVOKED`: signed out, go to the login screen
  - `USERNAME_REQUIRED`: the user must set a username before chatting

The REST API is described in `openapi.json`. All ids are UUID strings and all times are ISO-8601 UTC strings.

---

## The ack shape

Every client→server event that takes an ack callback answers with one of:

```jsonc
{ "ok": true, ...result }
{ "ok": false, "error": { "code": "VALIDATION_FAILED" | "RATE_LIMITED" | "BAD_REQUEST" | "NOT_FOUND" | "FORBIDDEN" | "GONE" | "INTERNAL", "message": "..." } }
```

---

## Queued events (store-until-delivered)

The server keeps **no message history**. Anything the other side must not miss is held in a per-user queue until that user's device acks it, and then deleted. History lives only on the devices.

Queued events arrive as a batch on the `events` event, as an array of envelopes:

```jsonc
{
  "eventId": "uuid",        // ack this
  "type": "message" | "receipt.delivered" | "receipt.read" | "reaction" | "message.deleted" | "group.update",
  "from": "userId",         // stamped by the server from the authenticated sender: trust only this
  "payload": { ... },       // depends on type, see below
  "serverTs": "ISO time"    // when the server accepted it
}
```

**Acking (required).** Store the events durably first (for example in a local DB transaction), then ack:

- If the `events` handler received an ack callback, which happens when the server drains the backlog on connect, call it with `{ "eventIds": [...] }`. The next page of the backlog is sent only after this.
- Otherwise, for live events, emit `event:ack` with `{ "eventIds": [...] }`.

Events that are not acked are sent again on the next connect. **Delivery is at-least-once**, so drop duplicates by `eventId`, and drop duplicate messages by `payload.id`.

**Ordering.** The backlog arrives oldest first. Live events can interleave with the backlog, so sort each chat by `payload.sentAt` / `serverTs`.

### Payloads

`message`:
```jsonc
{
  "id": "uuid",                 // the sender's client-generated id (UUIDv7 recommended)
  "kind": "text" | "file",
  "text": "string | null",      // file messages may carry a caption
  "file": null | { "id", "mime", "size", "name", "purpose": "chat", "state": "ready", "expiresAt" },
  "replyTo": "message id | null",
  "forwarded": false,
  "sentAt": "ISO time",
  "groupId": "uuid | null",     // set for group messages; the chat is the group, the sender is `from`
  "mentions": ["userId", ...]   // group members @mentioned in the text
}
```
Fetch a file with `GET /files/{id}/download-url`. That call returns **410** once the file has expired (30 days after upload or after the latest forward).

`receipt.delivered` and `receipt.read`:
```jsonc
{ "messageIds": ["uuid", ...], "at": "ISO time", "groupId": "uuid | null" }
```
In a group, `from` is the member who received or read the messages. Each member sends their own receipt.

`reaction`:
```jsonc
{ "messageId": "uuid", "emoji": "❤️" | null, "at": "ISO time", "groupId": "uuid | null" }   // null removes the reaction
```

`message.deleted`:
```jsonc
{ "messageId": "uuid", "at": "ISO time", "groupId": "uuid | null", "asAdmin": false }
```

`group.update`: something about a group changed. Show it as a system message, then refresh the group with `GET /groups/{id}`.
```jsonc
{
  "groupId": "uuid",
  "action": "created" | "added" | "removed" | "left" | "joined" | "promoted" | "demoted" | "info" | "settings",
  "actor": { "id", "username" },             // who did it (same as envelope `from`)
  "targets": [{ "id", "username" }, ...],    // who it was done to (added, removed, promoted, ...)
  "changes": null | { "name"?, "description"?, "avatarFileId"?, "onlyAdminsCanSend"?, "onlyAdminsCanEditInfo"? },
  "at": "ISO time"
}
```
It goes to every member and to anyone just removed. When you are a target of `removed`, or the actor of `left`, you are no longer a member.

**Client-side checks.** The server does not keep message metadata, so the receiving device must check authorship:

- Apply `message.deleted` only when `from` equals the original message's sender. In a group, also apply it when `asAdmin` is true and `from` is a group admin.
- Apply `reaction` only when `from` is the peer of that chat, or a member of that group.

---

## Tick lifecycle (sender's view)

| Tick | When |
|---|---|
| 🕓 pending | Saved locally and not yet acked by the server (in the outbox) |
| ✓ sent | The `message:send` ack returned `ok: true` |
| ✓✓ delivered | A `receipt.delivered` event lists the message id. In a group: once every recipient in the ack's `recipients` has sent one |
| ✓✓ blue, read | A `receipt.read` event lists the message id. In a group: once every recipient has read it |

In groups, keep the per-member receipts to show a "Message info" screen (who has received and read it, and when).

---

## Client → server

### `message:send` (ack)
```jsonc
{
  "id": "uuid",              // generate on the device; reuse the same id when retrying
  "to": "userId",            // a person, or…
  "groupId": "uuid",         // …a group you are in (exactly one of the two)
  "kind": "text" | "file",
  "text": "≤ 4000 chars",   // required for text
  "fileId": "uuid",          // required for file: from POST /files/upload-url + /complete, or a file you received
  "replyTo": "message id",   // optional
  "forwarded": true          // optional; marks the message forwarded and resets the file's 30-day TTL
}
```
Ack: `{ ok: true, messageId, serverTs }`. For groups the ack also has `recipients`, the member ids it went to.

- **Groups**: one copy is queued for each other member, and files are shared with all of them. When the group is set to admins only, members get `FORBIDDEN`. Offline members get a push, unless they muted the group; an @mention still gets through.
- **Retries**: re-sending the same `id` is safe. You get the same ack and the message is not delivered twice.
- **First message**: the first message between two users makes them **connections**. Connections can see each other's presence and statuses.
- **Blocks**: if the recipient blocked you, the ack is still `ok` but the message is never delivered. If you blocked them, the ack is `FORBIDDEN`.

### `message:read` (ack)
`{ "peerId": "userId", "messageIds": ["uuid", ... up to 500] }`. Queues `receipt.read` for the peer.

In a group: `{ "groupId", "senderId", "messageIds" }`. Send one per message sender; the receipt goes to that sender.

### `message:react` (ack)
`{ "peerId": "userId", "messageId": "uuid", "emoji": "string" | null }`. Queues `reaction` for the peer. For a group, send `groupId` instead of `peerId`; it goes to every other member.

### `message:delete` (ack)
`{ "peerId": "userId", "messageId": "uuid" }` deletes for everyone.

Ack: `{ ok: true, retracted: boolean }`.
- `retracted: true`: the message had not been delivered yet, and the server removed it from the peer's queue.
- `retracted: false`: the message was already delivered, so a `message.deleted` event was queued for the peer.

In a group: `{ "groupId", "messageId", "asAdmin"? }`. Copies not delivered yet are pulled from members' queues, and every other member gets `message.deleted`. Admins can pass `asAdmin: true` to delete someone else's message; non-admins get `FORBIDDEN`.

### `event:ack` (ack optional)
`{ "eventIds": ["uuid", ... up to 1000] }`. Ack: `{ ok: true, removed: n }`.

### `typing` (no ack)
`{ "to": "userId", "on": true | false }`, or `{ "groupId": "uuid", "on": … }` for a group. Other members receive `{ from, on, groupId }`.

Typing is sent only when the peer is online and connected to you. It is never queued, and it is rate-limited. Send `on: true` at most every few seconds while typing, and `on: false` when the user stops.

### `presence:query` (ack)
`{ "userIds": ["uuid", ... up to 200] }`. Ack: `{ ok: true, presence: [{ userId, online, lastSeenAt }] }`.

Only your connections appear in the result, and never anyone on either side of a block.

---

## Server → client

| Event | Payload | Notes |
|---|---|---|
| `events` | `Envelope[]` (and maybe an ack callback) | Queued events, see above |
| `typing` | `{ from, on }` | Clear the indicator after ~6s without an update |
| `presence:update` | `{ userId, online, lastSeenAt }` | Sent to connections when a user comes online or goes offline |
| `status:new` | `{ userId, statusId, createdAt }` | A connection posted a status; refresh the feed |
| `status:deleted` | `{ userId, statusId }` | |
| `status:viewed` | `{ statusId, viewer: PublicUser, viewedAt }` | Sent to the status owner |
| `status:reaction` | `{ statusId, viewer: PublicUser, reaction, at }` | Sent to the status owner |
| `status:comment` | `{ id, statusId, text, createdAt, author: PublicUser }` | Sent to the status owner |
| `session:revoked` | `{ reason: "signed_in_elsewhere" \| "signed_out" \| "token_reuse" }` | The socket is closed right after; sign the user out |

`PublicUser` = `{ id, username, displayName, avatarFileId, avatarUrl }`, as in `openapi.json`.

---

## Reserved

`call:*` is reserved for WebRTC audio/video call signalling in a later version.
