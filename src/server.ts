import { buildApp } from "./app.js";
import { config } from "./config.js";
import { drain, pending } from "./jobs.js";
import { disconnectMcp } from "./mcp.js";

const app = await buildApp();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal, jobs: pending() }, "shutting down");
    void (async () => {
      // Stop accepting new requests, then let running pipelines finish.
      await app.close();
      const drained = await drain(config.jobDrainTimeoutMs);
      if (!drained) app.log.warn({ jobs: pending() }, "shutdown timed out with jobs in flight");
      await disconnectMcp();
      process.exit(0);
    })();
  });
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error({ err }, "failed to start");
  process.exit(1);
}
