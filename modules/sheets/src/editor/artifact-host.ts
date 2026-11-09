import type { SaveAnswer, SavedBase, WatchEvent } from "../draft";
import { serverSentEvents } from "../events";
import { WorkbookError } from "../workbook/errors";
import { WORKBOOK_MAX_BYTES, WORKBOOK_MIME } from "../workbook/file";
import type { OpenWorkbook, WorkbookHost } from "./host";

/** How the View reaches the Program's Artifact routes. */
export interface ArtifactTransport {
  /** `POST /_module/artifacts`: one relayed request, answered with its output. */
  request(alias: string, input: unknown, signal: AbortSignal): Promise<unknown>;
  /** `GET /_module/artifacts/watch`: the bound entry's event stream. */
  watch(query: URLSearchParams, signal: AbortSignal): Promise<Response>;
}

interface Bound {
  readonly contentId: string;
  readonly entry: { readonly bytes: number; readonly digest: string };
  readonly mode: string;
  readonly name: string;
}

interface Chunk {
  readonly data: string;
  readonly digest: string;
  readonly next: number | null;
}

/** Reads that see the entry change are retried this many times in all. */
const READ_ATTEMPTS = 3;

/** The routes on the View's own origin. */
export const pageTransport: ArtifactTransport = {
  request: relay,
  watch: (query, signal) =>
    fetch(`/_module/artifacts/watch?${query}`, {
      headers: { accept: "text/event-stream" },
      signal,
    }),
};

async function relay(
  alias: string,
  input: unknown,
  signal: AbortSignal
): Promise<unknown> {
  const response = await fetch("/_module/artifacts", {
    body: JSON.stringify({ alias, input }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Artifact request failed (${String(response.status)})`);
  }
  const answer = (await response.json()) as
    | { ok: true; output: unknown }
    | { ok: false; code: string };
  if (!answer.ok) {
    throw new Error(answer.code);
  }
  return answer.output;
}

/**
 * Works' Artifact protocol in the editor's terms: bindings, byte chunks,
 * digests and the watch stream stay here.
 *
 * A read returns one consistent version: every chunk must carry the digest
 * the binding reported, or the read starts over, at most three times. An
 * entry larger than a workbook file may be is refused before it is read.
 */
export class ArtifactWorkbookHost implements WorkbookHost {
  readonly #transport: ArtifactTransport;

  constructor(transport: ArtifactTransport = pageTransport) {
    this.#transport = transport;
  }

  async read(binding: string, signal: AbortSignal): Promise<OpenWorkbook> {
    for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
      signal.throwIfAborted();
      const bound = (await this.#transport.request(
        "binding",
        { binding, refresh: true },
        signal
      )) as Bound;
      if (bound.entry.bytes > WORKBOOK_MAX_BYTES) {
        throw new WorkbookError("This workbook file is too large", {
          code: "too-large",
        });
      }
      const bytes = await this.#readEntry(binding, bound, signal);
      if (bytes) {
        return {
          base: { contentId: bound.contentId, digest: bound.entry.digest },
          name: bound.name,
          text: new TextDecoder().decode(bytes),
          writable: bound.mode === "write",
        };
      }
    }
    throw new Error("The workbook kept changing while it was read");
  }

  async save(
    binding: string,
    digest: string,
    text: string,
    signal: AbortSignal
  ): Promise<SaveAnswer> {
    try {
      return (await this.#transport.request(
        "save",
        { binding, expectedDigest: digest, request: crypto.randomUUID(), text },
        signal
      )) as SaveAnswer;
    } catch (error) {
      // Sheets' own files always fit a Gateway frame, but a lost save is
      // answered with the version saved elsewhere, which another writer
      // may have made larger than one frame carries.
      if (error instanceof Error && error.message === "capacity-exceeded") {
        throw new Error(
          "Not saved: the host could not send its answer. The version saved elsewhere may be too large for Sheets.",
          { cause: error }
        );
      }
      throw error;
    }
  }

  async create(text: string, signal: AbortSignal): Promise<string> {
    const created = (await this.#transport.request(
      "create",
      {
        content: text,
        mime: WORKBOOK_MIME,
        name: "Untitled workbook",
        path: "untitled.workbook.json",
        request: crypto.randomUUID(),
      },
      signal
    )) as { binding: string };
    return created.binding;
  }

  async *watch(
    binding: string,
    after: SavedBase,
    signal: AbortSignal
  ): AsyncIterable<WatchEvent> {
    let last = after;
    while (!signal.aborted) {
      try {
        const query = new URLSearchParams({
          binding,
          contentId: last.contentId,
          digest: last.digest,
        });
        const response = await this.#transport.watch(query, signal);
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error("Could not watch workbook");
        }
        for await (const event of serverSentEvents<WatchEvent>(
          response,
          signal
        )) {
          if (event.contentId && event.entry) {
            last = { contentId: event.contentId, digest: event.entry.digest };
          }
          yield event;
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        if (!(error instanceof Error)) {
          throw error;
        }
      }
      await reconnect(signal);
    }
  }

  /** The bound entry's bytes, or null when it changed while being read. */
  async #readEntry(
    binding: string,
    bound: Bound,
    signal: AbortSignal
  ): Promise<Uint8Array | null> {
    const bytes = new Uint8Array(bound.entry.bytes);
    let offset = 0;
    for (;;) {
      const chunk = (await this.#transport.request(
        "read",
        { binding, offset },
        signal
      )) as Chunk;
      if (chunk.digest !== bound.entry.digest) {
        return null;
      }
      const data = Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0));
      if (offset + data.length > bytes.length) {
        return null;
      }
      bytes.set(data, offset);
      offset += data.length;
      if (chunk.next === null) {
        return offset === bytes.length ? bytes : null;
      }
      if (chunk.next !== offset) {
        throw new Error("The workbook was read out of order");
      }
    }
  }
}

function reconnect(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, 1000);
    signal.addEventListener("abort", done, { once: true });
  });
}
