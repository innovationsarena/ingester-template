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

export const config = {
  env: process.env.NODE_ENV ?? "development",
  host: process.env.HOST ?? "0.0.0.0",
  port: int(process.env.PORT, 3000),
  logLevel: process.env.LOG_LEVEL ?? "info",
  /** Max accepted webhook payload size in bytes. */
  bodyLimit: int(process.env.BODY_LIMIT, 1_048_576),
  /** Shared secret used to authenticate incoming webhooks. Unset = no check. */
  webhookSecret: process.env.WEBHOOK_SECRET,
  /**
   * Where the raw MIME message sits in the JSON payload, as a dot path
   * (e.g. `message.raw`). Unset = probe a list of common field names.
   */
  mailField: process.env.MAIL_FIELD,
  /** How that field is encoded: `auto` sniffs base64 vs plain MIME. */
  mailEncoding: mailEncoding(process.env.MAIL_ENCODING),
} as const;

export const isProduction = config.env === "production";
