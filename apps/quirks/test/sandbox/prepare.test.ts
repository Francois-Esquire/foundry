import { createContainers } from "@foundry/sandbox/container/containers";
import { createMemoryContainerStore } from "@foundry/sandbox/container/store";
import { createFakeContainerRuntime } from "@foundry/sandbox/testing";
import { describe, expect, it, vi } from "vitest";
import { guestArtifact, prepareGuest } from "~/lib/sandbox/prepare";

describe("guest CLI preparation", () => {
  it("pins the SDK paired native binaries for both Linux architectures", () => {
    expect(guestArtifact("claude-code", "aarch64")).toMatchObject({
      packageName: "@anthropic-ai/claude-agent-sdk-linux-arm64",
      version: "0.3.205",
    });
    expect(guestArtifact("codex", "x86_64")).toMatchObject({
      member: "package/vendor/x86_64-unknown-linux-musl/bin/codex",
      version: "0.144.6-linux-x64",
    });
    expect(() => guestArtifact("codex", "unknown")).toThrow(
      "Unsupported guest architecture"
    );
  });

  it("installs before use, isolates writable state, and keeps keys out of persisted configuration", async () => {
    let installed = false;
    const runtime = createFakeContainerRuntime({
      exec: (command) => {
        if (command[0] === "uname") {
          return { exitCode: 0, stderr: "", stdout: "aarch64\n" };
        }
        if (command[0] === "chmod") {
          installed = true;
        }
        if (command[1] === "--version") {
          return {
            exitCode: installed ? 0 : 127,
            stderr: "",
            stdout: installed ? "2.1.205" : "",
          };
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });
    const containers = createContainers({
      allowedMountRoots: [],
      instanceLabel: "prepare-test",
      runtime,
      store: createMemoryContainerStore(),
    });
    const container = await containers.start({
      format: "foundry.sandbox.container/1",
      image: "fixture",
    });
    try {
      const download = vi.fn(async () => ({
        "/opt/foundry/bin/claude": new Uint8Array([1, 2, 3]),
      }));
      const first = await prepareGuest(container, {
        apiKey: "key-first",
        download,
        harness: "claude-code",
        sessionId: "first",
        signal: new AbortController().signal,
      });
      const second = await prepareGuest(container, {
        apiKey: "key-second",
        download,
        harness: "claude-code",
        sessionId: "second",
        signal: new AbortController().signal,
      });
      expect(download).toHaveBeenCalledTimes(1);
      expect(first.environment.CLAUDE_CONFIG_DIR).not.toBe(
        second.environment.CLAUDE_CONFIG_DIR
      );
      expect(first.environment.ANTHROPIC_API_KEY).toBe("key-first");
      expect(second.environment.ANTHROPIC_API_KEY).toBe("key-second");
      expect(JSON.stringify(container.row)).not.toContain("key-first");
      expect(
        JSON.stringify([...(runtime.instances[0]?.files ?? [])])
      ).not.toContain("key-first");
      await expect(
        prepareGuest(container, {
          apiKey: "",
          harness: "codex",
          sessionId: "third",
          signal: new AbortController().signal,
        })
      ).rejects.toThrow("explicit per-session authentication");
    } finally {
      await containers.shutdown();
    }
  });
});
