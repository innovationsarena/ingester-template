import { anthropic } from "@ai-sdk/anthropic";
import { Agent, type AgentHooks } from "@voltagent/core";
import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { mcpTools } from "../mcp.js";

/**
 * The provider's model-id union may lag behind released models; the string is
 * passed through to the API either way. Do not downgrade the model to satisfy
 * a type — widen here instead.
 */
const model = anthropic(config.agentModel as Parameters<typeof anthropic>[0]);

/**
 * `memory: false` is deliberate. VoltAgent otherwise provisions its own local
 * store, which would drop a database file into a service that holds no state.
 */
function defineAgent(name: string, instructions: string): Agent {
  // `tools` as a function defers the MCP connection to the first agent run.
  return new Agent({ name, instructions, model, memory: false, tools: mcpTools });
}

const fallback = defineAgent("default", config.agentInstructions);

/**
 * `hook_id` is the agent id: POST /webhooks/faktura runs the "faktura" agent.
 * Adding a mail source means adding an entry here — no other code changes.
 */
const agents = new Map<string, Agent>([
  // ["faktura", defineAgent("faktura", "You process supplier invoices. ...")],
]);

export interface AgentSelection {
  agent: Agent;
  /** The agent that actually ran — differs from hookId when falling back. */
  name: string;
  fellBack: boolean;
}

export function selectAgent(hookId: string): AgentSelection {
  const agent = agents.get(hookId);
  if (agent) return { agent, name: hookId, fellBack: false };
  return { agent: fallback, name: "default", fellBack: true };
}

/**
 * Per-run hooks that put the agent's tool calls in the job's log. Passed to
 * `generateText` rather than baked into the agent so each line carries the
 * job's jobId/hookId/requestId.
 */
export function agentLogHooks(log: FastifyBaseLogger): AgentHooks {
  return {
    onToolStart: ({ tool, args }) => {
      log.info({ tool: tool.name }, "tool call started");
      log.debug({ tool: tool.name, args }, "tool call args");
    },
    onToolEnd: ({ tool, output, error }) => {
      log.info({ tool: tool.name, ok: !error }, "tool call finished");
      log.debug({ tool: tool.name, output }, "tool call output");
      // undefined = keep the tool's output as is.
      return undefined;
    },
    onToolError: ({ tool, originalError }) => {
      log.warn({ tool: tool.name, err: originalError }, "tool call failed");
      return undefined;
    },
    onStepFinish: () => {
      log.debug("agent step finished");
    },
    onRetry: ({ source }) => {
      log.warn({ source }, "agent retrying model call");
    },
  };
}

/** False when no credentials are configured, so the pipeline can skip the call. */
export const agentsEnabled = Boolean(config.anthropicApiKey);
