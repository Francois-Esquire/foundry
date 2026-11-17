import type { ArtifactStore, ArtifactStoreWrite } from "../store";
import { isTransactional } from "./transactional";

export type CommitInterceptor = (
  write: ArtifactStoreWrite,
  commit: (write: ArtifactStoreWrite) => Promise<void>
) => Promise<void>;

export function interceptCommits(
  store: ArtifactStore,
  intercept: CommitInterceptor
): ArtifactStore {
  const wrapped: ArtifactStore = {
    commit: (write) => intercept(write, (landing) => store.commit(landing)),
    ...(store.durability === undefined ? {} : { durability: store.durability }),
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
