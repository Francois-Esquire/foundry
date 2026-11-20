import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

export const tempHome = (): Promise<string> =>
  mkdtemp(join(tmpdir(), "usage-test-"));

export const writeJsonl = async (
  path: string,
  lines: readonly unknown[],
  mtime?: Date
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`
  );
  if (mtime) {
    await utimes(path, mtime, mtime);
  }
};

export const touch = async (path: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "");
};

export class FakeCodex extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly methods: string[] = [];
  killed = false;
  private buffer = "";

  constructor(results: Readonly<Record<string, unknown>>) {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        const { id, method } = JSON.parse(line) as {
          id?: number;
          method: string;
        };
        this.methods.push(method);
        const result = method === "initialize" ? {} : results[method];
        if (
          id === undefined ||
          !(method === "initialize" || method in results)
        ) {
          continue;
        }
        this.stdout.write(
          `${JSON.stringify(result instanceof Error ? { error: { message: result.message }, id } : { id, result })}\n`
        );
      }
    });
  }

  kill(): boolean {
    this.killed = true;
    this.emit("exit");
    return true;
  }
}
