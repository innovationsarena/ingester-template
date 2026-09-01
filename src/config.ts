const int = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) throw new Error(`Expected an integer, got "${value}"`);
  return parsed;
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
} as const;

export const isProduction = config.env === "production";
