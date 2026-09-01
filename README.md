# ingester-template

Fastify + TypeScript boilerplate for receiving webhooks on `POST /webhooks/:hook_id`.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

## Routes

| Method | Path                 | Notes                                              |
| ------ | -------------------- | -------------------------------------------------- |
| `POST` | `/webhooks/:hook_id` | Accepts a payload, returns `202` with the result   |
| `GET`  | `/health`            | Liveness probe                                     |

`hook_id` is validated as `^[A-Za-z0-9_-]{1,128}$` — anything else gets `400`.

```bash
curl -i -X POST localhost:3000/webhooks/my-source \
  -H 'content-type: application/json' \
  -d '{"hello":"world"}'
```

## Where to add your code

`src/ingest.ts` is the single entry point — every request to `/webhooks/:hook_id`
lands in `ingest()` with the parsed body, the raw body string, headers and the
hook id. Dispatch per source from there (queue publish, DB write, handler map).

Keep it fast; the route replies `202` as soon as `ingest()` resolves, so hand
slow work off to a queue instead of awaiting it inline.

## Auth

Set `WEBHOOK_SECRET` and the route requires a matching `x-webhook-secret` header
(compared in constant time), otherwise `401`. Unset = no check, for local dev.

For providers that sign the payload instead (Stripe, GitHub, Slack, …), compute
the HMAC over `event.raw` in `ingest()` — `src/plugins/raw-body.ts` preserves the
body byte-for-byte before parsing.

## Docker

```bash
docker build -t ingester-template .
docker run -p 3000:3000 -e WEBHOOK_SECRET=... ingester-template
```

Or with Compose (reads `.env` for `PORT`, `WEBHOOK_SECRET`, `LOG_LEVEL`, `BODY_LIMIT`):

```bash
docker compose up --build -d
docker compose logs -f
```

The image is a multi-stage build on `node:22-alpine`: dependencies install in a
layer keyed on the lockfile, TypeScript compiles in a throwaway stage, and the
final stage carries only `dist/` plus production `node_modules`. It runs as the
unprivileged `node` user, defaults to `NODE_ENV=production` on `0.0.0.0:3000`,
and has a `HEALTHCHECK` against `/health`.

`node` runs as PID 1 — `src/server.ts` traps `SIGTERM`/`SIGINT` and closes the
server, so `docker stop` drains in-flight requests instead of being killed after
the grace period. Override the Node major with `--build-arg NODE_VERSION=24-alpine`.

## Layout

```
src/
  server.ts             # listen + graceful shutdown
  app.ts                # Fastify instance, logging, error handling
  config.ts             # env parsing
  ingest.ts             # your handling logic
  plugins/raw-body.ts   # raw body capture + catch-all content type parser
  routes/
    webhooks.ts         # POST /webhooks/:hook_id
    health.ts           # GET /health
Dockerfile              # multi-stage production image
docker-compose.yml
```

## Scripts

- `npm run dev` — watch mode
- `npm run typecheck` — `tsc --noEmit`
- `npm run build` — emit to `dist/`
- `npm start` — run the build
