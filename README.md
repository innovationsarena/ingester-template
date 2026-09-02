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

## Mail parsing

`ingest()` runs the payload through `parseEmailFromWebhook()` (`src/mail.ts`),
which finds the raw message, base64-decodes it when needed, and parses the MIME
with [mailparser](https://nodemailer.com/extras/mailparser/):

```ts
const email = await parseEmailFromWebhook(event);
email.subject;      // encoded words already decoded → "Faktura för augusti"
email.from;         // [{ name: "Ada Lovelace", address: "ada@example.com" }]
email.to;           // same shape; also .cc, .replyTo
email.text;         // text/plain body, charset + quoted-printable decoded
email.html;         // text/html body
email.textAsHtml;   // fallback rendering when there is no html part
email.attachments;  // [{ filename, contentType, size, checksum, inline, content }]
email.headers;      // full header Map
```

`attachment.content` is a decoded `Buffer`. Nothing is written to disk — upload
it, store it, or forward it from `ingest()`.

**Seeing the bodies.** The `email parsed` log line carries the first 500
characters of `text` and `html`; `LOG_LEVEL=debug` adds an `email bodies` line
with both in full. The HTTP response stays a small receipt (`messageId`,
`subject`, attachment count) rather than echoing the message back — add
`text: email.text` to the returned object in `ingest()` if you want it there.

**Finding the message.** With `MAIL_FIELD` set, that dot path is used verbatim
(`MAIL_FIELD=envelope.message.raw`). Unset, it probes common field names
(`rawMime`, `raw_mime`, `rawEmail`, `raw_email`, `mime`, `raw`, `content`,
`message`, `email`, `body`, `data`) and falls back to the raw request body — so
posting `message/rfc822` straight to the route works too.

**Encoding.** `MAIL_ENCODING=auto` (default) sniffs: a payload that already
starts with a MIME header is used as-is, otherwise it is base64-decoded. Both
standard and URL-safe base64 are accepted, and transport line-wrapping is
stripped. Force it with `base64` or `utf8` if the sniffing guesses wrong.

Returns `undefined` when the payload holds no message — `ingest()` logs a
warning and still answers `202`; change that to a `4xx` if a missing message
should be an error for your provider.

Note `BODY_LIMIT` (default 1 MiB): base64 inflates a message by about a third,
so raise it before accepting mail with attachments.

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
  mail.ts               # base64 → MIME → text / html / attachments
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
