import { vi } from "vitest";
import type { WorkspaceStore, WorkspaceStoreWrite } from "../../store";

type Next = (write: WorkspaceStoreWrite) => Promise<void>;

export function interceptCommits(store: WorkspaceStore) {
  const commit = store.commit.bind(store);
  const transaction = store.transaction?.bind(store);
  const intercept = vi.fn<
    (write: WorkspaceStoreWrite, next: Next) => Promise<void>
  >((write, next) => next(write));
  store.commit = (write) => intercept(write, commit);
  if (transaction) {
    store.transaction = (work) =>
      transaction((view) =>
        work({ ...view, commit: (write) => intercept(write, view.commit) })
      );
  }
  return {
    intercept,
    restore: () => {
      store.commit = commit;
      store.transaction = transaction;
    },
  };
}
