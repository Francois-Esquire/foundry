import { JobAlreadySettledError, RunNotFoundError } from "./errors";
import type { OrchestratorStore } from "./execution-coordinator";
import { claimJobAttempt } from "./execution-coordinator";
import type { OrchestratorOptions } from "./orchestrator";
import type { RunRecord } from "./schema";

export class ExecutionParticipants {
  private readonly store: OrchestratorStore;
  private readonly admission: OrchestratorOptions["admissionParticipant"];
  private readonly cancellation: OrchestratorOptions["cancellationParticipant"];

  constructor(
    store: OrchestratorStore,
    admission: OrchestratorOptions["admissionParticipant"],
    cancellation: OrchestratorOptions["cancellationParticipant"]
  ) {
    this.store = store;
    this.admission = admission;
    this.cancellation = cancellation;
    if ((admission || cancellation) && !store.transaction) {
      throw new Error(
        "Runtime participants require a store that offers transactions"
      );
    }
  }

  claim(jobId: string, input: Parameters<OrchestratorStore["claimJobRun"]>[1]) {
    // biome-ignore lint/style/useDestructuring: Destructuring from `this` does not register this private field as used with noUnusedPrivateClassMembers.
    const admission = this.admission;
    const { transaction } = this.store;
    if (!(admission && transaction)) {
      return this.store.claimJobRun(jobId, input);
    }
    return this.#admit(transaction, admission, jobId, input);
  }

  async #admit(
    transaction: NonNullable<OrchestratorStore["transaction"]>,
    admission: NonNullable<OrchestratorOptions["admissionParticipant"]>,
    jobId: string,
    input: Parameters<OrchestratorStore["claimJobRun"]>[1]
  ) {
    const outcome = await transaction(async (store) => {
      const attempt = await claimJobAttempt(store, jobId, input);
      if (attempt.status === "claimed") {
        await admission({ ...attempt.claim, store });
      }
      return attempt;
    });
    if (outcome.status === "settled") {
      throw new JobAlreadySettledError(jobId);
    }
    return outcome.claim;
  }

  async recover(runId: string, jobId: string | undefined): Promise<void> {
    // biome-ignore lint/style/useDestructuring: Destructuring from `this` does not register this private field as used with noUnusedPrivateClassMembers.
    const admission = this.admission;
    if (!(admission && jobId)) {
      return;
    }
    await this.settle(runId, async (run, store) => {
      const job = await store.getJob(jobId);
      if (!job) {
        throw new Error(`Run ${runId} has no Job`);
      }
      await admission({ job, run, store });
    });
  }

  cancel(runId: string): Promise<RunRecord | null> {
    // biome-ignore lint/style/useDestructuring: Destructuring from `this` does not register this private field as used with noUnusedPrivateClassMembers.
    const cancellation = this.cancellation;
    return cancellation
      ? this.settle(runId, (run, store) => cancellation({ run, store }))
      : Promise.resolve(null);
  }

  settle<T>(
    runId: string,
    operation: (run: RunRecord, store: OrchestratorStore) => Promise<T>
  ): Promise<T> {
    const { transaction } = this.store;
    if (!transaction) {
      throw new Error("Settlement requires a store that offers transactions");
    }
    return transaction(async (store) => {
      const run = await store.getRun(runId);
      if (!run) {
        throw new RunNotFoundError(runId);
      }
      return operation(run, store);
    });
  }
}
