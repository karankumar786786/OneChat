# Chat

A chat app in two independent projects:

| Folder | What | Stack |
|---|---|---|
| [`engine/`](engine/README.md) | Backend | Bun, TypeScript, Hono, Socket.IO, PostgreSQL (Prisma), Redis, S3, BullMQ |
| [`mobileApp/`](mobileApp/README.md) | iOS/Android app | Expo SDK 58, Expo Router, TypeScript, SQLite |

They share no code. The contract between them is in [`engine/contracts/`](engine/contracts):
- `openapi.json` for REST;
- `socket-events.md` for realtime.

Clients in other languages can be generated from or written against those two files.

## Features (v1)

- Register and log in with email and password; one active device per account.
- Unique usernames, with prefix search.
- Connections: chatting with someone connects you. Connections see each other's online status / last seen (Redis) and statuses.
- Realtime 1:1 chat over WebSocket:
  - ✓ sent, ✓✓ delivered, blue ✓✓ read;
  - typing indicator;
  - reactions;
  - reply and forward;
  - delete for everyone.
- **No message history on the server.** It holds a message only until the receiver's device gets it.
- File sharing through S3 with 30-day auto-delete. Forwarding a file restarts its 30 days.
- 24-hour statuses (text, photo, video) with a view log, reactions and private comments.
- **Group chats** (up to 256 people), like WhatsApp groups:
  - admins and the creator;
  - add/remove participants, make or dismiss admins;
  - name, description and icon;
  - "only admins can send" and "only admins can edit info" settings;
  - invite links you can reset, join by link;
  - leave (the longest-standing member becomes admin if the last admin leaves);
  - mute, with @mentions still notifying;
  - per-member delivered/read with a Message info screen;
  - group typing, reactions, reply and forward;
  - admins can delete anyone's message;
  - system lines ("@a added @b").
- Block users, and push notifications (Expo push) when the app is closed.

Audio and video calls are planned for later. The `call:*` socket namespace is reserved for WebRTC signalling.

## Quick start

```bash
cd engine && cp .env.example .env && docker compose up -d && bun install && bun run db:migrate && bun run dev
cd mobileApp && bun install && bun run ios
```
