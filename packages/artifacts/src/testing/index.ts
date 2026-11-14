import type { ArtifactStore, ArtifactStoreWrite } from "../store";
import { isTransactional } from "./transactional";

/**
 * Stands in for a commit: call `commit` to let the write land, throw before
 * it to refuse the write, or throw after it to fail once the write landed.
 */
export type CommitInterceptor = (
  write: ArtifactStoreWrite,
  commit: (write: ArtifactStoreWrite) => Promise<void>
) => Promise<void>;

/**
 * `store` with every commit passed through `intercept`, plain commits and
 * those a transaction's view makes alike. A test double for fault injection.
 */
export function interceptCommits(
  store: ArtifactStore,
  intercept: CommitInterceptor
): ArtifactStore {
  const wrapped: ArtifactStore = {
    commit: (write) => intercept(write, (landing) => store.commit(landing)),
    findBlobs: (digest) => store.findBlobs(digest),
    findReferences: (id) => store.findReferences(id),
    getArtifact: (id) => store.getArtifact(id),
    getBlob: (id) => store.getBlob(id),
    getContent: (id) => store.getContent(id),
    listArtifacts: (query) => store.listArtifacts(query),
    listBlobs: () => store.listBlobs(),
    listContents: (artifactId) => store.listContents(artifactId),
  };
  if (!isTransactional(store)) {
    return wrapped;
  }
  return {
    ...wrapped,
    transaction: (work) =>
      store.transaction((view) => work(interceptCommits(view, intercept))),
  };
}
