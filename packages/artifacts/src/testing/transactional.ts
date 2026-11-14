import type { ArtifactStore, TransactionalArtifactStore } from "../store";

/** Whether the store offers `transaction`. */
export function isTransactional(
  store: ArtifactStore
): store is TransactionalArtifactStore {
  return store.transaction !== undefined;
}
