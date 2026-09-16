import { watch } from "node:fs";

import watcher from "@parcel/watcher";

import type { Engine } from "~/engine";
import type { Schedule } from "~/lib/registry";
import type { MonitorInput, MonitorSpec, WsMonitor } from "~/monitor";
import type { LoopOptions } from "~/schedule";

import { tick } from "~/schedule";

/**
 * Live mode under `run`: a files monitor reacts to a native watcher and a ws
 * monitor to its socket, both by dispatching the same tick the poll loop
 * would. Nothing new in the engine; `once` and launchd keep polling.
 */

const DEBOUNCE_MS = 250;
const RECONNECT_MS = 5000;
const SKIP = /(^|\/)(node_modules|\.git)(\/|$)/;

export interface Watcher {
  /** Which backend took: parcel, or `fs.watch` when the native stream would not start. */
  readonly ready: Promise<"parcel" | "fs.watch">;
  readonly stop: () => void;
}

/** Recursive over `root`, skipping `node_modules/` and `.git/`; events coalesce for 250ms. */
export function watchFiles(
  root: string,
  onEvent: () => void,
  onError: (error: unknown) => void
): Watcher {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let close: (() => void) | undefined;
  const bump = () => {
    if (stopped) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(onEvent, DEBOUNCE_MS);
  };

  const ready = watcher
    .subscribe(
      root,
      (error, events) => {
        if (error) {
          onError(error);
        } else if (events.length > 0) {
          bump();
        }
      },
      { ignore: ["**/node_modules/**", "**/.git/**"] }
    )
    .then((subscription): "parcel" => {
      close = () => {
        void subscription.unsubscribe();
      };
      if (stopped) {
        close();
      }
      return "parcel";
    })
    .catch((): "fs.watch" => {
      const handle = watch(root, { recursive: true }, (_, filename) => {
        if (!SKIP.test(filename ?? "")) {
          bump();
        }
      });
      handle.on("error", onError);
      close = () => {
        handle.close();
      };
      if (stopped) {
        close();
      }
      return "fs.watch";
    });

  return {
    ready,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      close?.();
    },
  };
}

/** What `attachSocket` needs of a WebSocket; a test hands in a fake. */
export interface Socket {
  addEventListener(
    type: "open" | "message" | "close",
    listener: (event: { readonly data?: unknown }) => void
  ): void;
  close(): void;
  send(data: string): void;
}

/** JSON when it parses, else the text, then `select`. */
export function readMessage(spec: WsMonitor, data: unknown): unknown {
  const text = typeof data === "string" ? data : String(data);
  let message: unknown = text;
  try {
    message = JSON.parse(text);
  } catch {
    // Not JSON; the text is the message.
  }
  return spec.select ? spec.select(message) : message;
}

export function attachSocket(
  socket: Socket,
  spec: WsMonitor,
  on: {
    readonly message: (message: unknown) => void;
    readonly close: () => void;
  }
): void {
  socket.addEventListener("open", () => {
    if (spec.send !== undefined) {
      socket.send(spec.send);
    }
  });
  socket.addEventListener("message", (event) => {
    on.message(readMessage(spec, event.data));
  });
  socket.addEventListener("close", on.close);
}

export interface LiveMonitor {
  readonly schedule: Schedule;
  readonly spec: MonitorSpec;
}

export interface LiveOptions extends LoopOptions {
  /** What a files monitor without `root` watches. */
  readonly root: string;
}

/**
 * Watchers and sockets for every files and ws monitor, open until the signal
 * aborts. Each event is one `tick`, so the lock and history apply; a monitor
 * whose tick is still running drops the event and lets the next poll catch up.
 */
export function runLive(
  engine: Engine,
  monitors: readonly LiveMonitor[],
  options: LiveOptions
): Promise<void> {
  const { print, signal } = options;
  const busy = new Set<string>();
  const closers: (() => void)[] = [];

  async function fire(schedule: Schedule, input: MonitorInput) {
    if (busy.has(schedule.name)) {
      return;
    }
    busy.add(schedule.name);
    try {
      await tick(engine, { ...schedule, input }, options);
    } catch (error) {
      print(`[monitor] ${schedule.name} failed: ${String(error)}`);
    } finally {
      busy.delete(schedule.name);
    }
  }

  function connect(schedule: Schedule, spec: WsMonitor) {
    const { name } = schedule;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket;
    closers.push(() => {
      clearTimeout(retry);
      socket.close();
    });
    const open = () => {
      socket = new WebSocket(spec.url, {
        headers: spec.headers,
        protocols: spec.protocols,
      });
      socket.addEventListener("open", () => {
        print(`[monitor] ${name} connected`);
      });
      attachSocket(socket, spec, {
        close: () => {
          if (signal.aborted) {
            return;
          }
          print(`[monitor] ${name} disconnected, retrying in 5s`);
          retry = setTimeout(open, RECONNECT_MS);
        },
        message: (message) => void fire(schedule, { message }),
      });
    };
    open();
  }

  for (const { schedule, spec } of monitors) {
    const { name } = schedule;
    if (spec.kind === "files") {
      const root = spec.root ?? options.root;
      const failed = (error: unknown) => {
        print(`[monitor] ${name} watcher failed: ${String(error)}`);
      };
      const watching = watchFiles(
        root,
        () => void fire(schedule, null),
        failed
      );
      closers.push(watching.stop);
      void watching.ready.then((backend) => {
        print(
          `[monitor] ${name} watching ${root}${backend === "parcel" ? "" : " (fs.watch)"}`
        );
      }, failed);
    } else if (spec.kind === "ws") {
      connect(schedule, spec);
    }
  }

  return new Promise((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        for (const close of closers) {
          close();
        }
        resolve();
      },
      { once: true }
    );
  });
}
