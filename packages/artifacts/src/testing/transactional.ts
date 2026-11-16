import type { ArtifactStore, TransactionalArtifactStore } from "../store";

export function isTransactional(
  store: ArtifactStore
): store is TransactionalArtifactStore {
  return store.transaction !== undefined;
}
