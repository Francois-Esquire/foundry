import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { HarnessTurnDriver } from "@foundry/agents/harness";

type Run = Parameters<HarnessTurnDriver["run"]>[0];

export function runOptions(patch: Partial<Run> = {}): Run {
  return {
    input: "new input only",
    onActivity: async () => undefined,
    onSessionId: async () => undefined,
    onToolEvent: async () => undefined,
    permission: async () => ({ behavior: "deny", message: "Needs approval" }),
    profile: {
      allowedTools: ["Read"],
      disallowedTools: ["Bash(git push*)"],
      maxSteps: 4,
      mode: "scheduled",
      unresolved: "deny",
    },
    question: async () => ({
      outcome: "declined",
      reason: "No attended question handler",
    }),
    sessionId: "session-1",
    signal: new AbortController().signal,
    ...patch,
  };
}

export class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly resumeResponses = new Map<string, Record<string, unknown>>();
  readonly messages: Record<string, unknown>[] = [];
  killed = false;
  private buffer = "";

  constructor() {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        const message = JSON.parse(line) as Record<string, unknown>;
        this.messages.push(message);
        if (message.method === "initialize") {
          this.send({ id: message.id, result: {} });
        }
        if (message.method === "account/login/start") {
          this.send({ id: message.id, result: {} });
        }
        if (
          message.method === "thread/start" ||
          message.method === "thread/resume"
        ) {
          const result = this.threadResult(message);
          this.send({ id: message.id, result });
        }
        if (message.method === "turn/start") {
          this.send({
            id: message.id,
            result: { turn: { id: "turn-1", status: "inProgress" } },
          });
        }
        if (
          message.method === "turn/interrupt" ||
          message.method === "turn/steer"
        ) {
          this.send({ id: message.id, result: {} });
        }
      }
    });
  }
  private threadResult(message: Record<string, unknown>) {
    const params = message.params as Record<string, unknown>;
    return (
      this.resumeResponses.get(String(params.threadId)) ?? {
        thread: { id: "thread-1" },
      }
    );
  }
  send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

export async function collect(
  source: AsyncIterable<unknown>
): Promise<unknown[]> {
  const result: unknown[] = [];
  for await (const value of source) {
    result.push(value);
  }
  return result;
}
