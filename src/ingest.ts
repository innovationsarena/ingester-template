import type { FastifyBaseLogger } from "fastify";

import { agentsEnabled, selectAgent } from "./agents/index.js";
import { convertAll, convertToMarkdown, type ConvertRequest, type Conversion } from "./docling.js";
import * as jobs from "./jobs.js";
import { parseEmailFromWebhook, type Email } from "./mail.js";
import { buildAgentInput } from "./prompt.js";

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

/** How much of each body to put in the info-level log line. */
const PREVIEW_CHARS = 500;

function preview(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= PREVIEW_CHARS) return value;
  return `${value.slice(0, PREVIEW_CHARS)}… (+${value.length - PREVIEW_CHARS} chars)`;
}

/**
 * Docling picks its parser from the filename extension, so an unnamed part needs
 * a plausible one. Covers what actually shows up on email.
 */
const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "text/html": "html",
  "text/csv": "csv",
  "text/plain": "txt",
  "text/markdown": "md",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/tiff": "tiff",
  "image/webp": "webp",
};

function filenameFor(attachment: Email["attachments"][number], index: number): string {
  if (attachment.filename) return attachment.filename;
  const extension = EXTENSIONS[attachment.contentType.toLowerCase()] ?? "bin";
  return `attachment-${index + 1}.${extension}`;
}

/**
 * Per-process dedupe on Message-ID. Providers retry on any non-2xx and on
 * timeouts, and a retried delivery must not trigger a second agent run. This
 * resets on restart — the honest ceiling of a storage-free design.
 */
const DEDUPE_LIMIT = 1_000;
const seenMessages = new Set<string>();

function firstDelivery(messageId: string | undefined): boolean {
  if (!messageId) return true;
  if (seenMessages.has(messageId)) return false;
  seenMessages.add(messageId);
  if (seenMessages.size > DEDUPE_LIMIT) {
    const oldest = seenMessages.values().next().value;
    if (oldest !== undefined) seenMessages.delete(oldest);
  }
  return true;
}

/** The pipeline itself: convert every attachment, then hand the lot to an agent. */
async function process(email: Email, hookId: string, log: FastifyBaseLogger): Promise<void> {
  const requests: ConvertRequest[] = email.attachments.map((attachment, index) => ({
    filename: filenameFor(attachment, index),
    contentType: attachment.contentType,
    content: attachment.content,
  }));

  const conversions: Conversion[] = requests.length > 0 ? await convertAll(requests) : [];
  for (const conversion of conversions) {
    if (conversion.ok) {
      log.info(
        { filename: conversion.filename, chars: conversion.markdown.length },
        "attachment converted",
      );
    } else {
      log.warn(
        { filename: conversion.filename, reason: conversion.reason },
        "attachment conversion failed",
      );
    }
  }

  // An HTML-only message has no plain-text part; Docling accepts HTML as input,
  // so convert it rather than shipping raw markup to the model.
  let body = email;
  if (!email.text && email.html) {
    const converted = await convertToMarkdown({
      filename: "message-body.html",
      contentType: "text/html",
      content: Buffer.from(email.html, "utf8"),
    });
    if (converted.ok) body = { ...email, text: converted.markdown };
    else log.warn({ reason: converted.reason }, "html body conversion failed");
  }

  const input = buildAgentInput(body, conversions);

  // Resolved before the credential check so routing stays observable without a key.
  const { agent, name, fellBack } = selectAgent(hookId);
  if (fellBack) log.info({ hookId, agent: name }, "no agent for hook, using default");

  if (!agentsEnabled) {
    log.warn(
      { hookId, agent: name, inputChars: input.length, input: preview(input) },
      "agent skipped: ANTHROPIC_API_KEY is not set",
    );
    return;
  }

  const result = await agent.generateText(input);

  log.info(
    {
      hookId,
      agent: name,
      messageId: email.messageId,
      usage: result.usage,
      finishReason: result.finishReason,
      text: preview(result.text),
    },
    "agent completed",
  );
  log.debug({ hookId, agent: name, text: result.text }, "agent response");
}

/**
 * Single entry point for everything that arrives on /webhooks/:hook_id.
 *
 * Parses the message, then hands the pipeline to a background job so the route
 * can answer 202 immediately. Anything slow belongs inside `process`, not here.
 */
export async function ingest(
  event: WebhookEvent,
  log: FastifyBaseLogger,
): Promise<IngestResult> {
  log.info({ hookId: event.hookId, bytes: event.raw.length }, "webhook received");

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
      text: preview(email.text),
      html: preview(email.html),
      attachments: email.attachments.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
      })),
    },
    "email parsed",
  );

  // Untruncated bodies — run with LOG_LEVEL=debug to see them in full.
  log.debug({ hookId: event.hookId, text: email.text, html: email.html }, "email bodies");

  if (!firstDelivery(email.messageId)) {
    log.info({ hookId: event.hookId, messageId: email.messageId }, "duplicate delivery ignored");
    return {
      accepted: true,
      hookId: event.hookId,
      parsed: true,
      duplicate: true,
      messageId: email.messageId,
    };
  }

  jobs.run(`ingest:${event.hookId}`, log, () => process(email, event.hookId, log));

  return {
    accepted: true,
    hookId: event.hookId,
    parsed: true,
    messageId: email.messageId,
    subject: email.subject,
    attachments: email.attachments.length,
  };
}
