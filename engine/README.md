# Chat engine

Backend for the chat app: Bun + TypeScript, Hono (REST), Socket.IO (realtime), PostgreSQL via Prisma, Redis, S3.

The server keeps **no message history**. It holds a message only until the receiver's device acks it, then deletes it.

## Run locally

```bash
cp .env.example .env               # then set JWT_ACCESS_SECRET (and S3_* for file sharing)
docker compose up -d               # Postgres on :5433, Redis on :6380
bun install
bun run db:migrate                 # creates tables and generates the Prisma client
bun run dev                        # http://localhost:4000
```

- Health: `GET /health`
- REST docs (OpenAPI 3.1): `GET /api/v1/openapi.json`, also written to `contracts/openapi.json` by `bun run contracts`
- Socket events: [`contracts/socket-events.md`](contracts/socket-events.md)

## File sharing (S3)

Set the following in `.env`:
- `S3_BUCKET` and `S3_REGION`
- AWS credentials, via `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` or any standard AWS credential source

Then apply the auto-delete rules once:

```bash
bun run s3:lifecycle
```

What the rules do:
- **`chat/`**: objects expire after 30 days (`FILE_TTL_DAYS`).
- **`status/`**: objects expire after 1 day.
- **`avatar/`**: objects never expire.
- **Forwarding**: forwarding a file copies the object onto itself, which restarts its 30-day clock. The app gets **410** for expired files.

The bucket needs CORS only if you upload from a browser; the mobile app does not need it.

## Tests

```bash
bun test
```

The tests run against a separate `chat_test` database and Redis db 1, both created and emptied automatically. S3 and Expo push are faked. One test starts two engine processes to check cross-instance delivery through Redis.

## Scripts

| Script | What it does |
|---|---|
| `bun run dev` | Start with reload |
| `bun run start` | Start |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run db:migrate` | Create/apply migrations (dev) |
| `bun run db:deploy` | Apply migrations (prod) |
| `bun run contracts` | Regenerate `contracts/openapi.json` |
| `bun run s3:lifecycle` | Apply bucket lifecycle rules |
| `ENGINE_URL=http://localhost:4000 GREET=<username> bun scripts/demo-peer.ts` | Dev only: run `@demo_bot`, a second user that messages `<username>` first, then reads, reacts and replies to whatever you send, and posts a status |

## Layout

```
src/
  app.ts                Hono app, routes mounted at /api/v1, OpenAPI doc
  index.ts              Bun.serve: REST + Socket.IO on one port, BullMQ workers
  config/env.ts         validated environment
  lib/                  prisma, redis, s3, jwt, errors, rate limits, http helpers
  modules/              auth, users, connections, blocks, files, statuses, devices
  realtime/
    server.ts           socket auth, rooms, connect/disconnect
    inbox.ts            store-until-delivered queue + delivered receipts
    presence.ts         Redis presence (heartbeat-scored sorted sets)
    handlers/           message:send/read/react/delete, typing, presence:query, event:ack
  jobs/                 BullMQ: status/file/queue cleanup, push notifications
contracts/              openapi.json + socket-events.md: the language-neutral API contract
```

## Scaling

- **More instances**: run more of them behind a load balancer. Socket.IO events cross instances through the Redis adapter.
- **Workers**: BullMQ workers run in every instance by default. Set `RUN_WORKERS=false` to keep them out of some instances.
- **No sticky sessions**: not needed when clients use the websocket transport only.
