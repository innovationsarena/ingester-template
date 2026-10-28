import type { Job } from "bullmq";
import type { FastifyBaseLogger } from "fastify";

import { agentLogHooks, agentsEnabled, selectAgent } from "./agents/index.js";
import { config } from "./config.js";
import { convertAll, convertToMarkdown, type ConvertRequest, type Conversion } from "./docling.js";
import { extractMime, parseMime, type Email } from "./mail.js";
import { logMcpTools } from "./mcp.js";
import { buildAgentInput } from "./prompt.js";
import {
  enqueue,
  forgetDelivery,
  isLastAttempt,
  markFirstDelivery,
  type IngestJob,
} from "./queue.js";

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

/** Rejects the webhook with 503 so the provider redelivers later. */
function unavailable(cause: unknown): Error {
  const error = new Error("queue unavailable", { cause });
  (error as Error & { statusCode: number }).statusCode = 503;
  return error;
}

/**
 * The pipeline itself: convert every attachment, then hand the lot to an agent.
 * Throwing fails the attempt and BullMQ retries it with backoff.
 */
async function process(
  email: Email,
  hookId: string,
  lastAttempt: boolean,
  log: FastifyBaseLogger,
): Promise<void> {
  const requests: ConvertRequest[] = email.attachments.map((attachment, index) => ({
    filename: filenameFor(attachment, index),
    contentType: attachment.contentType,
    content: attachment.content,
  }));

  if (requests.length > 0) {
    log.info(
      { count: requests.length, files: requests.map((r) => r.filename) },
      "converting attachments",
    );
  } else {
    log.info("no attachments");
  }

  const conversions: Conversion[] = requests.length > 0 ? await convertAll(requests, log) : [];
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

  // A docling timeout or overload shouldn't leave the agent with half a mail:
  // retry the whole job later. The last attempt goes ahead with what it has,
  // and the prompt names the documents that could not be read.
  const transient = conversions.filter((c) => !c.ok && c.retryable);
  if (conversions.length > 0) {
    log.info(
      {
        ok: conversions.filter((c) => c.ok).length,
        failed: conversions.filter((c) => !c.ok).length,
        transient: transient.length,
      },
      "attachments converted",
    );
  }
  const transientFiles = transient.map((c) => c.filename);
  if (transient.length > 0 && lastAttempt) {
    log.warn({ files: transientFiles }, "last attempt, continuing with unreadable attachments");
  }
  if (transient.length > 0 && !lastAttempt) {
    log.warn({ files: transientFiles }, "transient conversion failures, retrying job");
    throw new Error(
      `${transient.length} of ${conversions.length} attachment(s) failed transiently: ${transient
        .map((c) => c.filename)
        .join(", ")}`,
    );
  }

  // An HTML-only message has no plain-text part; Docling accepts HTML as input,
  // so convert it rather than shipping raw markup to the model.
  let body = email;
  if (!email.text && email.html) {
    log.info({ chars: email.html.length }, "converting html body");
    const converted = await convertToMarkdown(
      {
        filename: "message-body.html",
        contentType: "text/html",
        content: Buffer.from(email.html, "utf8"),
      },
      log,
    );
    if (converted.ok) {
      body = { ...email, text: converted.markdown };
      log.info({ chars: converted.markdown.length }, "html body converted");
    } else {
      log.warn({ reason: converted.reason }, "html body conversion failed");
    }
  } else if (email.html) {
    log.debug("plain-text body present, html not converted");
  }

  const input = buildAgentInput(body, conversions);
  log.info({ chars: input.length, attachments: conversions.length }, "agent input built");
  log.debug({ input }, "agent input");

  // Resolved before the credential check so routing stays observable without a key.
  const { agent, name, fellBack } = selectAgent(hookId);
  log.info({ hookId, agent: name, fellBack }, "agent selected");

  if (!agentsEnabled) {
    log.warn(
      { hookId, agent: name, inputChars: input.length, input: preview(input) },
      "agent skipped: ANTHROPIC_API_KEY is not set",
    );
    return;
  }

  await logMcpTools(log);
  log.info({ agent: name, model: config.agentModel }, "agent started");

  let result: Awaited<ReturnType<typeof agent.generateText>>;
  try {
    result = await agent.generateText(input, { hooks: agentLogHooks(log) });
  } catch (err) {
    log.error({ err, agent: name }, "agent failed");
    throw err;
  }

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

/** Worker side: one queued mail, re-parsed from its MIME. */
export async function processJob(job: Job<IngestJob>, log: FastifyBaseLogger): Promise<void> {
  const { hookId, requestId } = job.data;
  const jobLog = log.child({ jobId: job.id, hookId, requestId, attempt: job.attemptsMade + 1 });
  const started = Date.now();
  jobLog.info("ingest job started");
  const mime = Buffer.from(job.data.mime, "base64");
  const email = await parseMime(mime);
  jobLog.info(
    {
      messageId: email.messageId,
      subject: email.subject,
      bytes: mime.length,
      attachments: email.attachments.length,
    },
    "mime re-parsed",
  );
  await process(email, hookId, isLastAttempt(job), jobLog);
  jobLog.info({ durationMs: Date.now() - started }, "ingest job completed");
}

/**
 * Single entry point for everything that arrives on /webhooks/:hook_id.
 *
 * Parses the message for logging and dedupe, then puts the raw MIME on the
 * queue so the route can answer 202 immediately. Once enqueued, the mail
 * survives restarts. Anything slow belongs inside `process`, not here.
 */
export async function ingest(
  event: WebhookEvent,
  log: FastifyBaseLogger,
): Promise<IngestResult> {
  log.info({ hookId: event.hookId, bytes: event.raw.length }, "webhook received");

  const mime = extractMime(event, log);

  if (!mime) {
    log.warn({ hookId: event.hookId }, "no MIME message found in payload");
    return { accepted: true, hookId: event.hookId, parsed: false };
  }

  const email = await parseMime(mime);

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

  const { messageId } = email;
  let first: boolean;
  try {
    first = messageId ? await markFirstDelivery(event.hookId, messageId) : true;
  } catch (err) {
    log.error({ err, hookId: event.hookId }, "dedupe check failed, answering 503");
    throw unavailable(err);
  }

  if (!messageId) log.warn({ hookId: event.hookId }, "no Message-ID, dedupe skipped");
  else if (first) log.info({ hookId: event.hookId, messageId }, "first delivery");

  if (!first) {
    log.info({ hookId: event.hookId, messageId }, "duplicate delivery ignored");
    return {
      accepted: true,
      hookId: event.hookId,
      parsed: true,
      duplicate: true,
      messageId,
    };
  }

  let jobId: string | undefined;
  try {
    jobId = await enqueue({
      hookId: event.hookId,
      requestId: event.requestId,
      mime: mime.toString("base64"),
    });
  } catch (err) {
    log.error({ err, hookId: event.hookId }, "enqueue failed, answering 503");
    if (messageId) await forgetDelivery(event.hookId, messageId).catch(() => undefined);
    throw unavailable(err);
  }

  log.info({ hookId: event.hookId, messageId, jobId }, "email queued");

  return {
    accepted: true,
    hookId: event.hookId,
    parsed: true,
    messageId,
    jobId,
    subject: email.subject,
    attachments: email.attachments.length,
  };
}
