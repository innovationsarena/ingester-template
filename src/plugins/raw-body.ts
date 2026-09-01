import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyRequest {
    /** Body exactly as received, before parsing. Needed for HMAC checks. */
    rawBody?: string;
  }
}

/**
 * Replaces Fastify's JSON parser with one that keeps the raw string around, and
 * adds a catch-all parser so non-JSON webhooks (form-encoded, XML, plain text)
 * reach the handler instead of failing with 415.
 */
async function rawBodyPlugin(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser<string>(
    "application/json",
    { parseAs: "string" },
    (request, body, done) => {
      request.rawBody = body;
      if (body.length === 0) return done(null, null);
      try {
        done(null, JSON.parse(body));
      } catch (err) {
        const error = err as Error & { statusCode?: number };
        error.statusCode = 400;
        done(error, undefined);
      }
    },
  );

  app.addContentTypeParser<string>("*", { parseAs: "string" }, (request, body, done) => {
    request.rawBody = body;
    done(null, body);
  });
}

export default fp(rawBodyPlugin, { name: "raw-body" });
