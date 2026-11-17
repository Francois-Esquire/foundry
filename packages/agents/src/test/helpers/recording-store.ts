import type { SessionStore, SessionStoreWrite } from "../../store";

export interface RecordingStore {
  readonly store: SessionStore;
  readonly writes: SessionStoreWrite[];
}

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
        (await target.transaction?.((view) => work(wrap(view)))) as T;
    }
    return store;
  };
  return { store: wrap(inner), writes };
}
