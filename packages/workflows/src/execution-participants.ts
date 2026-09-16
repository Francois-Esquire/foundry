import { RunNotFoundError } from "./errors";
import type { OrchestratorOptions } from "./orchestrator";
import type { ExecutionPersistence } from "./persistence";
import { orchestratorStoreFromPersistence } from "./persistence-compatibility";
import type { OrchestratorStore, RunRecord } from "./store";

export class ExecutionParticipants {
  constructor(
    private readonly persistence: ExecutionPersistence | undefined,
    private readonly store: OrchestratorStore,
    private readonly admission: OrchestratorOptions["admissionParticipant"],
    private readonly cancellation: OrchestratorOptions["cancellationParticipant"]
  ) {
    if ((admission || cancellation) && !persistence?.transaction) {
      throw new Error("Runtime participants require transactional persistence");
    }
  }

  claim(jobId: string, input: Parameters<OrchestratorStore["claimJobRun"]>[1]) {
    const admission = this.admission;
    const transaction = this.persistence?.transaction;
    if (!(admission && transaction)) {
      return this.store.claimJobRun(jobId, input);
    }
    return transaction(async (persistence) => {
      const claimed = await orchestratorStoreFromPersistence(
        persistence
      ).claimJobRun(jobId, input);
      await admission({ ...claimed, persistence });
      return claimed;
    });
  }

  async recover(runId: string, jobId: string | undefined): Promise<void> {
    const admission = this.admission;
    if (!(admission && jobId)) {
      return;
    }
    await this.settle(runId, async (run, persistence) => {
      const job = await persistence.repository.getJob(jobId);
      if (!job) {
        throw new Error(`Run ${runId} has no Job`);
      }
      await admission({ job, persistence, run });
    });
  }

  cancel(runId: string): Promise<RunRecord | null> {
    const cancellation = this.cancellation;
    return cancellation
      ? this.settle(runId, (run, persistence) =>
          cancellation({ persistence, run })
        )
      : Promise.resolve(null);
  }

  settle<T>(
    runId: string,
    operation: (run: RunRecord, persistence: ExecutionPersistence) => Promise<T>
  ): Promise<T> {
    const transaction = this.persistence?.transaction;
    if (!transaction) {
      throw new Error("Settlement requires transactional persistence");
    }
    return transaction(async (persistence) => {
      const run = await persistence.repository.getRun(runId);
      if (!run) {
        throw new RunNotFoundError(runId);
      }
      return operation(run, persistence);
    });
  }
}
