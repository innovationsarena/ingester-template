import { timingSafeEqual } from 'node:crypto';
import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import { ingestResultSchema } from '../workflows/ingest-workflow';

const webhookSecret = process.env.WEBHOOK_SECRET;

let warnedAboutMissingSecret = false;

const webhookBodySchema = z.object({
  source: z.string().min(1),
  event: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Constant-time comparison of the `X-Webhook-Secret` header. Returns true when no
 * secret is configured, which leaves the route fully open — see README.
 */
function isAuthorized(provided: string | undefined): boolean {
  if (!webhookSecret) return true;
  if (!provided) return false;

  const expected = Buffer.from(webhookSecret);
  const actual = Buffer.from(provided);

  // timingSafeEqual throws on length mismatch, so compare lengths first. The
  // length of the secret is not itself sensitive.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const ingestWebhookRoute = registerApiRoute('/webhooks/ingest', {
  method: 'POST',
  // Public by design. Mastra would otherwise require auth on custom routes once
  // a `server.auth` provider is configured.
  requiresAuth: false,
  openapi: {
    summary: 'Trigger the ingest workflow',
    description:
      'Accepts an event and starts a run of `ingest-workflow`. Returns 202 with the run id; the run continues in the background.',
    tags: ['Webhooks'],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: webhookBodySchema } },
    },
    responses: {
      202: {
        description: 'Run accepted',
        content: {
          'application/json': {
            schema: z.object({ status: z.literal('accepted'), runId: z.string() }),
          },
        },
      },
      400: { description: 'Malformed or invalid body' },
      401: { description: 'Missing or incorrect X-Webhook-Secret header' },
    },
  },
  handler: async c => {
    const mastra = c.get('mastra');
    const logger = mastra.getLogger();

    if (!webhookSecret && !warnedAboutMissingSecret) {
      warnedAboutMissingSecret = true;
      logger?.warn('WEBHOOK_SECRET is not set; /webhooks/ingest accepts unauthenticated requests.');
    }

    if (!isAuthorized(c.req.header('x-webhook-secret'))) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: 'body must be valid JSON' }, 400);
    }

    const parsed = webhookBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: 'invalid body', issues: parsed.error.issues }, 400);
    }

    const run = await mastra.getWorkflow('ingestWorkflow').createRun();

    // Fire-and-forget: webhook senders retry on slow responses, and an agent run
    // can take longer than their timeout. The run is persisted, so its outcome is
    // recoverable from storage and traces.
    void run
      .start({
        inputData: { ...parsed.data, receivedAt: new Date().toISOString() },
      })
      .then(result => {
        if (result.status === 'success') {
          logger?.info('Ingest run finished', { runId: run.runId, result: result.result });
        } else {
          logger?.error('Ingest run did not succeed', { runId: run.runId, status: result.status });
        }
      })
      .catch(error => {
        logger?.error('Ingest run threw', { runId: run.runId, error });
      });

    return c.json({ status: 'accepted', runId: run.runId }, 202);
  },
});

export type IngestResult = z.infer<typeof ingestResultSchema>;
