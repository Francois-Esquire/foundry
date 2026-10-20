import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout } from "node:timers/promises";
import { processAlive } from "@foundry/lib/file-lock";
import { outputRecordSchema } from "~/lib/state/output";

const RUN_ID = /^[a-zA-Z0-9_-]+$/;

function outputPath(state: string, runId: string): string {
  if (!RUN_ID.test(runId)) {
    throw new Error("invalid run ID");
  }
  const paths = existsSync(state)
    ? readdirSync(state, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(state, entry.name, "output", `${runId}.jsonl`))
        .filter(existsSync)
    : [];
  const [path] = paths;
  if (paths.length !== 1 || path === undefined) {
    throw new Error(
      paths.length === 0
        ? `no saved output for run "${runId}" under ${state}`
        : `run "${runId}" has output in more than one workspace`
    );
  }
  return path;
}

type TerminalStatus = "completed" | "failed" | "cancelled";

class OutputView {
  readonly #runId: string;
  readonly #write: (text: string) => void;
  #pending = "";
  #newline = true;
  owner: number | undefined;

  constructor(runId: string, write: (text: string) => void) {
    this.#runId = runId;
    this.#write = write;
  }

  consume(text: string): TerminalStatus | undefined {
    this.#pending += text;
    let end = this.#pending.indexOf("\n");
    while (end !== -1) {
      const record = outputRecordSchema.parse(
        JSON.parse(this.#pending.slice(0, end))
      );
      this.#pending = this.#pending.slice(end + 1);
      const status = this.#record(record);
      if (status) {
        return status;
      }
      end = this.#pending.indexOf("\n");
    }
    return undefined;
  }

  #record(
    record: ReturnType<typeof outputRecordSchema.parse>
  ): TerminalStatus | undefined {
    if (record.type === "start") {
      if (record.runId !== this.#runId) {
        throw new Error("run output belongs to a different run");
      }
      this.owner = record.pid;
      this.#line(`[run] ${this.#runId} ${record.name} running`);
    } else if (record.type === "text") {
      this.#write(record.text);
      if (record.text.length > 0) {
        this.#newline = record.text.endsWith("\n");
      }
    } else {
      if (record.output !== undefined) {
        this.#line(record.output);
      }
      if (record.error !== undefined) {
        this.#line(record.error);
      }
      this.#line(`[run] ${this.#runId} ${record.status}`);
      return record.status;
    }
    return undefined;
  }

  #line(text: string): void {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Rendering a text chunk updates this flag between calls.
    if (!this.#newline) {
      this.#write("\n");
    }
    this.#write(`${text}\n`);
    this.#newline = true;
  }
}

/** Replay then follow one persisted run without importing source or starting an engine. */
export async function watchRun(
  state: string,
  runId: string,
  {
    write,
    signal,
  }: { readonly write: (text: string) => void; readonly signal?: AbortSignal }
): Promise<TerminalStatus> {
  const fd = openSync(outputPath(state, runId), "r");
  const decoder = new StringDecoder("utf8");
  const view = new OutputView(runId, write);
  const buffer = Buffer.alloc(65_536);
  let position = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const count = readSync(fd, buffer, 0, buffer.length, position);
      position += count;
      const status = view.consume(decoder.write(buffer.subarray(0, count)));
      if (status) {
        return status;
      }
      if (count === 0) {
        if (view.owner !== undefined && !processAlive(view.owner)) {
          throw new Error(
            `run "${runId}" lost its owner before recording completion`
          );
        }
        await setTimeout(100, undefined, { signal });
      }
    }
  } finally {
    closeSync(fd);
  }
}
