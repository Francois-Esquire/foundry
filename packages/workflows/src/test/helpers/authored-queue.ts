import type { JsonValue } from "@foundry/lib/json";
import type { ErrorShape, Job, JobId } from "@foundry/queue";
import { createQueueClient, type QueueClient } from "@foundry/queue/client";
import { QueueStore, type QueueStoreService } from "@foundry/queue/store";
import { MemoryQueueStore } from "@foundry/queue/store/memory";
import { Effect, Layer } from "effect";
import type {
  BoundContractRecord,
  EvidenceHost,
  StampedOutput,
} from "../../authored";
import type { RunExecutionContext } from "../../definitions";
import {
  type WorkflowCheckpoint,
  WorkflowCheckpointSchema,
  type WorkflowRunFactory,
  workflowHandler,
} from "../../queue-handler";
import type { BaseContext } from "../../slices/executable";

export interface JournalFrame {
  readonly kind: "log" | "output";
  readonly value: JsonValue;
}

const isRecord = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class EvidenceJournal {
  readonly #claims = new Set<string>();
  readonly #frames = new Map<string, JournalFrame[]>();

  readonly host: EvidenceHost = {
    evidenceOf: async (runId, placement) => {
      let bound: BoundContractRecord | null = null;
      const outputs: StampedOutput[] = [];
      for (const { kind, value } of this.frames(runId)) {
        if (!isRecord(value) || value.placement !== placement) {
          continue;
        }
        if (kind === "log" && value.event === "invocation-bound") {
          bound = value as unknown as BoundContractRecord;
        }
        if (kind === "output") {
          outputs.push(value as unknown as StampedOutput);
        }
      }
      return await Promise.resolve({ bound, outputs });
    },
    recordEvidence: async (runId, record) => {
      await this.#append(runId, {
        kind: "log",
        value: record as unknown as JsonValue,
      });
    },
  };

  claimed(runId: string, key: string): boolean {
    return this.#claims.has(`${runId}\n${key}`);
  }

  execution(runId: string): RunExecutionContext {
    return {
      claimEffect: async (key) => {
        const claim = `${runId}\n${key}`;
        const first = !this.#claims.has(claim);
        this.#claims.add(claim);
        return await Promise.resolve(first);
      },
      emitOutput: (value) => this.#append(runId, { kind: "output", value }),
      runId,
    };
  }

  frames(runId: string): readonly JournalFrame[] {
    return this.#frames.get(runId) ?? [];
  }

  #append(runId: string, frame: JournalFrame): Promise<void> {
    this.#frames.set(runId, [...this.frames(runId), frame]);
    return Promise.resolve();
  }
}

export const sharedQueueStore = (): Promise<QueueStoreService> =>
  Effect.runPromise(Effect.provide(QueueStore, MemoryQueueStore));

export const startQueue = async <I, O, X extends BaseContext = BaseContext>(
  store: QueueStoreService,
  name: string,
  factory: WorkflowRunFactory<I, O, X>
): Promise<QueueClient> => {
  const client = createQueueClient({
    defaultLimit: Number.POSITIVE_INFINITY,
    store: Layer.succeed(QueueStore, store),
  });
  await client.register(name, workflowHandler(factory));
  return client;
};

const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

export const waitFor = async (
  predicate: () => Promise<boolean> | boolean,
  label: string
): Promise<void> => {
  for (let poll = 0; poll < 400; poll += 1) {
    if (await predicate()) {
      return;
    }
    await pause();
  }
  throw new Error(`waitFor timed out: ${label}`);
};

const TERMINAL: ReadonlySet<string> = new Set([
  "complete",
  "failed",
  "cancelled",
]);

export interface SettledJob {
  readonly error?: ErrorShape;
  readonly job: Job;
  readonly status: Job["state"]["kind"];
}

export const settledJob = async (
  client: QueueClient,
  id: JobId
): Promise<SettledJob> => {
  let job = await client.getJob(id);
  await waitFor(async () => {
    job = await client.getJob(id);
    return job !== undefined && TERMINAL.has(job.state.kind);
  }, `job ${id} settled`);
  if (job === undefined) {
    throw new Error(`job ${id} is gone`);
  }
  const { state } = job;
  return {
    job,
    status: state.kind,
    ...(state.kind === "failed" ? { error: state.error } : {}),
  };
};

export const checkpointOf = async (
  client: QueueClient,
  id: JobId
): Promise<WorkflowCheckpoint | undefined> => {
  const runs = await client.listRuns({ jobId: id });
  const latest = [...runs].sort((a, b) => a.attempt - b.attempt).at(-1);
  const parsed = WorkflowCheckpointSchema.safeParse(latest?.checkpoint);
  return parsed.success ? parsed.data : undefined;
};
