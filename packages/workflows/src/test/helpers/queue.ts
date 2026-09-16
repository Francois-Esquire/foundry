/**
 * Test helpers — Queue lifecycle.
 *
 * Many tests construct a fresh `Queue` per `it`/`test` and never call
 * `shutdown()`. The driver fiber stays running and the `queues.status`
 * row stays `active`, which is fine for the test that constructed the
 * queue but leaks across tests in the same file (a pause from one test
 * leaks into the next test's perception of `queues.status`).
 *
 * `withQueue(opts, fn)` wraps construction + body + shutdown in a
 * try/finally so the cleanup runs whether the body returns or throws.
 *
 * Some tests need to assert post-shutdown behavior (e.g. "dispatch
 * after shutdown throws") — those callers can pass `{ shutdown: false }`
 * and call `shutdown()` explicitly inside the body. Don't smuggle the
 * assertion into the helper.
 */

import type { QueueOptions } from "../../queue";
import { Queue } from "../../queue";
import type { OrchestratorStore } from "../../store";
import { makeInMemoryStore } from "./store";

export interface WithQueueOptions extends Omit<QueueOptions, "store"> {
  /**
   * When `false`, the helper skips the `shutdown()` call in `finally`.
   * Use when the test asserts post-shutdown behavior (the caller is
   * responsible for calling `shutdown()` itself in that case).
   *
   * Defaults to `true`.
   */
  readonly shutdown?: boolean;
  /** Shared store for cross-Queue persistence assertions. */
  readonly store?: OrchestratorStore;
}

/**
 * Construct a Queue with the supplied options, hand it to `fn`, then
 * call `shutdown()` even if `fn` throws. Returns whatever `fn` returns.
 */
export async function withQueue<T>(
  opts: WithQueueOptions,
  fn: (queue: Queue) => Promise<T>
): Promise<T> {
  const { store = makeInMemoryStore(), shutdown = true, ...queueOpts } = opts;
  const queue = new Queue({ ...queueOpts, store });
  try {
    return await fn(queue);
  } finally {
    if (shutdown) {
      await queue.shutdown();
    }
  }
}
