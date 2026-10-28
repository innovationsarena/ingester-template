import { Queue, Worker, type Job } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { Redis } from "ioredis";

import { config } from "./config.js";

/** What goes into Redis per mail. MIME rather than the parsed shape: Buffers don't survive JSON. */
export interface IngestJob {
  hookId: string;
  /** The webhook's request id, so worker logs can be tied back to the delivery. */
  requestId: string;
  /** Raw MIME message, base64. */
  mime: string;
}

export type IngestProcessor = (job: Job<IngestJob>) => Promise<void>;

const QUEUE_NAME = "ingest";
const FAILED_RETENTION_S = 7 * 24 * 60 * 60;

/**
 * Two connections with opposite failure modes. The webhook side fails fast so
 * a Redis outage turns into a 503 the provider retries, rather than a request
 * hanging on ioredis's offline queue. The worker side retries forever, which
 * BullMQ requires for its blocking reads.
 */
let producer: Redis | undefined;
let consumer: Redis | undefined;
let queue: Queue<IngestJob> | undefined;
let worker: Worker<IngestJob> | undefined;

function requireStarted(): { producer: Redis; queue: Queue<IngestJob> } {
  if (!producer || !queue) throw new Error("queue not started");
  return { producer, queue };
}

/** Connects to Redis and starts consuming. Call once, after the server is listening. */
export function startQueue(log: FastifyBaseLogger, processor: IngestProcessor): void {
  producer = new Redis(config.redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  consumer = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

  queue = new Queue<IngestJob>(QUEUE_NAME, {
    connection: producer,
    defaultJobOptions: {
      attempts: config.queueAttempts,
      backoff: { type: "exponential", delay: 30_000 },
      // The payload is the whole mail; don't keep it once it has been handled.
      removeOnComplete: true,
      // Failed mails stay inspectable (and retryable by hand) for a week.
      removeOnFail: { age: FAILED_RETENTION_S },
    },
  });

  worker = new Worker<IngestJob>(QUEUE_NAME, processor, {
    connection: consumer,
    concurrency: config.queueConcurrency,
  });

  log.info(
    { queue: QUEUE_NAME, concurrency: config.queueConcurrency, attempts: config.queueAttempts },
    "queue started",
  );

  queue.on("error", (err) => log.error({ err }, "queue redis error"));
  worker.on("error", (err) => log.error({ err }, "worker redis error"));
  worker.on("ready", () => log.info("worker connected to redis"));
  worker.on("active", (job) =>
    log.debug({ jobId: job.id, hookId: job.data.hookId, requestId: job.data.requestId }, "job picked up"),
  );
  worker.on("completed", (job) => log.debug({ jobId: job.id }, "job removed"));
  worker.on("failed", (job, err) => {
    if (!job) return;
    const final = job.attemptsMade >= (job.opts.attempts ?? 1);
    log[final ? "error" : "warn"](
      {
        err,
        jobId: job.id,
        hookId: job.data.hookId,
        requestId: job.data.requestId,
        attempt: job.attemptsMade,
        attempts: job.opts.attempts,
        // Mirrors the exponential backoff configured above.
        ...(final ? {} : { nextRetryInMs: 30_000 * 2 ** (job.attemptsMade - 1) }),
      },
      final ? "ingest job failed, giving up" : "ingest job failed, will retry",
    );
  });
}

/** True on the attempt BullMQ won't follow with another. */
export function isLastAttempt(job: Job<IngestJob>): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

export async function enqueue(data: IngestJob): Promise<string | undefined> {
  const job = await requireStarted().queue.add("mail", data);
  return job.id;
}

const dedupeKey = (hookId: string, messageId: string): string =>
  `${QUEUE_NAME}:dedupe:${hookId}:${messageId}`;

/**
 * Providers retry on any non-2xx and on timeouts, and a retried delivery must
 * not trigger a second agent run. Kept in Redis so it holds across restarts.
 */
export async function markFirstDelivery(hookId: string, messageId: string): Promise<boolean> {
  const { producer } = requireStarted();
  const result = await producer.set(dedupeKey(hookId, messageId), "1", "EX", config.dedupeTtlS, "NX");
  return result === "OK";
}

/** Undoes `markFirstDelivery` when enqueueing failed, so the provider's retry is accepted. */
export async function forgetDelivery(hookId: string, messageId: string): Promise<void> {
  await requireStarted().producer.del(dedupeKey(hookId, messageId));
}

/**
 * Lets the mail in progress finish, up to `timeoutMs`. Past that the worker is
 * force-closed; the job's lock lapses and it runs again on the next start.
 * Resolves false if the timeout hit.
 */
export async function closeQueue(timeoutMs: number): Promise<boolean> {
  let drained = true;
  if (worker) {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      drained = await Promise.race([worker.close().then(() => true), expired]);
    } finally {
      clearTimeout(timer);
    }
    if (!drained) await worker.close(true);
  }
  await queue?.close();
  // Connections handed to BullMQ are not closed by it. disconnect, not quit:
  // quit queues behind a dead connection and never resolves.
  producer?.disconnect();
  consumer?.disconnect();
  return drained;
}
