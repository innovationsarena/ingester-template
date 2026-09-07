const int = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) throw new Error(`Expected an integer, got "${value}"`);
  return parsed;
};

const MAIL_ENCODINGS = ["auto", "base64", "utf8"] as const;
type MailEncoding = (typeof MAIL_ENCODINGS)[number];

const mailEncoding = (value: string | undefined): MailEncoding => {
  if (!value) return "auto";
  if ((MAIL_ENCODINGS as readonly string[]).includes(value)) return value as MailEncoding;
  throw new Error(`MAIL_ENCODING must be one of ${MAIL_ENCODINGS.join(", ")}, got "${value}"`);
};

/** Trailing slashes break `${base}/v1/convert/source`. */
const url = (value: string | undefined): string | undefined =>
  value ? value.replace(/\/+$/, "") : undefined;

const DEFAULT_INSTRUCTIONS = [
  "You process incoming email for an ingestion pipeline.",
  "Each input is one message: its headers, its body, and any attachments already",
  "converted to Markdown. Summarise what arrived, extract the facts that matter",
  "(sender, dates, amounts, reference numbers, requested action), and state clearly",
  "what should happen next. If an attachment failed to convert, say so rather than",
  "guessing at its contents.",
].join(" ");

export const config = {
  env: process.env.NODE_ENV ?? "development",
  host: process.env.HOST ?? "0.0.0.0",
  port: int(process.env.PORT, 3000),
  logLevel: process.env.LOG_LEVEL ?? "info",
  /**
   * Max accepted webhook payload size in bytes. Defaults to 30 MB: base64 inflates
   * MIME by ~33%, so a 25 MB attachment arrives as ~34 MB of request body.
   */
  bodyLimit: int(process.env.BODY_LIMIT, 31_457_280),
  /** Shared secret used to authenticate incoming webhooks. Unset = no check. */
  webhookSecret: process.env.WEBHOOK_SECRET,
  /**
   * Where the raw MIME message sits in the JSON payload, as a dot path
   * (e.g. `message.raw`). Unset = probe a list of common field names.
   */
  mailField: process.env.MAIL_FIELD,
  /** How that field is encoded: `auto` sniffs base64 vs plain MIME. */
  mailEncoding: mailEncoding(process.env.MAIL_ENCODING),

  /** docling-serve base URL, e.g. http://localhost:5001. Unset = conversion disabled. */
  doclingUrl: url(process.env.DOCLING_URL),
  /** Sent as `X-Api-Key` when docling-serve runs with DOCLING_SERVE_API_KEY. */
  doclingApiKey: process.env.DOCLING_API_KEY,
  /** Per-document conversion timeout. OCR on a large scan is slow. */
  doclingTimeoutMs: int(process.env.DOCLING_TIMEOUT_MS, 120_000),
  /** How many documents to convert at once. */
  doclingConcurrency: int(process.env.DOCLING_CONCURRENCY, 2),
  /** Attachments larger than this are skipped, not converted. */
  maxAttachmentBytes: int(process.env.MAX_ATTACHMENT_BYTES, 26_214_400),

  /**
   * Streamable-HTTP MCP endpoint whose tools every agent gets. Set to empty to
   * run without MCP tools.
   */
  mcpUrl: url(process.env.MCP_URL ?? "https://gr-mcp.innovationsarenan.se/mcp"),
  /** Per-request timeout for MCP calls, tool listing included. */
  mcpTimeoutMs: int(process.env.MCP_TIMEOUT_MS, 30_000),

  /** Model id passed to @ai-sdk/anthropic. */
  agentModel: process.env.AGENT_MODEL ?? "claude-opus-5",
  /** System prompt for the fallback agent. */
  agentInstructions: process.env.AGENT_INSTRUCTIONS ?? DEFAULT_INSTRUCTIONS,
  /** Present = the provider can authenticate. Read by the SDK itself. */
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  /** How long shutdown waits for in-flight background jobs. */
  jobDrainTimeoutMs: int(process.env.JOB_DRAIN_TIMEOUT_MS, 30_000),
} as const;

export const isProduction = config.env === "production";
