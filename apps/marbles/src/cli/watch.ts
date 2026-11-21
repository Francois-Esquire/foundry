import { isGone } from "@foundry/lib/process-identity";
import { asBusy } from "~/database/busy";
import { readExecution } from "~/database/executions";
import { readDatabase } from "~/database/open";
import { stateDatabase } from "~/layout";
import type { ExecutionRun } from "~/lib/execution-record";
import {
  type EndRecord,
  type RunHolding,
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
  if (record.status === "running" && !isGone(record.owner)) {
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
