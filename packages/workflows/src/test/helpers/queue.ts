import { Queue } from "../../queue";
import type { QueueOptions } from "../../queue-types";
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
