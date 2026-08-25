import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { ingestAgent } from '../agents/ingest-agent';

/** Shape the webhook route validates before starting a run. */
export const ingestEventSchema = z.object({
  source: z.string().min(1).describe('Where the event came from, e.g. "github" or "crm".'),
  event: z.string().min(1).describe('Event type, e.g. "issue.created".'),
  payload: z.record(z.string(), z.unknown()).describe('Raw event body.'),
  receivedAt: z.string().describe('ISO timestamp of when the webhook was received.'),
});

export const ingestResultSchema = z.object({
  status: z.enum(['processed', 'skipped', 'failed']),
  summary: z.string().describe('What the agent concluded about the event.'),
  actionsTaken: z.array(z.string()).describe('Tools called and what they changed, in order.'),
  notes: z.string().optional().describe('Anything the agent could not do, and why.'),
});

/**
 * Renders the event into the `prompt` string the agent step expects. Keeping this
 * as its own step means the exact prompt is visible per run in Studio and traces.
 */
const buildPromptStep = createStep({
  id: 'build-prompt',
  inputSchema: ingestEventSchema,
  outputSchema: z.object({ prompt: z.string() }),
  execute: async ({ inputData }) => {
    const { source, event, payload, receivedAt } = inputData;

    return {
      prompt: [
        `Source: ${source}`,
        `Event: ${event}`,
        `Received at: ${receivedAt}`,
        '',
        'Payload:',
        JSON.stringify(payload, null, 2),
      ].join('\n'),
    };
  },
});

export const ingestWorkflow = createWorkflow({
  id: 'ingest-workflow',
  description: 'Handles one inbound webhook event with an MCP-backed agent.',
  inputSchema: ingestEventSchema,
  outputSchema: ingestResultSchema,
})
  .then(buildPromptStep)
  .agent(ingestAgent, { structuredOutput: { schema: ingestResultSchema } })
  .commit();
