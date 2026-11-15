import type { OrchestratorStore } from "@foundry/workflows";
import type { RunRecord } from "@foundry/workflows/schema";

import { TERMINAL_RUN_STATUSES } from "~/lib/run-store";

/**
 * The Runs an engine lists (`Engine.runs`): the settled Runs its run store
 * retained when it started, and every Run it has dispatched or adopted
 * since, oldest first. A Run another process left unsettled is not
 * listed; its Execution Run says how far it got.
 *
 * A settled Run never changes, so it is read once: those retained in one
 * read at start, and each of this engine's when it is first found settled.
 * Only the Runs still under way here are read again, each by its id, so a
 * listing costs what is live, not what history the store has kept.
 */
export class RunListing {
  readonly #store: Pick<OrchestratorStore, "getRun" | "listRuns">;
  readonly #settled = new Map<string, RunRecord>();
  /** Dispatched or adopted here, and not yet found settled. */
  readonly #live = new Set<string>();

  constructor(store: Pick<OrchestratorStore, "getRun" | "listRuns">) {
    this.#store = store;
  }

  /** Read the settled Runs the store retains, once, at start. */
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

  /** A Run this engine dispatched or adopted: listed from now on. */
  add(runId: string): void {
    if (!this.#settled.has(runId)) {
      this.#live.add(runId);
    }
  }

  /** A Run pruned: no longer listed. */
  remove(runId: string): void {
    this.#settled.delete(runId);
    this.#live.delete(runId);
  }

  /** Every Run listed, as stored now, oldest first. */
  async list(): Promise<readonly RunRecord[]> {
    const live: RunRecord[] = [];
    for (const runId of [...this.#live]) {
      const run = await this.#store.getRun(runId);
      // Asked again after the read: while it was under way, a listing
      // that overlapped this one may have found the Run settled, and
      // `#settled` lists it, or it was pruned, and nothing does.
      if (run === null || !this.#live.has(runId)) {
        continue;
      }
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
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
