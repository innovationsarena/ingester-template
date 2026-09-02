import type { FastifyBaseLogger } from "fastify";

import { parseEmailFromWebhook } from "./mail.js";

export interface WebhookEvent {
  /** The `:hook_id` path segment the payload arrived on. */
  hookId: string;
  /** Correlation id, mirrored back to the caller as `x-request-id`. */
  requestId: string;
  headers: Record<string, string | string[] | undefined>;
  /** Parsed JSON body, or the raw string for non-JSON content types. */
  body: unknown;
  /** Untouched request body — use this for HMAC signature checks. */
  raw: string;
}

export interface IngestResult {
  accepted: boolean;
  [key: string]: unknown;
}

/**
 * Single entry point for everything that arrives on /webhooks/:hook_id.
 *
 * Replace the body with your own dispatch (queue publish, DB write, per-hook
 * handler lookup, ...). Keep it fast: the route answers 202 as soon as this
 * resolves, so offload slow work to a queue rather than awaiting it here.
 */
export async function ingest(
  event: WebhookEvent,
  log: FastifyBaseLogger
): Promise<IngestResult> {
  log.info(
    { hookId: event.hookId, bytes: event.raw.length },
    "webhook received"
  );

  const email = await parseEmailFromWebhook(event);

  if (!email) {
    log.warn({ hookId: event.hookId }, "no MIME message found in payload");
    return { accepted: true, hookId: event.hookId, parsed: false };
  }

  log.info(
    {
      hookId: event.hookId,
      messageId: email.messageId,
      from: email.from.map((a) => a.address),
      to: email.to.map((a) => a.address),
      subject: email.subject,
      hasText: Boolean(email.text),
      hasHtml: Boolean(email.html),
      attachments: email.attachments.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
      })),
    },
    "email parsed"
  );

  // TODO: this is where the message goes somewhere useful — store the bodies,
  // upload `attachment.content` to object storage, publish to a queue, ...
  // `email.attachments[].content` holds the decoded bytes; nothing is persisted.

  return {
    accepted: true,
    hookId: event.hookId,
    parsed: true,
    messageId: email.messageId,
    subject: email.subject,
    attachments: email.attachments.length,
  };
}
