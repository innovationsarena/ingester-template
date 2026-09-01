import { createRequire } from "node:module";

import Fastify, { type FastifyError, type FastifyInstance } from "fastify";

import { config, isProduction } from "./config.js";
import rawBody from "./plugins/raw-body.js";
import { healthRoutes } from "./routes/health.js";
import { webhookRoutes } from "./routes/webhooks.js";

/**
 * Human-readable logs in dev, raw JSON in prod. Resolution is guarded because
 * pino-pretty is a devDependency: an image built with `--omit=dev` and started
 * with NODE_ENV=development would otherwise crash on boot.
 */
function logTransport(): { target: string } | undefined {
  if (isProduction) return undefined;
  try {
    createRequire(import.meta.url).resolve("pino-pretty");
    return { target: "pino-pretty" };
  } catch {
    return undefined;
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: config.bodyLimit,
    trustProxy: true,
    logger: {
      level: config.logLevel,
      transport: logTransport(),
      redact: ["req.headers.authorization", "req.headers['x-webhook-secret']"],
    },
  });

  // Set before registering routes so every route context inherits them.
  app.setNotFoundHandler(async (request, reply) =>
    reply.code(404).send({ error: "not_found", path: request.url }),
  );

  app.setErrorHandler<FastifyError>(async (error, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, "request failed");
    else request.log.warn({ err: error }, "request rejected");

    return reply.code(status).send({
      error: status >= 500 ? "internal_error" : (error.code ?? "bad_request"),
      message: status >= 500 && isProduction ? undefined : error.message,
    });
  });

  await app.register(rawBody);
  await app.register(healthRoutes);
  await app.register(webhookRoutes);

  return app;
}
