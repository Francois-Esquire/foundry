import { TERMINAL_RUN_STATUSES } from "~/lib/run-store";
import type { RunReads, RunRecord } from "~/lib/workflow-runs";
import { readRun, readRuns } from "~/lib/workflow-runs";

export class RunListing {
  readonly #store: RunReads;
  readonly #settled = new Map<string, RunRecord>();
  readonly #live = new Set<string>();
  readonly #elsewhere = new Set<string>();

  constructor(store: RunReads) {
    this.#store = store;
  }

  async load(): Promise<void> {
    for (const run of await readRuns(this.#store)) {
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        this.#settled.set(run.id, run);
      } else {
        this.#elsewhere.add(run.id);
      }
    }
  }

  add(runId: string): void {
    if (!this.#settled.has(runId)) {
      this.#elsewhere.delete(runId);
      this.#live.add(runId);
    }
  }

  remove(runId: string): void {
    this.#settled.delete(runId);
    this.#live.delete(runId);
    this.#elsewhere.delete(runId);
  }

  async list(): Promise<readonly RunRecord[]> {
    const read: RunRecord[] = [];
    for (const runId of [...this.#live, ...this.#elsewhere]) {
      const run = await readRun(this.#store, runId);
      if (run === null) {
        continue;
      }
      if (!TERMINAL_RUN_STATUSES.has(run.status)) {
        read.push(run);
      } else if (this.#live.delete(runId) || this.#elsewhere.delete(runId)) {
        this.#settled.set(runId, run);
      }
    }
    const live = read.filter((run) => this.#live.has(run.id));
    return [...this.#settled.values(), ...live].sort(
      (a, b) => a.timestamps.createdAt - b.timestamps.createdAt
    );
  }
}
