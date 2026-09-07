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

## The pipeline

```
POST /webhooks/:hook_id
  → parse MIME
  → dedupe on Message-ID
  → 202 Accepted                      ← the request ends here, in ~40 ms
       ↓  (background job)
  → each attachment → Docling → Markdown
  → assemble headers + body + attachment sections
  → agent = agents[hook_id] ?? default
  → agent.generateText(...)
```

Everything after the `202` runs in a background job (`src/jobs.ts`), so a slow OCR
pass or a long agent turn can never cause a provider webhook timeout — and a
`SIGTERM` waits for in-flight jobs instead of killing them mid-conversion.

`src/ingest.ts` is the orchestrator; the steps live in `src/docling.ts`,
`src/prompt.ts` and `src/agents/index.ts`.

Duplicate deliveries are dropped on `Message-ID` (providers retry on any non-2xx
and on timeouts), answering `202` with `duplicate: true` and running nothing. The
set is per-process and resets on restart — the honest limit of a service that
stores nothing.

## Document conversion

Every attachment goes to [docling-serve](https://github.com/docling-project/docling-serve)
at `POST $DOCLING_URL/v1/convert/source` and comes back as Markdown. Docling reads
PDF, DOCX/XLSX/PPTX, HTML, CSV, images and more, so there is no attachment type the
pipeline has to refuse.

- **One file per request** — `/v1/convert/source` returns a zip archive if handed
  several `sources`, so attachments go through a small concurrency pool
  (`DOCLING_CONCURRENCY`, default 2) instead.
- **Failures are per-attachment.** A timeout, a `500`, an unreachable Docling, or a
  `200` carrying `status: "failure"` marks that one document as failed and notes it
  in the agent's input; the rest of the message still goes through. `5xx` and
  timeouts get one retry.
- **Oversized attachments** (`MAX_ATTACHMENT_BYTES`, default 25 MB) are skipped
  without a Docling call and mentioned in the input.
- **HTML-only messages** have their body converted too — Docling accepts HTML, which
  beats sending raw markup to the model.

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

`attachment.content` is a decoded `Buffer`, which is what gets handed to Docling.
Nothing is written to disk at any point.

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

Note `BODY_LIMIT` (default 30 MB): base64 inflates a message by about a third, so a
25 MB attachment arrives as ~34 MB of request body.

## Agents

Agents are [VoltAgent](https://voltagent.dev) `Agent` instances used as a library —
nothing extra listens on port 3141. `hook_id` selects the agent, so
`POST /webhooks/faktura` runs the agent registered as `faktura`; an unregistered
hook falls back to `default` and logs that it did. Add one in `src/agents/index.ts`:

```ts
const agents = new Map<string, Agent>([
  ["faktura", defineAgent("faktura", "You process supplier invoices. ...")],
]);
```

The model is `@ai-sdk/anthropic` with `AGENT_MODEL` (default `claude-opus-5`).
Pin `@ai-sdk/anthropic` to the 3.x line: 4.x targets a newer AI SDK core than
VoltAgent 2.x accepts, and the mismatch shows up as a `LanguageModelV4` type error.

Agents are created with `memory: false` on purpose — VoltAgent otherwise provisions
a local store, which would drop a database file into a service that holds no state.

### MCP tools

Every agent is handed the tools of the MCP server at `MCP_URL` (`src/mcp.ts`),
default `https://gr-mcp.innovationsarenan.se/mcp` — a Graphiti knowledge-graph
memory server, no auth. Tools arrive namespaced by the server key, so Graphiti's
`search_nodes` reaches the model as `graphiti_search_nodes`.

The connection is opened on the first agent run, not at startup, and the client
is reused across emails. If the server is unreachable VoltAgent logs it and the
agent runs with no tools, the same way an unreachable Docling degrades to a
failed attachment. `MCP_URL=` disables MCP entirely.

Two things worth knowing before pointing this at production traffic:

- `graphiti_clear_graph`, `graphiti_delete_episode` and
  `graphiti_delete_entity_edge` are destructive and reach an agent that runs
  unattended on incoming mail. Restrict them with the `authorization.can` hook
  in `MCPConfiguration` if that is not wanted.
- Tool use costs steps. VoltAgent allows 5 per run by default, so a turn that
  searches and then answers fits, but a long chain does not — raise `maxSteps`
  on the `Agent` if agents start stopping mid-task.

Without `ANTHROPIC_API_KEY` the pipeline still runs: attachments are converted and
the assembled input is logged with `agent skipped`. That is the quickest way to see
what the agent would receive.

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
  server.ts             # listen + graceful shutdown (drains jobs)
  app.ts                # Fastify instance, logging, error handling
  config.ts             # env parsing
  ingest.ts             # orchestrator: parse → 202 → background pipeline
  mail.ts               # base64 → MIME → text / html / attachments
  docling.ts            # docling-serve client (one document per request)
  prompt.ts             # email + conversions → agent input
  jobs.ts               # background runner with drain-on-shutdown
  mcp.ts                # MCP client: remote tools for the agents
  agents/index.ts       # VoltAgent agents, keyed by hook_id
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
