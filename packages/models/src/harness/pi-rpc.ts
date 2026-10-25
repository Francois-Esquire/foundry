import { StringDecoder } from "node:string_decoder";
import type { CliProcess } from "./app-server";
import { record } from "./shared";

/** Pi uses typed JSONL records, rather than JSON-RPC method envelopes. */
export class PiRpc {
  private readonly pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
      command: string;
    }
  >();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private stopped = false as boolean;
  private delivery: Promise<void> = Promise.resolve();
  private readonly abort: () => void;

  private readonly child: CliProcess;
  private readonly signal: AbortSignal;
  private readonly onClose: (error: Error) => void;

  constructor(
    child: CliProcess,
    signal: AbortSignal,
    receive: (event: Record<string, unknown>) => Promise<void>,
    onClose: (error: Error) => void
  ) {
    this.child = child;
    this.signal = signal;
    this.onClose = onClose;
    this.abort = () => this.close();
    signal.addEventListener("abort", this.abort, { once: true });
    child.stderr?.resume();
    child.stdin.on("error", () => this.fail(new Error("Pi input failed.")));
    child.stdout.on("error", () => this.fail(new Error("Pi output failed.")));
    child.on("error", () =>
      this.fail(new Error("Pi process failed to start."))
    );
    child.on("exit", () => this.fail(new Error("Pi process exited.")));
    child.stdout.on("data", (chunk: Buffer | string) => {
      this.buffer +=
        typeof chunk === "string" ? chunk : this.decoder.write(chunk);
      for (;;) {
        const end = this.buffer.indexOf("\n");
        if (end < 0) {
          break;
        }
        const line = this.buffer.slice(0, end).trim();
        this.buffer = this.buffer.slice(end + 1);
        if (!line) {
          continue;
        }
        try {
          const event = record(JSON.parse(line));
          if (typeof event.type !== "string") {
            throw new Error("Invalid Pi record.");
          }
          if (event.type === "response") {
            this.respond(event);
          } else {
            this.delivery = this.delivery.then(() => receive(event));
            this.delivery.catch(() =>
              this.fail(new Error("Pi event handling failed."))
            );
          }
        } catch {
          this.fail(new Error("Pi returned an invalid protocol record."));
        }
      }
      if (this.buffer.length > 16 * 1024 * 1024) {
        this.fail(new Error("Pi protocol record exceeded the size limit."));
      }
    });
    if (signal.aborted) {
      this.close();
    }
  }

  private respond(event: Record<string, unknown>): void {
    const id = String(event.id);
    const waiting = this.pending.get(id);
    if (!waiting) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(waiting.timer);
    if (event.success === true) {
      waiting.resolve(event.data);
    } else {
      waiting.reject(
        new Error(
          `Pi command ${waiting.command} failed; diagnostics are withheld.`
        )
      );
    }
  }

  request(type: string, data: Record<string, unknown> = {}): Promise<unknown> {
    if (this.stopped) {
      return Promise.reject(new Error("Pi connection is closed."));
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error(`Pi command ${type} timed out.`)),
        30_000
      );
      this.pending.set(id, { command: type, reject, resolve, timer });
      this.send({ ...data, id, type }).catch(() =>
        this.fail(new Error("Pi input failed."))
      );
    });
  }

  send(value: Record<string, unknown>): Promise<void> {
    if (this.stopped) {
      return Promise.reject(new Error("Pi connection is closed."));
    }
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(value)}\n`, (error) =>
        error ? reject(error) : resolve()
      );
    });
  }

  private fail(error: Error): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.signal.removeEventListener("abort", this.abort);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.child.kill("SIGTERM");
    this.onClose(error);
  }

  close(): void {
    this.fail(new Error("Pi connection closed."));
  }
}
