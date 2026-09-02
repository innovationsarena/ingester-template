import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";

import { config } from "./config.js";
import type { WebhookEvent } from "./ingest.js";

export interface MailAddress {
  name?: string;
  address: string;
}

export interface MailAttachment {
  filename?: string;
  contentType: string;
  size: number;
  /** MD5 of the decoded content, computed by mailparser. */
  checksum: string;
  /** Set for parts referenced from the HTML body as `cid:...`. */
  contentId?: string;
  inline: boolean;
  /** Decoded bytes. Persist or forward these; they are not written anywhere. */
  content: Buffer;
}

export interface Email {
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  date?: Date;
  subject?: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  replyTo: MailAddress[];
  /** text/plain body, if the message had one. */
  text?: string;
  /** text/html body, if the message had one. */
  html?: string;
  /** Plaintext body rendered as HTML by mailparser; useful when `html` is absent. */
  textAsHtml?: string;
  attachments: MailAttachment[];
  /** All headers, lower-cased keys, as parsed by mailparser. */
  headers: Map<string, unknown>;
}

/** Field names commonly used to carry a raw MIME payload, tried in order. */
const DEFAULT_FIELDS = [
  "rawMime",
  "raw_mime",
  "rawEmail",
  "raw_email",
  "mime",
  "raw",
  "content",
  "message",
  "email",
  "body",
  "data",
];

const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;
/** A MIME message starts with `Header-Name:` on its first line. */
const MIME_START_RE = /^[!-9;-~]+:/;

function getPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => {
    if (node === null || typeof node !== "object") return undefined;
    return (node as Record<string, unknown>)[key];
  }, source);
}

/** Locates the raw message inside the webhook payload. */
function findCandidate(event: WebhookEvent): string | undefined {
  // Explicit wins: MAIL_FIELD may be a dot path, e.g. "envelope.message.raw".
  if (config.mailField) {
    const value = getPath(event.body, config.mailField);
    return typeof value === "string" ? value : undefined;
  }

  if (typeof event.body === "string") return event.body;

  if (event.body !== null && typeof event.body === "object") {
    for (const field of DEFAULT_FIELDS) {
      const value = (event.body as Record<string, unknown>)[field];
      if (typeof value === "string" && value.length > 0) return value;
    }
    return undefined;
  }

  // No parsed body to inspect (e.g. an unknown content type) — try the raw text.
  return event.raw.length > 0 ? event.raw : undefined;
}

function looksLikeMime(value: string): boolean {
  return MIME_START_RE.test(value.trimStart().split(/\r?\n/, 1)[0] ?? "");
}

/**
 * Turns the candidate into MIME bytes. Handles base64 and base64url, tolerates
 * the line wrapping that transports insert, and passes plain MIME through.
 */
function toMimeBuffer(candidate: string): Buffer | undefined {
  const encoding = config.mailEncoding;

  if (encoding !== "base64" && looksLikeMime(candidate)) {
    return Buffer.from(candidate, "utf8");
  }
  if (encoding === "utf8") return Buffer.from(candidate, "utf8");

  const compact = candidate.replace(/\s+/g, "");
  if (compact.length === 0 || !BASE64_RE.test(compact)) return undefined;

  // Buffer's base64 decoder accepts both alphabets and missing padding.
  const decoded = Buffer.from(compact, "base64");
  if (decoded.length === 0) return undefined;

  // Guard against decoding something that merely looked base64-ish.
  if (encoding === "auto" && !looksLikeMime(decoded.subarray(0, 256).toString("utf8"))) {
    return undefined;
  }
  return decoded;
}

function addresses(value: AddressObject | AddressObject[] | undefined): MailAddress[] {
  if (!value) return [];
  const objects = Array.isArray(value) ? value : [value];
  return objects.flatMap((object) =>
    object.value
      .filter((entry) => typeof entry.address === "string" && entry.address.length > 0)
      .map((entry) => ({
        address: entry.address as string,
        ...(entry.name ? { name: entry.name } : {}),
      })),
  );
}

function normalize(parsed: ParsedMail): Email {
  const references = parsed.references
    ? Array.isArray(parsed.references)
      ? parsed.references
      : [parsed.references]
    : [];

  return {
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references,
    date: parsed.date,
    subject: parsed.subject,
    from: addresses(parsed.from),
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    replyTo: addresses(parsed.replyTo),
    text: parsed.text,
    html: parsed.html === false ? undefined : parsed.html,
    textAsHtml: parsed.textAsHtml,
    headers: parsed.headers,
    attachments: parsed.attachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
      checksum: attachment.checksum,
      contentId: attachment.cid,
      inline: attachment.contentDisposition === "inline" || Boolean(attachment.cid),
      content: attachment.content,
    })),
  };
}

/** Parses raw MIME bytes into the normalized shape. */
export async function parseMime(mime: Buffer): Promise<Email> {
  return normalize(await simpleParser(mime, { skipTextLinks: true }));
}

/**
 * Pulls the raw message out of a webhook payload (base64 or plain MIME) and
 * parses it. Returns undefined when the payload carries no message — the caller
 * decides whether that is an error.
 */
export async function parseEmailFromWebhook(event: WebhookEvent): Promise<Email | undefined> {
  const candidate = findCandidate(event);
  if (!candidate) return undefined;

  const mime = toMimeBuffer(candidate);
  if (!mime) return undefined;

  return parseMime(mime);
}
