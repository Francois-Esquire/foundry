import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout } from "node:timers/promises";
import { processAlive } from "@foundry/lib/file-lock";
import { z } from "zod";
import { formatLogValues } from "~/lib/log";

const terminalStatusSchema = z.enum(["completed", "failed", "cancelled"]);
export type TerminalStatus = z.infer<typeof terminalStatusSchema>;

const outputRecordSchema = z.discriminatedUnion("type", [
  z.object({
    name: z.string(),
    pid: z.number().int().positive(),
    runId: z.string(),
    type: z.literal("start"),
  }),
  z.object({ text: z.string(), type: z.literal("text") }),
  z.object({
    error: z.string().optional(),
    output: z.string().optional(),
    status: terminalStatusSchema,
    type: z.literal("end"),
  }),
]);

export type OutputRecord = z.infer<typeof outputRecordSchema>;

/** Append-only output for a read-only watcher in another process. */
export class RunOutput {
  // TODO: Prune output journals alongside persisted runs when run retention is defined.
  readonly #path: string | undefined;
  readonly #warn: (line: string) => void;
  #failed = false;

  constructor(
    state: string | undefined,
    runId: string,
    name: string,
    warn: (line: string) => void
  ) {
    this.#warn = warn;
    if (state === undefined) {
      return;
    }
    this.#path = outputPath(state, runId);
    try {
      mkdirSync(join(state, "output"), { recursive: true });
      this.#append({ name, pid: process.pid, runId, type: "start" });
    } catch (error) {
      this.#failure(error);
    }
  }

  text(text: string): void {
    this.#append({ text, type: "text" });
  }

  finish(status: TerminalStatus, output?: unknown, error?: string): void {
    this.#append({
      status,
      type: "end",
      ...(output === undefined ? {} : { output: formatLogValues([output]) }),
      ...(error === undefined ? {} : { error }),
    });
  }

  async follow<O>(
    completion: Promise<O>,
    cancelled: () => boolean
  ): Promise<O> {
    try {
      const value = await completion;
      this.finish("completed", value);
      return value;
    } catch (error) {
      this.finish(
        cancelled() ? "cancelled" : "failed",
        undefined,
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  #append(record: OutputRecord): void {
    if (this.#path === undefined || this.#failed) {
      return;
    }
    try {
      appendFileSync(this.#path, `${JSON.stringify(record)}\n`);
    } catch (error) {
      this.#failure(error);
    }
  }

  #failure(error: unknown): void {
    this.#failed = true;
    this.#warn(`[state] run output not saved: ${String(error)}`);
  }
}

const RUN_ID = /^[a-zA-Z0-9_-]+$/;

export class RunOutputError extends Error {
  override readonly name = "RunOutputError";
}

function outputPath(workspaceState: string, runId: string): string {
  if (!RUN_ID.test(runId)) {
    throw new RunOutputError("invalid run ID");
  }
  return join(workspaceState, "output", `${runId}.jsonl`);
}

function findOutput(state: string, runId: string): string {
  // Validate even when the state root does not exist.
  outputPath(state, runId);
  const paths = existsSync(state)
    ? readdirSync(state, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => outputPath(join(state, entry.name), runId))
        .filter(existsSync)
    : [];
  const [path] = paths;
  if (paths.length !== 1 || path === undefined) {
    throw new RunOutputError(
      paths.length === 0
        ? `no saved output for run "${runId}" under ${state}`
        : `run "${runId}" has output in more than one workspace`
    );
  }
  return path;
}

/** Decodes complete JSONL records while retaining a partial trailing line. */
class OutputReader {
  readonly #runId: string;
  #pending = "";
  #owner: number | undefined;

  constructor(runId: string) {
    this.#runId = runId;
  }

  *consume(text: string): Generator<OutputRecord> {
    this.#pending += text;
    let end = this.#pending.indexOf("\n");
    while (end !== -1) {
      const record = outputRecordSchema.parse(
        JSON.parse(this.#pending.slice(0, end))
      );
      this.#pending = this.#pending.slice(end + 1);
      if (record.type === "start") {
        if (record.runId !== this.#runId) {
          throw new RunOutputError("run output belongs to a different run");
        }
        this.#owner = record.pid;
      }
      yield record;
      end = this.#pending.indexOf("\n");
    }
  }

  ownerAlive(): boolean {
    return this.#owner === undefined || processAlive(this.#owner);
  }
}

/** Replay the journal and follow appended records until its finalized end. */
export async function* readRunOutput(
  state: string,
  runId: string,
  signal?: AbortSignal
): AsyncGenerator<OutputRecord> {
  let fd: number | undefined;
  try {
    fd = openSync(findOutput(state, runId), "r");
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.alloc(65_536);
    let position = 0;
    const reader = new OutputReader(runId);
    let ownerExited = false;
    for (;;) {
      signal?.throwIfAborted();
      const count = readSync(fd, buffer, 0, buffer.length, position);
      position += count;
      for (const record of reader.consume(
        decoder.write(buffer.subarray(0, count))
      )) {
        yield record;
        if (record.type === "end") {
          return;
        }
      }
      if (count !== 0) {
        continue;
      }
      if (ownerExited) {
        throw new RunOutputError(
          `run "${runId}" lost its owner before recording completion`
        );
      }
      // Re-read after observing exit: the owner may have appended end after EOF.
      ownerExited = !reader.ownerAlive();
      if (!ownerExited) {
        await setTimeout(100, undefined, { signal });
      }
    }
  } catch (error) {
    if (signal?.aborted || error instanceof RunOutputError) {
      throw error;
    }
    throw new RunOutputError(
      `cannot read output for run "${runId}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}
