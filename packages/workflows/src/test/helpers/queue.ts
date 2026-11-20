import type { OrchestratorStore } from "../../index";
import { Queue } from "../../queue";
import type { QueueOptions } from "../../queue-types";
import { makeInMemoryStore } from "./store";

export interface WithQueueOptions extends Omit<QueueOptions, "store"> {
  readonly shutdown?: boolean;
  readonly store?: OrchestratorStore;
}

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
