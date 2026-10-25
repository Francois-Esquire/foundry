import { StringDecoder } from "node:string_decoder";
import type {
  Container,
  Containers,
} from "@foundry/sandbox/container/containers";
import { createContainers } from "@foundry/sandbox/container/containers";
import { createMicrosandboxRuntime } from "@foundry/sandbox/container/microsandbox-runtime";
import { createMemoryContainerStore } from "@foundry/sandbox/container/store";
import { prepareSandboxProcess } from "@foundry/sandbox/process";
import { beforeAll, describe, expect, it } from "vitest";
import { prepareGuest } from "~/lib/sandbox/prepare";

describe("pinned native CLI control protocols in MicroSandbox", () => {
  let containers: Containers;
  let container: Container;

  beforeAll(async () => {
    const runtime = createMicrosandboxRuntime();
    if (!(await runtime.isInstalled())) {
      throw new Error(
        "MicroSandbox must be installed for native CLI integration tests."
      );
    }
    containers = createContainers({
      allowedMountRoots: [],
      instanceLabel: `native-cli-${crypto.randomUUID()}`,
      runtime,
      store: createMemoryContainerStore(),
    });
    container = await containers.start({
      format: "foundry.sandbox.container/1",
      image: "docker.io/oven/bun:1-slim",
      network: "disabled",
      workdir: "/",
    });
    const prepared = await container.commands.exec([
      "mkdir",
      "-p",
      "/workspace",
    ]);
    expect(prepared.exitCode).toBe(0);
    return () => containers.shutdown();
  });

  it("installs the standalone Pi binary and answers a state request without inference", async () => {
    const abort = new AbortController();
    const guest = await prepareGuest(container, {
      auth: { apiKey: "offline", kind: "apiKey" },
      harness: "pi",
      sessionId: "offline-pi",
      signal: abort.signal,
    });
    const child = prepareSandboxProcess(() =>
      container.processes.spawn(
        [
          guest.executable,
          "--mode",
          "rpc",
          "--no-session",
          "--no-tools",
          "--no-extensions",
          "--no-mcp",
        ],
        {
          cwd: "/workspace",
          environment: { ...guest.environment, PI_OFFLINE: "1" },
          signal: abort.signal,
        }
      )
    );
    child.stderr.on("data", () => undefined);
    try {
      const state = nextJson(
        child.stdout,
        (message) => message.id === "state-1"
      );
      child.stdin.write(
        `${JSON.stringify({ id: "state-1", type: "get_state" })}\n`
      );
      const result = await state;
      expect(result.success).toBe(true);
      expect(typeof record(result.data).sessionId).toBe("string");
    } finally {
      child.kill("SIGTERM");
      abort.abort();
    }
  });

  it("installs SDK-matched Claude and completes its control handshake without a model turn", async () => {
    const abort = new AbortController();
    // The handshake makes no model turn, so the key is never checked.
    const guest = await prepareGuest(container, {
      auth: { apiKey: "offline", kind: "apiKey" },
      harness: "claude-code",
      sessionId: "offline-claude",
      signal: abort.signal,
    });
    const version = await container.commands.exec([
      guest.executable,
      "--version",
    ]);
    expect(version.stdout).toContain("2.1.205");
    const child = prepareSandboxProcess(() =>
      container.processes.spawn(
        [
          guest.executable,
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--verbose",
          "--permission-mode",
          "dontAsk",
          "--setting-sources",
          "",
        ],
        {
          cwd: "/workspace",
          environment: guest.environment,
          signal: abort.signal,
        }
      )
    );
    child.stderr.on("data", () => undefined);
    const response = nextJson(
      child.stdout,
      (message) =>
        message.type === "control_response" &&
        record(message.response).request_id === "init-1"
    );
    child.stdin.write(
      `${JSON.stringify({ request: { hooks: {}, mcpServers: {}, subtype: "initialize" }, request_id: "init-1", type: "control_request" })}\n`
    );
    try {
      const initialized = await response;
      expect(record(initialized.response).subtype).toBe("success");
    } finally {
      child.kill("SIGTERM");
      abort.abort();
    }
  });

  it("installs pinned Codex and initializes a native thread without sending inference input", async () => {
    const abort = new AbortController();
    // Subscription tokens go to the app-server, not the guest environment.
    const guest = await prepareGuest(container, {
      auth: {
        kind: "chatgpt",
        tokens: { accessToken: "offline", chatgptAccountId: "offline" },
      },
      harness: "codex",
      sessionId: "offline-codex",
      signal: abort.signal,
    });
    const version = await container.commands.exec([
      guest.executable,
      "--version",
    ]);
    expect(version.stdout).toContain("0.144.6");
    const child = prepareSandboxProcess(() =>
      container.processes.spawn([guest.executable, "app-server"], {
        cwd: "/workspace",
        environment: guest.environment,
        signal: abort.signal,
      })
    );
    child.stderr.on("data", () => undefined);
    try {
      const initialization = nextJson(
        child.stdout,
        (message) => message.id === 1
      );
      child.stdin.write(
        `${JSON.stringify({ id: 1, method: "initialize", params: { capabilities: { experimentalApi: true }, clientInfo: { name: "foundry-test", version: "0.1.0" } } })}\n`
      );
      expect((await initialization).error).toBeUndefined();
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
      const thread = nextJson(child.stdout, (message) => message.id === 2);
      child.stdin.write(
        `${JSON.stringify({ id: 2, method: "thread/start", params: { approvalPolicy: "untrusted", approvalsReviewer: "user", cwd: "/workspace", developerInstructions: "Offline handshake test", dynamicTools: [{ description: "Host callback probe", inputSchema: { additionalProperties: false, properties: {}, type: "object" }, name: "host_probe", type: "function" }], sandbox: "read-only" } })}\n`
      );
      const started = await thread;
      expect(started.error).toBeUndefined();
      expect(typeof record(record(started.result).thread).id).toBe("string");
      const command = nextJson(child.stdout, (message) => message.id === 3);
      child.stdin.write(
        `${JSON.stringify({ id: 3, method: "command/exec", params: { command: ["sh", "-c", "printf native-command-ok"], cwd: "/workspace", sandboxPolicy: { type: "readOnly" }, timeoutMs: 5000 } })}\n`
      );
      const executed = await command;
      expect(executed.error).toBeUndefined();
      expect(record(executed.result)).toMatchObject({
        exitCode: 0,
        stdout: "native-command-ok",
      });
      const refused = nextJson(child.stdout, (message) => message.id === 4);
      child.stdin.write(
        `${JSON.stringify({ id: 4, method: "command/exec", params: { command: ["sh", "-c", "printf blocked > /workspace/read-only-refusal"], cwd: "/workspace", sandboxPolicy: { type: "readOnly" }, timeoutMs: 5000 } })}\n`
      );
      const denied = await refused;
      expect(denied.error).toBeUndefined();
      expect(record(denied.result).exitCode).not.toBe(0);
      const absent = await container.commands.exec([
        "test",
        "-e",
        "/workspace/read-only-refusal",
      ]);
      expect(absent.exitCode).not.toBe(0);
    } finally {
      child.kill("SIGTERM");
      abort.abort();
    }
  });
});

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function nextJson(
  stream: NodeJS.ReadableStream,
  matches: (message: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    const cleanup = () => {
      clearTimeout(timeout);
      stream.removeListener("data", receive);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Native CLI handshake timed out."));
    }, 30_000);
    const receive = (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) {
          return;
        }
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = record(JSON.parse(line));
          if (matches(message)) {
            cleanup();
            resolve(message);
            return;
          }
        } catch {
          cleanup();
          reject(new Error("Native CLI emitted invalid JSON."));
          return;
        }
      }
    };
    stream.on("data", receive);
  });
}
