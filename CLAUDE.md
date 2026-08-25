# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Load the `mastra` skill first

Load the `mastra` skill (`mastra/SKILL.md` in this repo) **before** writing or changing any Mastra code. Mastra APIs shift between versions, and training-data knowledge of them is likely wrong. The priority order for verifying an API is:

1. Embedded docs in `node_modules/@mastra/*/dist/docs/` (matches the exact installed version)
2. Installed source and `.d.ts` files
3. Remote docs at `https://mastra.ai/llms.txt`

Before using any model string, run `node mastra/scripts/provider-registry.mjs` to verify the provider key and model name — do not guess. Models are always `"provider/model-name"` for Mastra's model router.

Note: `.claude/skills/mastra` is a symlink to a non-existent `.agents/skills/mastra`, so the skill may not auto-load. Read `mastra/SKILL.md` and `mastra/references/*.md` directly.

## Commands

```shell
npm run dev     # mastra dev — Studio at http://localhost:4111
npm run build   # mastra build
npm run start   # mastra start (serve a build)
npx tsc         # typecheck only (noEmit)
```

Use the npm scripts, not bare `mastra dev` / `mastra build`. There is no test or lint setup. Node >= 22.13.0.

`OPENAI_API_KEY` must be set in `.env` (see `.env.example`). Optional: `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` to swap local libSQL for Turso; `MCP_SERVER_URL` / `MCP_SERVER_TOKEN` for the ingest agent's tools; `WEBHOOK_SECRET` to lock down the ingest webhook.

Note that `mastra dev` allows only one instance per project directory — it refuses to start if `.mastra/dev.lock` names a live PID. Check for an already-running server on port 4111 before starting another; it hot-reloads `src/` changes.

## Architecture

`src/mastra/index.ts` is the composition root — **every agent, tool, workflow, scorer, and API route must be registered there** or it won't exist at runtime (Studio, schedules, and the API all resolve from this instance).

There are two independent flows: an interactive workspace agent, and a webhook-triggered ingest pipeline.

- **`src/mastra/index.ts`** — the `Mastra` instance. Storage is a `MastraCompositeStore`: a `LibSQLStore` default (`file:./mastra.db` or Turso) for memory/tasks/schedules, with the `observability` domain routed to `DuckDBStore`. `@duckdb/node-bindings` is declared as a bundler external — keep it there or builds break. Observability exports to both storage and the Mastra platform, filtered through `SensitiveDataFilter`.
- **`src/mastra/agents/agent.ts`** — the `agent` (id `'agent'`). Owns a `Workspace` scoped to the `workspace/` directory (`LocalFilesystem` + `LocalSandbox`), `Memory` with title generation and observational memory, a `TaskSignalProvider`, and the tool set (`ask_user`, `web_fetch`, `web_search`, plus the schedule tools).
- **`src/mastra/tools/schedule-tools.ts`** — `start_schedule` / `stop_schedule`, thin wrappers over `mastra.schedules.create/pause`. They hardcode `agentId: 'agent'` and require `agent.threadId` / `agent.resourceId` from the calling context, so they only work inside an agent conversation.

### Ingest flow (webhook → workflow → MCP agent)

`POST /webhooks/ingest` → `ingest-workflow` → `ingest-agent` → MCP tools.

- **`server/ingest-webhook.ts`** — a `registerApiRoute()` custom route with `requiresAuth: false`, so it stays reachable even if a `server.auth` provider is later added. Validates the body with Zod, then starts the workflow **fire-and-forget** and returns `202` with the `runId`; the outcome is only observable via storage, traces, or `GET /api/workflows/ingestWorkflow/runs/:runId`. If `WEBHOOK_SECRET` is set, an `X-Webhook-Secret` header must match (constant-time compare); if unset the route is open and logs a warning once.
- **`workflows/ingest-workflow.ts`** — `build-prompt` step renders the event into a prompt string, then `.agent(ingestAgent, { structuredOutput })` produces `ingestResultSchema`. The agent step's input schema is `{ prompt: string }`, so a step feeding it must return exactly that key.
- **`agents/ingest-agent.ts`** — has no memory and no workspace; each webhook is a standalone run. `tools` is a **resolver function**, not a static map, so a cold or unreachable MCP server doesn't break boot and tool-list changes are picked up per run.
- **`mcp/mcp-client.ts`** — a lazily-constructed `MCPClient` over Streamable HTTP/SSE. Tools arrive namespaced as `ingest_<toolName>` (the `servers` key is `ingest`). Three deliberate settings: `allowedHosts` pinned to the configured URL's host (SSRF guard, since the URL comes from env), `requireToolApproval: false` (a webhook run has nobody to approve, so a prompt would suspend it forever), and `id: 'ingest-mcp'` (avoids the duplicate-config error on reload). `resolveMcpTools()` uses `listToolsWithErrors({ perServerTimeoutMs })` and degrades to an empty tool map plus a logged error.

When adding tools to the ingest agent, prefer configuring them on the MCP server rather than in this repo — the agent's instructions tell it the tools are MCP-provided and may not exist.

### Workspace and approvals

The `agent`'s filesystem and shell tools are confined to `workspace/` (created on first use; not in the repo). The approval policy lives in the `Workspace.tools` map in `agents/agent.ts`: writes and edits `requireReadBeforeWrite`, delete `requireApproval`. `LocalSandbox` gives no OS-level isolation — it just sets the working directory — so don't loosen these or expose this app on an unauthenticated public server. Note the tension with the ingest flow: `/webhooks/ingest` is public by design, so anything that reaches it can spend model tokens. Set `WEBHOOK_SECRET` before deploying.

### Persistence gotchas

`mastra.db*` and `*.duckdb*` are gitignored, as is `src/mastra/public/` (where the dev server materializes them) and `.mastra/` (build output). Schedules survive restarts and keep spending model tokens until paused via `stop_schedule` with the ID that `start_schedule` returned.
