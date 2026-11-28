import type { ProcessIdentity } from "@foundry/lib/process-identity";
import type { ChannelChunk } from "@foundry/workflows/channels";
import { z } from "zod";
import { formatLogValues } from "~/lib/log";
import {
  type OwnerLiveness,
  PORTABLE_OWNER_LIVENESS,
} from "~/lib/owner-liveness";

const terminalStatusSchema = z.enum(["completed", "failed", "cancelled"]);
export type TerminalStatus = z.infer<typeof terminalStatusSchema>;

export const outputRecordSchema = z.discriminatedUnion("type", [
  z.object({
    name: z.string(),
    pid: z.number().int().nonnegative(),
    runId: z.string(),
    started: z.string().nullable().optional(),
    type: z.literal("start"),
  }),
  z.object({
    chunk: z
      .object({
        at: z.string(),
        path: z.array(z.string()),
        stepId: z.string(),
      })
      .optional(),
    text: z.string(),
    type: z.literal("text"),
  }),
  z.object({
    error: z.string().optional(),
    output: z.string().optional(),
    status: terminalStatusSchema,
    type: z.literal("end"),
  }),
]);

export type OutputRecord = z.infer<typeof outputRecordSchema>;
export type EndRecord = Extract<OutputRecord, { readonly type: "end" }>;
export type ChunkOrigin = Omit<ChannelChunk, "payload">;

export class RunOutputError extends Error {
  override readonly name = "RunOutputError";
}

export interface RunOutputSink {
  append(runId: string, record: OutputRecord): void;
  read?(runId: string): readonly OutputRecord[];
  remove(runId: string): void;
}

export class MemoryRunOutputSink implements RunOutputSink {
  readonly #records = new Map<string, OutputRecord[]>();

  append(runId: string, record: OutputRecord): void {
    const records = this.#records.get(runId);
    if (records === undefined) {
      this.#records.set(runId, [record]);
    } else {
      records.push(record);
    }
  }

  read(runId: string): readonly OutputRecord[] {
    return [...(this.#records.get(runId) ?? [])];
  }

  remove(runId: string): void {
    this.#records.delete(runId);
  }
}

export interface RunOutputOptions {
  readonly liveness?: OwnerLiveness;
  readonly sink?: RunOutputSink;
}

export class RunOutput {
  readonly #runId: string;
  readonly #sink: RunOutputSink | undefined;
  readonly #warn: (line: string) => void;
  #failed = false;

  constructor(
    _state: string | undefined,
    runId: string,
    name: string,
    warn: (line: string) => void,
    options?: RunOutputOptions
  ) {
    this.#runId = runId;
    this.#warn = warn;
    if (options?.sink !== undefined) {
      this.#sink = options.sink;
      this.#start(
        name,
        options.liveness?.identity ?? PORTABLE_OWNER_LIVENESS.identity
      );
    }
  }

  text(text: string, chunk?: ChunkOrigin): void {
    this.#append({
      ...(chunk === undefined
        ? {}
        : {
            chunk: {
              at: chunk.at,
              path: [...chunk.path],
              stepId: chunk.stepId,
            },
          }),
      text,
      type: "text",
    });
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

  #start(name: string, identity: () => ProcessIdentity): void {
    try {
      const { pid, started } = identity();
      this.#append({ name, pid, runId: this.#runId, started, type: "start" });
    } catch (error) {
      this.#failure(error);
    }
  }

  #append(record: OutputRecord): void {
    if (this.#sink === undefined || this.#failed) {
      return;
    }
    try {
      this.#sink.append(this.#runId, record);
    } catch (error) {
      this.#failure(error);
    }
  }

  #failure(error: unknown): void {
    this.#failed = true;
    this.#warn(`[state] run output not saved: ${String(error)}`);
  }
}
