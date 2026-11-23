# Chat mobile app

Expo (SDK 58) + Expo Router + TypeScript, with Bun as the package manager. It talks to the engine in `../engine`.

## Run

```bash
cd ../engine && docker compose up -d && bun run dev   # start the backend first
cd ../mobileApp
bun install
bun run ios        # or: bun run android
```

Set where the engine runs in `.env`:

| Where the app runs | `EXPO_PUBLIC_API_URL` |
|---|---|
| iOS simulator | `http://localhost:4000` |
| Android emulator | `http://10.0.2.2:4000` |
| Physical phone | `http://<your computer's LAN IP>:4000` |

Every native module used here is in Expo Go, so the app runs there. Push notifications need two extra things:
- a physical device;
- an EAS project id: run `bunx eas-cli init` once, then make a development build with `bunx expo run:ios` / `run:android` or `bunx eas-cli build --profile development`.

## How it works

- **No server history.** Messages live only in a local SQLite database, one file per account (`chat-<userId>.db`).
  - The server holds a message only until this device saves it and acks it.
  - Receipts, reactions and deletes travel the same way.
- **Sync loop** (`src/realtime/socket.ts`):
  1. The socket connects.
  2. The backlog arrives in pages.
  3. Each page is written to SQLite in one transaction (`src/realtime/apply.ts`).
  4. The page is acked.
  5. The outbox is flushed.
- **Outbox.** Messages you send go to the outbox first, so they survive being offline or closing the app, and are retried on reconnect.
- **Ticks**: 🕓 pending → ✓ sent (server ack) → ✓✓ delivered → ✓✓ blue read. Read receipts go out when you open a chat, or when a message arrives in a chat you have open.
- **Files** upload straight to S3 with a presigned POST and expire after 30 days. Forwarding a file resets its clock. Expired files show "File expired".
- **Statuses** last 24 hours. Viewing one logs a view. Reactions are visible to the owner, and comments only to you and the owner.
- **Sessions.** Tokens are kept in SecureStore, and the access token refreshes automatically (single-flight). Signing in on another device signs this one out.

## API contract

The REST types in `src/api/schema.d.ts` are generated from the engine's OpenAPI file. Regenerate them after engine changes:

```bash
cd ../engine && bun run contracts
cd ../mobileApp && bun run gen:api
```

Socket event types are kept in `src/realtime/events.ts`, matching `../engine/contracts/socket-events.md`.

## Checks

```bash
bun run typecheck
bun run test          # event-reducer tests against real SQLite (bun:sqlite)
bunx expo-doctor
```

## Layout

```
src/app/            routes (Expo Router)
  (auth)/           login, register
  username.tsx      shown until a username is set
  (app)/(tabs)/     chats, status, settings
  (app)/chat/[peerId].tsx, search, forward, status/[userId] (viewer), status/new, status/mine/[id]
src/api/            typed REST client (openapi-fetch) + generated schema
src/auth/           token store with refresh
src/db/             local SQLite: schema, queries, live hooks
src/realtime/       socket manager, event reducer, presence/typing store
src/chat/           send/forward/react/delete actions, message bubble
src/files/          S3 upload and download
src/status/         status queries
tests/              bun tests for the event reducer
```
