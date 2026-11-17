import { ExecutionCoordinator } from "../../index";

export const makeInMemoryStore = () => new ExecutionCoordinator();

export async function restoredStore(
  snapshot: unknown
): Promise<ExecutionCoordinator> {
  const store = new ExecutionCoordinator();
  await store.restore(snapshot);
  return store;
}
