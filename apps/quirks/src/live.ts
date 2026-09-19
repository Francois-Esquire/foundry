import type { Engine } from "~/engine";
import type { Schedule, Workspaces } from "~/lib/registry";
import type { MonitorInput, MonitorSpec, WsMonitor } from "~/monitor";
import type { LoopOptions } from "~/schedule";

import { tick } from "~/schedule";

/**
 * Live mode under `run`: a files monitor reacts to a native watcher and a ws
 * monitor to its socket, both by dispatching the same tick the poll loop
 * would. Nothing new in the engine; `once` and launchd keep polling.
 */

const RECONNECT_MS = 5000;

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
  readonly workspaces: Pick<Workspaces, "add" | "on">;
}

/**
 * Watchers and sockets for every files and ws monitor, open until the signal
 * aborts. File changes during a tick request another tick so their durable
 * checkpoint is evaluated after the running one.
 */
export async function runLive(
  engine: Engine,
  monitors: readonly LiveMonitor[],
  options: LiveOptions
): Promise<void> {
  const { print, signal } = options;
  const busy = new Set<string>();
  const pending = new Set<string>();
  const closers: (() => void)[] = [];

  async function fire(schedule: Schedule, input: MonitorInput) {
    if (signal.aborted) {
      return;
    }
    if (busy.has(schedule.name)) {
      if (input === null) {
        pending.add(schedule.name);
      }
      return;
    }
    busy.add(schedule.name);
    try {
      await tick(engine, { ...schedule, input }, options);
    } catch (error) {
      print(`[monitor] ${schedule.name} failed: ${String(error)}`);
    } finally {
      busy.delete(schedule.name);
      if (pending.delete(schedule.name)) {
        fire(schedule, null);
      }
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
        message: (message) => {
          fire(schedule, { message });
        },
      });
    };
    open();
  }

  if (signal.aborted) {
    return;
  }
  let finish: () => void = () => undefined;
  const aborted = new Promise<void>((resolve) => {
    finish = resolve;
  });
  signal.addEventListener("abort", finish, { once: true });
  try {
    for (const { schedule, spec } of monitors) {
      if (signal.aborted) {
        break;
      }
      if (spec.kind === "files") {
        const root = spec.root ?? options.root;
        try {
          const workspace = await options.workspaces.add({ path: root });
          if (signal.aborted) {
            break;
          }
          closers.push(
            options.workspaces.on("change", ({ entry }) => {
              if (entry.workspaceId === workspace.id) {
                fire(schedule, null);
              }
            })
          );
          // The checkpoint includes changes made before the subscription existed.
          fire(schedule, null);
          print(`[monitor] ${schedule.name} watching ${root}`);
        } catch (error) {
          print(`[monitor] ${schedule.name} watcher failed: ${String(error)}`);
        }
      } else if (spec.kind === "ws") {
        connect(schedule, spec);
      }
    }
    await aborted;
  } finally {
    signal.removeEventListener("abort", finish);
    for (const close of closers) {
      close();
    }
  }
}
