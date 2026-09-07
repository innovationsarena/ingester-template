import type { FastifyBaseLogger } from "fastify";

const inflight = new Set<Promise<unknown>>();

/**
 * Runs work after the response has been sent. Failures are logged, never thrown
 * into the request path — the webhook has already been answered by then.
 */
export function run(name: string, log: FastifyBaseLogger, fn: () => Promise<void>): void {
  const promise = fn()
    .catch((err: unknown) => log.error({ err, job: name }, "background job failed"))
    .finally(() => {
      inflight.delete(promise);
    });
  inflight.add(promise);
}

export function pending(): number {
  return inflight.size;
}

/**
 * Waits for in-flight jobs before shutdown. Without this a SIGTERM during a
 * deploy kills a running conversion or agent turn halfway through.
 * Resolves false if the timeout hits first.
 */
export async function drain(timeoutMs: number): Promise<boolean> {
  if (inflight.size === 0) return true;

  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });

  try {
    return await Promise.race([Promise.all([...inflight]).then(() => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}
