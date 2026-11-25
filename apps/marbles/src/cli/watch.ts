import { setTimeout } from "node:timers/promises";
import { isGone } from "@foundry/lib/process-identity";
import { asBusy } from "~/database/busy";
import { executionScopes, readExecution } from "~/database/executions";
import { readDatabase } from "~/database/open";
import { stateDatabase } from "~/layout";
import type { ExecutionRun } from "~/lib/execution-record";
import {
  type EndRecord,
  hasRunOutput,
  type RunHolding,
  RunOutputError,
  readRunOutput,
  type TerminalStatus,
} from "~/lib/state/output";

const SETTLED_AS: Partial<Record<ExecutionRun["status"], EndRecord["status"]>> =
  {
    cancelled: "cancelled",
    complete: "completed",
    failed: "failed",
  };

function holdingOf(record: ExecutionRun | null | undefined): RunHolding {
  if (record === null || record === undefined) {
    return { kind: "lost" };
  }
  const settled = SETTLED_AS[record.status];
  if (settled !== undefined) {
    const error = record.error?.message ?? record.error?.code;
    return {
      end: {
        status: settled,
        type: "end",
        ...(error === undefined ? {} : { error }),
      },
      kind: "settled",
    };
  }
  if (record.status === "queued" || record.status === "suspended") {
    return { kind: "held" };
  }
  if (
    record.status === "running" &&
    record.owner !== undefined &&
    !isGone(record.owner)
  ) {
    return { kind: "held" };
  }
  return { kind: "lost" };
}

function storedHolding(state: string, runId: string) {
  return async (workspace: string): Promise<RunHolding> =>
    holdingOf(
      await asBusy(() =>
        readDatabase(stateDatabase(state), (database) =>
          readExecution(database, workspace, runId)
        )
      )
    );
}

const QUEUED_POLL_MS = 250;

async function queuedEnd(
  state: string,
  runId: string,
  signal: AbortSignal | undefined,
  queued: () => void
): Promise<EndRecord | undefined> {
  let told = false;
  for (;;) {
    const scopes = await asBusy(() =>
      readDatabase(stateDatabase(state), (database) =>
        executionScopes(database, runId)
      )
    );
    const [scope] = scopes ?? [];
    if (scope === undefined || scopes?.length !== 1) {
      return;
    }
    const record = await asBusy(() =>
      readDatabase(stateDatabase(state), (database) =>
        readExecution(database, scope, runId)
      )
    );
    if (
      record?.status === "queued" &&
      record.owner !== undefined &&
      isGone(record.owner)
    ) {
      throw new RunOutputError(
        `run "${runId}" waits in its queue, but the process that queued it is gone and no other holds it`
      );
    }
    const holding = holdingOf(record);
    if (holding.kind === "settled") {
      return hasRunOutput(state, runId) ? undefined : holding.end;
    }
    if (record?.status !== "queued") {
      return;
    }
    if (!told) {
      queued();
      told = true;
    }
    await setTimeout(QUEUED_POLL_MS, undefined, { signal });
  }
}

export async function watchRun(
  state: string,
  runId: string,
  {
    write,
    signal,
  }: { readonly write: (text: string) => void; readonly signal?: AbortSignal }
): Promise<TerminalStatus> {
  let newline = true;
  const line = (text: string): void => {
    if (!newline) {
      write("\n");
    }
    write(`${text}\n`);
    newline = true;
  };
  const ended = await queuedEnd(state, runId, signal, () =>
    line(`[run] ${runId} waits in its queue`)
  );
  if (ended !== undefined) {
    if (ended.error !== undefined) {
      line(ended.error);
    }
    line(`[run] ${runId} ${ended.status}`);
    return ended.status;
  }
  for await (const record of readRunOutput(
    state,
    runId,
    signal,
    storedHolding(state, runId)
  )) {
    if (record.type === "start") {
      line(`[run] ${runId} ${record.name} running`);
    } else if (record.type === "text") {
      write(record.text);
      if (record.text.length > 0) {
        newline = record.text.endsWith("\n");
      }
    } else {
      if (record.output !== undefined) {
        line(record.output);
      }
      if (record.error !== undefined) {
        line(record.error);
      }
      line(`[run] ${runId} ${record.status}`);
      return record.status;
    }
  }
  throw new Error("run output ended without a terminal record");
}
