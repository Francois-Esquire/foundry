import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { JSONRPCMessage, MCPTransport } from "@ai-sdk/mcp";

import { validateJSONRPCMessage } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";

import type { McpStdioTransportConfig } from "./types";

/** What a host wants back from a subprocess besides protocol messages. */
export interface StdioTransportHooks {
  /** The subprocess ended. `code` is null when a signal ended it. */
  onExit?: (code: number | null, signal: string | null) => void;
  /** One line of the server's stderr, without the newline. */
  onStderr?: (line: string) => void;
}

/** Builds the transport for a stdio server; the seam a host swaps to run servers elsewhere. */
export type SpawnStdio = (
  config: McpStdioTransportConfig,
  hooks: StdioTransportHooks
) => MCPTransport;

/** The minimum a subprocess needs to find its tools and home. Everything else is the config's `env`. */
const INHERITED_ENV =
  process.platform === "win32"
    ? [
        "APPDATA",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "PATH",
        "PROCESSOR_ARCHITECTURE",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "USERNAME",
        "USERPROFILE",
      ]
    : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

/** How long a server gets to exit on SIGTERM before SIGKILL. */
const CLOSE_GRACE_MS = 2000;

function childEnv(custom: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...custom };
  for (const key of INHERITED_ENV) {
    const value = process.env[key];
    if (value !== undefined && !value.startsWith("()")) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * The SDK's own stdio transport behind the same seam. It cannot read stderr
 * or report the exit code, so the hooks go unused; it exists so the default
 * below is a one-line swap back once the SDK's transport leaves
 * `Experimental_` with those gaps closed.
 */
export const sdkStdioTransport: SpawnStdio = (config) =>
  new Experimental_StdioMCPTransport({
    command: config.command,
    ...(config.args ? { args: config.args } : {}),
    ...(config.cwd ? { cwd: config.cwd } : {}),
    ...(config.env ? { env: config.env } : {}),
    stderr: "ignore",
  });

/**
 * Newline-delimited JSON-RPC over a child process, per the MCP stdio
 * transport. Mirrors {@link sdkStdioTransport} line for line (env allowlist,
 * spawn flags, byte-safe line buffering, backpressure) and adds what it
 * lacks: stderr is read line by line and handed to the host, and the exit
 * code is reported, so a server that crashes says why instead of going quiet.
 */
export const spawnStdioTransport: SpawnStdio = (config, hooks) => {
  let child: ChildProcess | undefined;
  const stdout = lineReader(receive);
  const stderr = lineReader((line) => hooks.onStderr?.(line));

  const transport: MCPTransport = {
    close() {
      const proc = child;
      child = undefined;
      if (proc?.exitCode !== null) {
        return Promise.resolve();
      }
      // Wait on `exit`, not `close`: a grandchild (npx → server) can hold the
      // pipes open long after the child is gone. A server that ignores
      // SIGTERM gets SIGKILL, and either way this never hangs the host.
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve();
        }, CLOSE_GRACE_MS);
        proc.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        proc.stdin?.end();
        proc.kill();
      });
    },

    send(message) {
      const stdin = child?.stdin;
      if (!stdin) {
        return Promise.reject(new Error("stdio transport not started"));
      }
      return new Promise<void>((resolve, reject) => {
        stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
    start() {
      if (child) {
        return Promise.reject(new Error("stdio transport already started"));
      }
      return new Promise<void>((resolve, reject) => {
        const proc = spawn(config.command, config.args ?? [], {
          env: childEnv(config.env),
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          // Electron on Windows would otherwise flash a console window per server.
          windowsHide: process.platform === "win32" && "type" in process,
          ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
        });
        child = proc;
        proc.once("spawn", resolve);
        proc.on("error", (error) => {
          reject(error);
          transport.onerror?.(error);
        });
        proc.on("close", (code, signal) => {
          child = undefined;
          hooks.onExit?.(code, signal);
          transport.onclose?.();
        });
        proc.stdout.on("data", stdout);
        proc.stderr.on("data", stderr);
        for (const stream of [proc.stdin, proc.stdout]) {
          stream.on("error", (error: Error) => {
            transport.onerror?.(error);
          });
        }
      });
    },
  };

  function receive(line: string): void {
    let message: JSONRPCMessage;
    try {
      message = validateJSONRPCMessage(JSON.parse(line));
    } catch (error) {
      transport.onerror?.(
        error instanceof Error ? error : new Error(String(error))
      );
      return;
    }
    transport.onmessage?.(message);
  }

  return transport;
};

/**
 * Feed raw chunks, get complete lines. The decoder holds a UTF-8 sequence
 * split across two chunks instead of emitting replacement characters.
 */
function lineReader(each: (line: string) => void): (chunk: Buffer) => void {
  const decoder = new StringDecoder("utf8");
  let rest = "";
  return (chunk) => {
    rest += decoder.write(chunk);
    let start = 0;
    for (;;) {
      const end = rest.indexOf("\n", start);
      if (end === -1) {
        break;
      }
      const line = rest.slice(start, end).replace(/\r$/u, "");
      if (line.length > 0) {
        each(line);
      }
      start = end + 1;
    }
    rest = rest.slice(start);
  };
}
