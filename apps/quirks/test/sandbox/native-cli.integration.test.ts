import { createInterface } from "node:readline";
import type {
  Container,
  Containers,
} from "@foundry/sandbox/container/containers";
import { createContainers } from "@foundry/sandbox/container/containers";
import { createMicrosandboxRuntime } from "@foundry/sandbox/container/microsandbox-runtime";
import { createMemoryContainerStore } from "@foundry/sandbox/container/store";
import { prepareSandboxProcess } from "@foundry/sandbox/process";
import { beforeAll, describe, expect, it } from "vitest";
import { prepareGuest } from "~/sandbox/prepare";

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

  it("installs SDK-matched Claude and completes its control handshake without a model turn", async () => {
    const abort = new AbortController();
    const guest = await prepareGuest(container, {
      externalAuthentication: true,
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
    const guest = await prepareGuest(container, {
      externalAuthentication: true,
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
    const lines = createInterface({ input: stream });
    const timeout = setTimeout(() => {
      lines.close();
      reject(new Error("Native CLI handshake timed out."));
    }, 30_000);
    lines.on("line", (line) => {
      try {
        const message = record(JSON.parse(line));
        if (!matches(message)) {
          return;
        }
        clearTimeout(timeout);
        lines.close();
        resolve(message);
      } catch {
        clearTimeout(timeout);
        lines.close();
        reject(new Error("Native CLI emitted invalid JSON."));
      }
    });
  });
}
