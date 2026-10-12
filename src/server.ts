import { buildApp } from "./app.js";
import { config } from "./config.js";
import { processJob } from "./ingest.js";
import { disconnectMcp } from "./mcp.js";
import { closeQueue, startQueue } from "./queue.js";

const app = await buildApp();

// Before listen, so the first webhook already has somewhere to go.
const workerLog = app.log.child({ component: "worker" });
startQueue(workerLog, (job) => processJob(job, workerLog));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    // Backstop: closing BullMQ can stall when Redis is unreachable. Exiting is
    // safe — whatever was running is still in Redis and reruns on next start.
    setTimeout(() => {
      app.log.error("shutdown stalled, exiting");
      process.exit(1);
    }, config.jobDrainTimeoutMs + 5_000).unref();
    void (async () => {
      // Stop accepting new requests, then let the mail in progress finish.
      // Anything still queued stays in Redis for the next start.
      await app.close();
      const drained = await closeQueue(config.jobDrainTimeoutMs);
      if (!drained) app.log.warn("shutdown timed out; the job in progress will rerun on next start");
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
