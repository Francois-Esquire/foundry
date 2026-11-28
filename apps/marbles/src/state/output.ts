import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout } from "node:timers/promises";
import {
  isGone,
  type ProcessIdentity,
} from "@foundry/lib/node/process-identity";
import type { ChannelMessage } from "@foundry/workflows/channels";
import { NODE_OWNER_LIVENESS } from "~/host/liveness";
import {
  type EndRecord,
  type OutputRecord,
  outputRecordSchema,
  RunOutput as PortableRunOutput,
  RunOutputError,
  type RunOutputOptions,
  type RunOutputSink,
} from "~/lib/runs/output";

export type { OutputRecord, RunOutputOptions } from "~/lib/runs/output";

export type RunHolding =
  | { readonly kind: "held" }
  | { readonly kind: "lost" }
  | { readonly kind: "settled"; readonly end: EndRecord };

export type RunHolder = (workspace: string) => Promise<RunHolding>;

const POLL_MS = 100;
const HANDOVER_POLL_MS = 1000;
const START_RECORD_WAIT_MS = 2000;
const RUN_ID = /^[a-zA-Z0-9_-]+$/;

function outputPath(workspaceState: string, runId: string): string {
  if (!RUN_ID.test(runId)) {
    throw new RunOutputError("invalid run ID");
  }
  return join(workspaceState, "output", `${runId}.jsonl`);
}

function removeRunOutput(state: string, runId: string): void {
  rmSync(outputPath(state, runId), { force: true });
}

export class FileRunOutputSink implements RunOutputSink {
  readonly #state: string;
  #ensured: boolean;

  constructor(state: string) {
    this.#state = state;
    this.#ensured = false;
  }

  append(runId: string, record: OutputRecord): void {
    const path = outputPath(this.#state, runId);
    if (!this.#ensured) {
      mkdirSync(join(this.#state, "output"), { recursive: true });
      this.#ensured = true;
    }
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  }

  remove(runId: string): void {
    removeRunOutput(this.#state, runId);
  }
}

export class RunOutput extends PortableRunOutput {
  constructor(
    state: string | undefined,
    runId: string,
    name: string,
    warn: (line: string) => void,
    options?: RunOutputOptions
  ) {
    if (options?.sink !== undefined || state === undefined) {
      super(state, runId, name, warn, options);
      return;
    }
    outputPath(state, runId);
    super(state, runId, name, warn, {
      liveness: options?.liveness ?? NODE_OWNER_LIVENESS,
      sink: new FileRunOutputSink(state),
    });
  }
}

export function hasRunOutput(state: string, runId: string): boolean {
  outputPath(state, runId);
  return (
    existsSync(state) &&
    readdirSync(state, { withFileTypes: true }).some(
      (entry) =>
        entry.isDirectory() &&
        existsSync(outputPath(join(state, entry.name), runId))
    )
  );
}

function findOutput(
  state: string,
  runId: string
): { readonly path: string; readonly workspace: string } {
  outputPath(state, runId);
  const paths = existsSync(state)
    ? readdirSync(state, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          path: outputPath(join(state, entry.name), runId),
          workspace: entry.name,
        }))
        .filter(({ path }) => existsSync(path))
    : [];
  const [found] = paths;
  if (paths.length !== 1 || found === undefined) {
    throw new RunOutputError(
      paths.length === 0
        ? `no saved output for run "${runId}" under ${state}`
        : `run "${runId}" has output in more than one workspace`
    );
  }
  return found;
}

class OutputReader {
  readonly #runId: string;
  #pending = "";
  #owner: ProcessIdentity | undefined;

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
        this.#owner = { pid: record.pid, started: record.started ?? null };
      }
      yield record;
      end = this.#pending.indexOf("\n");
    }
  }

  get owner(): ProcessIdentity | undefined {
    return this.#owner;
  }
}

interface Following {
  exited: ProcessIdentity | undefined;
  readonly holder: RunHolder | undefined;
  readonly isOwnerGone: (owner: ProcessIdentity) => boolean;
  readonly opened: number;
  readonly reader: OutputReader;
  readonly runId: string;
  stored: EndRecord | undefined;
  readonly workspace: string;
}

type Idle = { readonly end: EndRecord } | { readonly wait: number };

async function idle(following: Following): Promise<Idle> {
  const { reader, runId, stored } = following;
  if (stored !== undefined) {
    return { end: stored };
  }
  const { owner } = reader;
  if (owner === undefined) {
    if (performance.now() - following.opened >= START_RECORD_WAIT_MS) {
      throw new RunOutputError(
        `run "${runId}" has no readable start record in its output`
      );
    }
    return { wait: POLL_MS };
  }
  if (following.exited === owner) {
    const holding = (await following.holder?.(following.workspace)) ?? {
      kind: "lost",
    };
    if (holding.kind === "settled") {
      following.stored = holding.end;
      return { wait: 0 };
    }
    if (holding.kind === "lost") {
      throw new RunOutputError(
        `run "${runId}" lost its owner before recording completion`
      );
    }
    following.exited = undefined;
    return { wait: HANDOVER_POLL_MS };
  }
  if (following.isOwnerGone(owner)) {
    following.exited = owner;
    return { wait: 0 };
  }
  return { wait: POLL_MS };
}

export async function* readRunOutput(
  state: string,
  runId: string,
  signal?: AbortSignal,
  holder?: RunHolder,
  isOwnerGone: (owner: ProcessIdentity) => boolean = isGone
): AsyncGenerator<OutputRecord> {
  let fd: number | undefined;
  try {
    const { path, workspace } = findOutput(state, runId);
    fd = openSync(path, "r");
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.alloc(65_536);
    let position = 0;
    const reader = new OutputReader(runId);
    const following: Following = {
      exited: undefined,
      holder,
      isOwnerGone,
      opened: performance.now(),
      reader,
      runId,
      stored: undefined,
      workspace,
    };
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
      const next = await idle(following);
      if ("end" in next) {
        yield next.end;
        return;
      }
      if (next.wait > 0) {
        await setTimeout(next.wait, undefined, { signal });
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

async function nextChunk(
  records: AsyncGenerator<OutputRecord>
): Promise<ChannelMessage | undefined> {
  for (;;) {
    const next = await records.next();
    if (next.done) {
      return;
    }
    const record = next.value;
    if (record.type === "text" && record.chunk !== undefined) {
      return {
        _tag: "chunk",
        chunk: {
          ...record.chunk,
          payload: { kind: "text", text: record.text },
        },
      };
    }
  }
}

export function runOutputStream(
  state: string,
  runId: string,
  signal?: AbortSignal
): ReadableStream<ChannelMessage> {
  const reading = new AbortController();
  const records = readRunOutput(
    state,
    runId,
    signal ? AbortSignal.any([signal, reading.signal]) : reading.signal
  );
  let cancelled = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    signal?.removeEventListener("abort", abort);
    reading.abort();
    closing ??= records.return(undefined).then(() => undefined);
    return closing;
  };
  const abort = (): void => {
    close().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) {
    abort();
  }
  return new ReadableStream<ChannelMessage>({
    cancel() {
      cancelled = true;
      return close();
    },
    async pull(controller) {
      const message = await nextChunk(records).catch(() => undefined);
      if (cancelled) {
        return;
      }
      if (message === undefined) {
        signal?.removeEventListener("abort", abort);
        controller.close();
        return;
      }
      controller.enqueue(message);
    },
  });
}
