import type { OrchestratorStore } from "@foundry/workflows";
import type { RunRecord } from "@foundry/workflows/schema";

import { TERMINAL_RUN_STATUSES } from "~/lib/run-store";

export class RunListing {
  readonly #store: Pick<OrchestratorStore, "getRun" | "listRuns">;
  readonly #settled = new Map<string, RunRecord>();
  readonly #live = new Set<string>();

  constructor(store: Pick<OrchestratorStore, "getRun" | "listRuns">) {
    this.#store = store;
  }

  async load(): Promise<void> {
    let cursor: number | undefined;
    do {
      const page = await this.#store.listRuns({
        limit: 200,
        order: "oldest",
        status: [...TERMINAL_RUN_STATUSES] as RunRecord["status"][],
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const run of page.items) {
        this.#settled.set(run.id, run);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }

  add(runId: string): void {
    if (!this.#settled.has(runId)) {
      this.#live.add(runId);
    }
  }

  remove(runId: string): void {
    this.#settled.delete(runId);
    this.#live.delete(runId);
  }

  async list(): Promise<readonly RunRecord[]> {
    const live: RunRecord[] = [];
    for (const runId of [...this.#live]) {
      const run = await this.#store.getRun(runId);
      if (run === null) {
        continue;
      }
      if (TERMINAL_RUN_STATUSES.has(run.status) && this.#live.has(runId)) {
        this.#live.delete(runId);
        this.#settled.set(runId, run);
      } else {
        live.push(run);
      }
    }
    return [...this.#settled.values(), ...live].sort(
      (a, b) => a.timestamps.createdAt - b.timestamps.createdAt
    );
  }
}
