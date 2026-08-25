# ingester-template

Welcome to your new [Mastra](https://mastra.ai) project! We're excited to see what you build.

This starter provides you with a general-purpose Mastra agent that can research current information, manage multi-step tasks, work with local files, run approved shell commands, and create recurring schedules.

## Features

- A project-level `workspace/` for files and command execution
- Approval gates for file changes, deletions, and shell commands
- Conversation memory, generated thread titles, and task tracking
- Built-in web search and direct web page fetching
- Recurring schedules that persist across restarts
- Local libSQL storage and DuckDB observability, with optional Turso storage
- A bundled Mastra skill that helps coding agents use current Mastra APIs

## Get started

Set your `OPENAI_API_KEY` in `.env` or in your environment, then run:

```shell
npm run dev
```

Open [http://localhost:4111](http://localhost:4111) in your browser to access [Mastra Studio](https://mastra.ai/docs/studio/overview).

Select **Agent** in Mastra Studio and try one of these prompts:

- `Get the weather forecast for Austin this weekend.`
- `Create a landing page for a Japanese sakura festival.`
- `Check the SPCX stock price now, then check it every minute.`

The agent asks for approval before it changes files or runs commands. When it creates a schedule, it returns an ID that you can use to pause the schedule.

## Workspace safety

The local filesystem tools stay inside the project-level `workspace/` directory. Shell commands start in that directory, but `LocalSandbox` does not provide operating-system isolation by default. Review command approvals carefully, and do not expose this template through an unauthenticated public server.

## Storage

The default `file:./mastra.db` database stores agent memory, tasks, and schedules locally. To use Turso, set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in `.env`.

Recurring schedules continue to use model tokens until you pause them. Ask the agent to pause a schedule with the ID returned by `start_schedule`.

## Webhook-triggered ingest workflow

`POST /webhooks/ingest` starts a run of `ingest-workflow`, which hands the event to an agent whose tools come from an MCP server.

Set `MCP_SERVER_URL` (and `MCP_SERVER_TOKEN` if the server needs a bearer token) in `.env`, then:

```shell
curl -X POST http://localhost:4111/webhooks/ingest \
  -H 'content-type: application/json' \
  -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -d '{"source":"github","event":"issue.created","payload":{"number":42}}'
```

The route replies `202` with a `runId` and continues the run in the background, because webhook senders retry on slow responses. Check the outcome in Studio's **Workflows** tab or with:

```shell
curl http://localhost:4111/api/workflows/ingestWorkflow/runs/<runId>
```

The route is intentionally public (`requiresAuth: false`). Set `WEBHOOK_SECRET` in `.env` to require a matching `X-Webhook-Secret` header — without it, anyone who can reach the URL can trigger runs and spend model tokens.

Without `MCP_SERVER_URL` the agent still runs, just with no tools; it reports `status: "skipped"` and logs a warning.

## Making it yours

- Edit `src/mastra/agents/agent.ts` to change the model, instructions, memory, workspace, or approval policy.
- Edit `src/mastra/tools/` to customize scheduling.
- Edit `src/mastra/index.ts` to change storage and observability.
- Edit `src/mastra/workflows/ingest-workflow.ts` to change the ingest event and result schemas, or `src/mastra/mcp/mcp-client.ts` to add more MCP servers.
- Add files or reusable skills under `workspace/` for the agent to use.

## Learn more

To learn more about Mastra, visit our [documentation](https://mastra.ai/docs/). If you're new to AI agents, check out our [course](https://mastra.ai/learn) and [YouTube videos](https://youtube.com/@mastra-ai). You can also join our [Discord](https://discord.gg/BTYqqHKUrf) community to get help and share your projects.

## Deploy to the Mastra platform

The [Mastra platform](https://projects.mastra.ai) provides two products for deploying and managing AI applications built with the Mastra framework. Learn more in the [Mastra platform documentation](https://mastra.ai/docs/mastra-platform/overview).
