import type { Readable, Writable } from "node:stream";
import { record } from "./shared";

export interface CliProcess {
  kill(signal: NodeJS.Signals): boolean;
  on(
    event: "exit",
    listener: (code: number | null, signal: string | null) => void
  ): void;
  on(event: "error", listener: (error: Error) => void): void;
  stderr?: Readable;
  stdin: Writable;
  stdout: Readable;
}

/** One JSON-RPC connection. Requests are rejected when the guest exits or is canceled. */
export class AppServerConnection {
  private readonly pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  private nextId = 1;
  private buffer = "";
  private stopped: boolean;
  private readonly abort: () => void;

  private readonly child: CliProcess;
  private readonly signal: AbortSignal;
  private readonly receive: (
    method: string,
    params: Record<string, unknown>,
    id?: string | number
  ) => Promise<void>;
  private readonly onClose: (error: Error) => void;
  private delivery: Promise<void> = Promise.resolve();

  constructor(
    child: CliProcess,
    signal: AbortSignal,
    receive: (
      method: string,
      params: Record<string, unknown>,
      id?: string | number
    ) => Promise<void>,
    onClose: (error: Error) => void = () => undefined
  ) {
    this.child = child;
    this.stopped = false;
    this.signal = signal;
    this.receive = receive;
    this.onClose = onClose;
    this.abort = () => this.close(new Error("Codex process canceled."));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stdin.on("error", () =>
      this.close(new Error("Codex stdin transport failed."))
    );
    child.stdout.on("error", () =>
      this.close(new Error("Codex stdout transport failed."))
    );
    child.stderr?.resume();
    child.on("exit", () => this.close(new Error("Codex app-server exited.")));
    child.on("error", () =>
      this.close(new Error("Codex app-server transport failed."))
    );
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) {
      this.abort();
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.stopped) {
      return Promise.reject(
        new Error("Codex app-server connection is closed.")
      );
    }
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
    });
    this.write({ id, method, params });
    return promise;
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }
  respond(id: string | number, result: unknown): void {
    this.write({ id, result });
  }
  reject(id: string | number): void {
    this.write({
      error: { code: -32_601, message: "Unsupported host request" },
      id,
    });
  }

  respondError(id: string | number, message: string): void {
    this.write({ error: { code: -32_000, message }, id });
  }

  close(error = new Error("Codex connection closed.")): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.signal.removeEventListener("abort", this.abort);
    this.child.kill("SIGTERM");
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.onClose(error);
  }

  private write(message: unknown): void {
    if (!this.stopped) {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 8 * 1024 * 1024) {
      this.close(new Error("Codex protocol frame exceeded 8 MiB."));
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) {
        try {
          this.deliver(record(JSON.parse(line)));
        } catch {
          this.close(new Error("Codex app-server emitted invalid JSON."));
          return;
        }
      }
      newline = this.buffer.indexOf("\n");
    }
  }
  private deliver(message: Record<string, unknown>): void {
    if (typeof message.method === "string") {
      const { method } = message;
      const id =
        typeof message.id === "string" || typeof message.id === "number"
          ? message.id
          : undefined;
      this.delivery = this.delivery
        .then(() => this.receive(method, record(message.params), id))
        .catch(() => this.close(new Error("Codex host request failed.")));
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (message.error) {
      pending?.reject(new Error("Codex app-server rejected a request."));
    } else {
      pending?.resolve(message.result);
    }
  }
}
