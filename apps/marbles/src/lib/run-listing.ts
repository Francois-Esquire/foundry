import type { OrchestratorStore } from "@foundry/workflows";
import type { RunRecord } from "@foundry/workflows/schema";

import { TERMINAL_RUN_STATUSES } from "~/lib/run-store";

export class RunListing {
  readonly #store: Pick<OrchestratorStore, "getRun" | "listRuns">;
  readonly #settled = new Map<string, RunRecord>();
  readonly #live = new Set<string>();
  readonly #elsewhere = new Set<string>();

  constructor(store: Pick<OrchestratorStore, "getRun" | "listRuns">) {
    this.#store = store;
  }

  async load(): Promise<void> {
    let cursor: number | undefined;
    do {
      const page = await this.#store.listRuns({
        limit: 200,
        order: "oldest",
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const run of page.items) {
        if (TERMINAL_RUN_STATUSES.has(run.status)) {
          this.#settled.set(run.id, run);
        } else {
          this.#elsewhere.add(run.id);
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
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
      const run = await this.#store.getRun(runId);
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
