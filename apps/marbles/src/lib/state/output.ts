import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { formatLogValues } from "~/lib/log";

export const outputRecordSchema = z.discriminatedUnion("type", [
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
    status: z.enum(["completed", "failed", "cancelled"]),
    type: z.literal("end"),
  }),
]);

type OutputRecord = z.infer<typeof outputRecordSchema>;

/** Append-only output for a read-only watcher in another process. */
export class RunOutput {
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
    this.#path = join(state, "output", `${runId}.jsonl`);
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

  finish(
    status: "completed" | "failed" | "cancelled",
    output?: unknown,
    error?: string
  ): void {
    this.#append({
      status,
      type: "end",
      ...(output === undefined ? {} : { output: formatLogValues([output]) }),
      ...(error === undefined ? {} : { error }),
    });
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
