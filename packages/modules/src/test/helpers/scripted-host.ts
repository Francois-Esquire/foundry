import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

/**
 * A Gateway host played by a script over a real WebSocket: Bun accepts the
 * socket, prints what it receives as JSON lines and sends what it is told.
 * The host connects to the Program in production; here the Program's SDK
 * dials in, which leaves the frames and the socket lifecycle the same.
 */
const HOST_SCRIPT = `
let socket;
const print = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, server) {
    if (server.upgrade(request)) return;
    return new Response(null, { status: 400 });
  },
  websocket: {
    open(ws) { socket = ws; print({ event: "open" }); },
    message(ws, message) { print({ event: "frame", frame: JSON.parse(String(message)) }); },
    close(ws, code, reason) { print({ event: "close", code, reason }); },
  },
});
print({ event: "listening", port: server.port });
for await (const line of console) {
  const command = JSON.parse(line);
  if (command.send !== undefined) socket.send(JSON.stringify(command.send));
  if (command.close !== undefined) socket.close(...command.close);
}
`;

export interface HostEvent {
  readonly code?: number;
  readonly event: "close" | "frame" | "listening" | "open";
  readonly frame?: Record<string, unknown>;
  readonly port?: number;
}

export interface ScriptedHost extends AsyncDisposable {
  close(code: number, reason: string): void;
  /** The next frame the Program sent. */
  frame(): Promise<Record<string, unknown>>;
  /** The next event the host saw, waiting for it when none is queued. */
  next(): Promise<HostEvent>;
  send(frame: object): void;
  readonly url: string;
}

export async function startScriptedHost(): Promise<ScriptedHost> {
  const child = spawn("bun", ["-e", HOST_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  const queued: HostEvent[] = [];
  const waiting: ((event: HostEvent) => void)[] = [];
  lines.on("line", (line) => {
    const event = JSON.parse(line) as HostEvent;
    const waiter = waiting.shift();
    if (waiter) {
      waiter(event);
    } else {
      queued.push(event);
    }
  });
  const next = (): Promise<HostEvent> => {
    const event = queued.shift();
    if (event) {
      return Promise.resolve(event);
    }
    return new Promise((resolve, reject) => {
      const waiter = (value: HostEvent) => {
        clearTimeout(timer);
        resolve(value);
      };
      // A waiter that gave up leaves the line, so the next event is queued
      // for the next reader instead of going to a rejected promise.
      const timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(waiter), 1);
        reject(new Error("The scripted host saw nothing"));
      }, 5000);
      waiting.push(waiter);
    });
  };
  const command = (value: object) => {
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  const listening = await next();
  if (listening.event !== "listening" || listening.port === undefined) {
    throw new Error("The scripted host did not start");
  }
  return {
    close: (code, reason) => command({ close: [code, reason] }),
    async frame() {
      const event = await next();
      if (event.event !== "frame" || event.frame === undefined) {
        throw new Error(`Expected a frame, got ${JSON.stringify(event)}`);
      }
      return event.frame;
    },
    next,
    send: (frame) => command({ send: frame }),
    async [Symbol.asyncDispose]() {
      lines.close();
      child.kill("SIGKILL");
      await exited;
    },
    url: `ws://127.0.0.1:${listening.port}/_foundry/module-gateway`,
  };
}
