import { ExecutionCoordinator } from "../../index";

export const makeInMemoryStore = () => new ExecutionCoordinator();

/** A coordinator over a new memory store holding `snapshot`. */
export async function restoredStore(
  snapshot: unknown
): Promise<ExecutionCoordinator> {
  const store = new ExecutionCoordinator();
  await store.restore(snapshot);
  return store;
}
