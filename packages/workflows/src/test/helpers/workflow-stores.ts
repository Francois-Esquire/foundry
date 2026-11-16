import type { WorkflowStore, WorkflowStoreWrite } from "../../store/index";
import { MemoryWorkflowStore } from "../../store/memory";

export function withoutTransaction(store: WorkflowStore): WorkflowStore {
  return {
    commit: (write) => store.commit(write),
    getJob: (id) => store.getJob(id),
    getQueue: (id) => store.getQueue(id),
    getRun: (id) => store.getRun(id),
    getSuspension: (id) => store.getSuspension(id),
    listFrames: (query) => store.listFrames(query),
    listJobs: (query) => store.listJobs(query),
    listQueues: () => store.listQueues(),
    listRuns: (query) => store.listRuns(query),
    listSuspensions: (query) => store.listSuspensions(query),
  };
}

export class FaultyWorkflowStore implements WorkflowStore {
  before: (write: WorkflowStoreWrite) => void | Promise<void> = () => undefined;
  readonly commits: WorkflowStoreWrite[] = [];
  readonly failures: unknown[] = [];
  readonly #inner: WorkflowStore;
  readonly #owner: FaultyWorkflowStore;

  constructor(
    inner: WorkflowStore = new MemoryWorkflowStore(),
    owner?: FaultyWorkflowStore
  ) {
    this.#inner = inner;
    this.#owner = owner ?? this;
  }

  async commit(write: WorkflowStoreWrite): Promise<void> {
    await this.#owner.before(write);
    this.#owner.commits.push(structuredClone(write));
    try {
      await this.#inner.commit(write);
    } catch (error) {
      this.#owner.failures.push(error);
      throw error;
    }
  }

  transaction<T>(work: (view: WorkflowStore) => Promise<T>): Promise<T> {
    const inner = this.#inner;
    if (inner.transaction === undefined) {
      throw new Error("the inner store has no transaction(work)");
    }
    return inner.transaction((view) =>
      work(new FaultyWorkflowStore(view, this.#owner))
    );
  }

  getJob(id: string) {
    return this.#inner.getJob(id);
  }

  getQueue(id: string) {
    return this.#inner.getQueue(id);
  }

  getRun(id: string) {
    return this.#inner.getRun(id);
  }

  getSuspension(id: string) {
    return this.#inner.getSuspension(id);
  }

  listFrames(query: Parameters<WorkflowStore["listFrames"]>[0]) {
    return this.#inner.listFrames(query);
  }

  listJobs(query: Parameters<WorkflowStore["listJobs"]>[0]) {
    return this.#inner.listJobs(query);
  }

  listQueues() {
    return this.#inner.listQueues();
  }

  listRuns(query: Parameters<WorkflowStore["listRuns"]>[0]) {
    return this.#inner.listRuns(query);
  }

  listSuspensions(query: Parameters<WorkflowStore["listSuspensions"]>[0]) {
    return this.#inner.listSuspensions(query);
  }
}
