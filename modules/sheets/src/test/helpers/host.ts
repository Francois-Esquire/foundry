import type { SaveAnswer, WatchEvent } from "../../draft";
import type {
  OpenWorkbook,
  WorkbookHost,
  WorkbookWatchUpdate,
} from "../../editor/host";
import { workbooks } from "./workbooks";

export function workbookFile(cells: Record<string, string>): string {
  const workbook = workbooks.create();
  for (const [cell, contents] of Object.entries(cells)) {
    workbook.enter({ cell, sheet: "Sheet1" }, contents);
  }
  const file = workbook.toFile();
  workbook.close();
  return file;
}

function deferred() {
  let release: () => void = () => {
    throw new Error("Promise not initialized");
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

type HeldRequest = "answer" | "create" | "read" | "save";

export class FakeHost implements WorkbookHost {
  readonly contentId = "content";
  readonly name = "Budget";
  writable = true;
  text: string;
  digest = "d1";
  reads = 0;
  creates = 0;
  watches = 0;
  readonly saves: { readonly expected: string; readonly text: string }[] = [];
  readonly signals: AbortSignal[] = [];
  #version = 1;
  readonly #held: Record<HeldRequest, (() => Promise<void>)[]> = {
    answer: [],
    create: [],
    read: [],
    save: [],
  };
  readonly #watchers = new Set<(event: WatchEvent) => void>();

  constructor(text = workbookFile({ A1: "1" })) {
    this.text = text;
  }

  hold(request: HeldRequest): () => void {
    const gate = deferred();
    this.#held[request].push(() => gate.promise);
    return gate.release;
  }

  saveElsewhere(text: string): void {
    this.#store(text);
  }

  remove(): void {
    this.#emit({ contentId: null, entry: null, kind: "removed" });
  }

  async read(_binding: string, signal: AbortSignal): Promise<OpenWorkbook> {
    this.reads += 1;
    this.signals.push(signal);
    const answer = {
      base: { contentId: this.contentId, digest: this.digest },
      name: this.name,
      text: this.text,
      writable: this.writable,
    };
    await this.#pass("read", signal);
    return answer;
  }

  async save(
    _binding: string,
    expected: string,
    text: string,
    signal: AbortSignal
  ): Promise<SaveAnswer> {
    this.signals.push(signal);
    await this.#pass("save", signal);
    if (expected !== this.digest) {
      return {
        current: { digest: this.digest, text: this.text },
        kind: "conflict",
      };
    }
    this.saves.push({ expected, text });
    this.#store(text);
    const { digest } = this;
    await this.#pass("answer", signal);
    return { digest, kind: "saved" };
  }

  async create(text: string, signal: AbortSignal): Promise<string> {
    this.creates += 1;
    this.signals.push(signal);
    await this.#pass("create", signal);
    this.#store(text);
    return `created-${String(this.creates)}`;
  }

  async *watch(
    _binding: string,
    _after: unknown,
    signal: AbortSignal
  ): AsyncIterable<WorkbookWatchUpdate> {
    this.watches += 1;
    const queue: WatchEvent[] = [this.#event("snapshot")];
    let wake: () => void = () => undefined;
    const push = (event: WatchEvent) => {
      queue.push(event);
      wake();
    };
    const stop = () => wake();
    this.#watchers.add(push);
    signal.addEventListener("abort", stop, { once: true });
    try {
      while (!signal.aborted) {
        const event = queue.shift();
        if (event) {
          yield event;
        } else {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      }
    } finally {
      this.#watchers.delete(push);
      signal.removeEventListener("abort", stop);
    }
  }

  #store(text: string): void {
    this.text = text;
    this.#version += 1;
    this.digest = `d${String(this.#version)}`;
    this.#emit(this.#event("change"));
  }

  #event(kind: "change" | "snapshot"): WatchEvent {
    return { contentId: this.contentId, entry: { digest: this.digest }, kind };
  }

  #emit(event: WatchEvent): void {
    for (const watcher of this.#watchers) {
      watcher(event);
    }
  }

  async #pass(request: HeldRequest, signal: AbortSignal): Promise<void> {
    await this.#held[request].shift()?.();
    signal.throwIfAborted();
  }
}
