import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { recordSpawned, SPAWN_RECORD_ENV } from "~/process/spawned";

const responseSchema = z.looseObject({
  error: z.unknown().optional(),
  id: z.number(),
  jsonrpc: z.literal("2.0"),
  result: z.unknown().optional(),
});

/**
 * A JSON-RPC client over a spawned MCP server's stdio that keeps every byte
 * the server wrote, so a test can check that its stdout holds protocol
 * frames and nothing else. The SDK's client skips a line it cannot parse.
 */
export interface RawMcpSession {
  /** End stdin and wait for the server to exit. */
  close(): Promise<Ended>;
  /** Wait for the server to exit, leaving stdin open. */
  ended(): Promise<Ended>;
  notify(method: string, params?: unknown): void;
  readonly pid: number;
  request(method: string, params?: unknown): Promise<unknown>;
  readonly stderr: () => string;
}

interface Ended {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

/**
 * The SDK's transport, recording the server it starts where the server's
 * environment says Marbles records what it starts (else this process's),
 * so a test's teardown or the next run can stop it.
 */
export class RecordedStdioTransport extends StdioClientTransport {
  readonly #env: Readonly<Record<string, string | undefined>>;

  constructor(params: StdioServerParameters) {
    super(params);
    this.#env = params.env?.[SPAWN_RECORD_ENV] ? params.env : process.env;
  }

  override start(): Promise<void> {
    // The SDK spawns before its first await: the pid is there already.
    const started = super.start();
    recordSpawned(this.pid ?? undefined, false, this.#env);
    return started;
  }
}

/**
 * Start `command` and complete the MCP `initialize` handshake. Vitest's own
 * marker is dropped from the child's environment: a library that sees it
 * behaves as under test, and would hide what it writes to stdout.
 */
export async function rawMcpSession(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv }
): Promise<RawMcpSession> {
  const { VITEST: _vitest, ...inherited } = options.env ?? process.env;
  // A process group of its own, so a teardown reaches all it starts.
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: true,
    env: inherited,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const { pid } = child;
  if (pid === undefined) {
    throw new Error(`could not start ${command}`);
  }
  // Where its environment says Marbles records what it starts.
  recordSpawned(pid, true, inherited);
  let stdout = "";
  let stderr = "";
  let buffered = "";
  const waiting = new Map<number, (value: unknown) => void>();
  const exited = new Promise<number | null>((settle) => {
    child.once("exit", (code) => settle(code));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stdout += text;
    buffered += text;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const parsed = responseSchema.safeParse(safeJson(line));
      if (parsed.success) {
        waiting.get(parsed.data.id)?.(parsed.data);
        waiting.delete(parsed.data.id);
      }
    }
  });
  let next = 0;
  const write = (message: object): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const session: RawMcpSession = {
    close() {
      child.stdin.end();
      return session.ended();
    },
    async ended() {
      const code = await exited;
      return { code, stderr, stdout };
    },
    notify(method, params = {}) {
      write({ method, params });
    },
    pid,
    request(method, params = {}) {
      next += 1;
      const id = next;
      const answered = new Promise<unknown>((settle) => {
        waiting.set(id, settle);
      });
      write({ id, method, params });
      return Promise.race([
        answered,
        exited.then((code) => {
          throw new Error(
            `the server exited with ${String(code)} before answering ${method}:\n${stderr}`
          );
        }),
      ]);
    },
    stderr: () => stderr,
  };
  await session.request("initialize", {
    capabilities: {},
    clientInfo: { name: "marbles-raw", version: "1.0.0" },
    protocolVersion: "2025-06-18",
  });
  session.notify("notifications/initialized");
  return session;
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** Every stdout line that is not a JSON-RPC 2.0 message. */
export function strayLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => {
    if (line === "") {
      return false;
    }
    const value = safeJson(line);
    return !(
      typeof value === "object" &&
      value !== null &&
      "jsonrpc" in value &&
      value.jsonrpc === "2.0"
    );
  });
}

/**
 * Run `body` at the start of the `marbles mcp` server process, never in its
 * relay, by writing it as a Bun preload under `dir`. The server loads no
 * source, so this is how a test makes it print or misbehave on purpose.
 * Resolves `env` with the preload added, to start `marbles mcp` with.
 */
export async function serverPreload(
  dir: string,
  body: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<NodeJS.ProcessEnv> {
  const preload = join(dir, "server-preload.ts");
  await writeFile(
    preload,
    `if (process.env.MARBLES_MCP_SERVER !== undefined) {\n${body}\n}\n`
  );
  return { ...env, BUN_OPTIONS: `--preload ${preload}` };
}
