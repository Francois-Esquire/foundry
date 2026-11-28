import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

export class FakePi extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
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
        if (message.type !== "extension_ui_response") {
          this.send({
            command: message.type,
            data:
              message.type === "get_state"
                ? { sessionId: "native-1" }
                : { disposition: "started" },
            id: message.id,
            success: true,
            type: "response",
          });
        }
      }
    });
  }
  send(event: unknown) {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }
  kill() {
    this.killed = true;
    return true;
  }
}
