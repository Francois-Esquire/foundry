import { ownRun, readingRuntime } from "~/authoring/runtime";
import type { RunQuery, RunView } from "~/lib/managers/runs";

export interface RunReads {
  get(runId: string): Promise<RunView | null>;
  list(query?: RunQuery): Promise<readonly RunView[]>;
}

async function read<T>(
  word: string,
  use: (reads: RunReads) => Promise<T>,
  none: T
): Promise<T> {
  const own = ownRun()?.bindings.runs?.();
  if (own !== undefined) {
    return await use(own);
  }
  const runtime = await readingRuntime(word);
  if (runtime === null) {
    return none;
  }
  return await use({
    get: (runId) => runtime.readRun(runId),
    list: (query) => runtime.readRuns(query),
  });
}

function checkedId(runId: unknown): string {
  if (typeof runId !== "string" || runId.trim() === "") {
    throw new TypeError("runs.get(): give it a run id");
  }
  return runId;
}

export const runs: RunReads = Object.freeze({
  get(runId: string): Promise<RunView | null> {
    let id: string;
    try {
      id = checkedId(runId);
    } catch (error) {
      return Promise.reject(error);
    }
    return read("runs.get()", (reads) => reads.get(id), null);
  },
  list(query?: RunQuery): Promise<readonly RunView[]> {
    return read<readonly RunView[]>(
      "runs.list()",
      (reads) => reads.list(query),
      []
    );
  },
});
