import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { config } from "../config.js";
import { ingest } from "../ingest.js";

interface WebhookParams {
  hook_id: string;
}

const paramsSchema = {
  type: "object",
  required: ["hook_id"],
  properties: {
    // slug-ish: letters, digits, dash, underscore
    hook_id: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9_-]+$",
    },
  },
} as const;

/** Constant-time secret comparison, tolerant of missing/multi-value headers. */
function secretMatches(
  provided: string | string[] | undefined,
  expected: string
): boolean {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: WebhookParams }>(
    "/webhooks/:hook_id",
    {
      schema: { params: paramsSchema },
      onRequest: async (request: FastifyRequest, reply) => {
        if (!config.webhookSecret) return;
        if (
          !secretMatches(
            request.headers["x-webhook-secret"],
            config.webhookSecret
          )
        ) {
          return reply.code(401).send({ error: "unauthorized" });
        }
      },
    },
    async (request, reply) => {
      const result = await ingest(
        {
          hookId: request.params.hook_id,
          requestId: request.id,
          headers: request.headers,
          body: request.body,
          raw: request.rawBody ?? "",
        },
        request.log
      );

      // 202: the payload is durably accepted, processing may continue async.
      return reply.code(202).send(result);
    }
  );
}
