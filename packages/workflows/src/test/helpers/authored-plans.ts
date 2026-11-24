import type { JsonValue } from "@foundry/lib/json";
import type { ErrorShape, JobId } from "@foundry/queue";
import type { QueueClient } from "@foundry/queue/client";
import type {
  AuthoredContext,
  AuthoredRunInput,
  InvocationContext,
  LinearPlan,
  RehydrateContext,
  StepContract,
  TrustedStep,
} from "../../authored";
import { materializeLinear } from "../../authored";
import type { WorkflowCheckpoint } from "../../queue-handler";
import {
  checkpointOf,
  type EvidenceJournal,
  EvidenceJournal as Journal,
  settledJob,
  sharedQueueStore,
  startQueue,
} from "./authored-queue";

export interface StepOptions {
  readonly contract: StepContract;
  readonly invoke?: (
    inputs: Readonly<Record<string, string | null>>,
    ctx: InvocationContext
  ) => Promise<string | null>;
  readonly rehydrate?: (ctx: RehydrateContext) => Promise<string | null>;
}

export function makeStep(key: string, options: StepOptions): TrustedStep {
  return {
    contract: options.contract,
    invoke: options.invoke ?? (async () => `result:${key}`),
    key,
    name: key,
    ...(options.rehydrate ? { rehydrate: options.rehydrate } : {}),
  };
}

export const textInput = (required = true) =>
  ({
    key: "text",
    label: "Text",
    required,
    type: "text",
  }) as const;

export const textResult = { type: "text" } as const;

export const AUTHORED = "workflow.authored";

export const clients: QueueClient[] = [];

export const disposeClients = async (): Promise<void> => {
  for (const client of clients.splice(0)) {
    await client.dispose();
  }
};

export async function startAuthored(
  plan: LinearPlan,
  resolve: (key: string) => TrustedStep,
  persistence: EvidenceJournal,
  store: Awaited<ReturnType<typeof sharedQueueStore>>
): Promise<QueueClient> {
  const client = await startQueue<AuthoredRunInput, null, AuthoredContext>(
    store,
    AUTHORED,
    (input, { job }) =>
      materializeLinear(plan, resolve, persistence.host).factory()(
        input as unknown as AuthoredRunInput,
        persistence.execution(job.id)
      )
  );
  clients.push(client);
  return client;
}

export interface RunOutcome {
  readonly checkpoint: WorkflowCheckpoint | undefined;
  readonly error?: ErrorShape;
  readonly output: JsonValue | undefined;
  readonly persistence: EvidenceJournal;
  readonly runId: JobId;
  readonly status: string;
}

export async function runPlan(
  plan: LinearPlan,
  resolve: (key: string) => TrustedStep,
  inputs: Record<string, string> = {}
): Promise<RunOutcome> {
  const persistence = new Journal();
  const client = await startAuthored(
    plan,
    resolve,
    persistence,
    await sharedQueueStore()
  );
  const { id } = await client.submit({
    handler: { name: AUTHORED },
    input: { inputs, snapshotId: "snap" },
  });
  const { error, job, status } = await settledJob(client, id);
  return {
    checkpoint: await checkpointOf(client, id),
    output: job.state.kind === "complete" ? job.state.output : undefined,
    persistence,
    runId: id,
    status,
    ...(error ? { error } : {}),
  };
}

export function logRecords(
  persistence: EvidenceJournal,
  runId: string
): Record<string, JsonValue>[] {
  return persistence
    .frames(runId)
    .flatMap(({ kind, value }) =>
      kind === "log" &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      "event" in value
        ? [value]
        : []
    );
}

export function outputFrames(
  persistence: EvidenceJournal,
  runId: string
): Record<string, JsonValue>[] {
  return persistence
    .frames(runId)
    .filter((frame) => frame.kind === "output")
    .map((frame) => frame.value as Record<string, JsonValue>);
}

export const eventsOf = (records: Record<string, JsonValue>[], event: string) =>
  records.filter((r) => r.event === event);
