import { readRunOutput, type TerminalStatus } from "~/lib/state/output";

/** Replay then follow a run without importing source or starting an engine. */
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
  for await (const record of readRunOutput(state, runId, signal)) {
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
  // Invariant guard: the reader yields end before returning; TypeScript cannot infer that contract.
  throw new Error("run output ended without a terminal record");
}
