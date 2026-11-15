import type { SessionStore, SessionStoreWrite } from "../../store";

/** A store over another that records every write made through it. */
export interface RecordingStore {
  readonly store: SessionStore;
  /** Each write in the order it was made, through a transaction's view too. */
  readonly writes: SessionStoreWrite[];
}

/**
 * Wraps `inner`, recording each write before `before` sees it and `inner`
 * applies it. `before` may delay or refuse a write by returning a promise
 * or throwing. The inner store's `transaction` is forwarded, and its view
 * is wrapped the same way.
 */
export function recordingStore(
  inner: SessionStore,
  before?: (write: SessionStoreWrite) => void | Promise<void>
): RecordingStore {
  const writes: SessionStoreWrite[] = [];
  const wrap = (target: SessionStore): SessionStore => {
    const store: SessionStore = {
      commit: async (write) => {
        writes.push(write);
        await before?.(write);
        await target.commit(write);
      },
      getMessage: (id) => target.getMessage(id),
      getSession: (id) => target.getSession(id),
      listMessages: (sessionId) => target.listMessages(sessionId),
    };
    if (target.transaction !== undefined) {
      store.transaction = async <T>(
        work: (view: SessionStore) => Promise<T>
      ): Promise<T> =>
        // Present, checked above; called on `target` so it keeps its `this`.
        (await target.transaction?.((view) => work(wrap(view)))) as T;
    }
    return store;
  };
  return { store: wrap(inner), writes };
}
