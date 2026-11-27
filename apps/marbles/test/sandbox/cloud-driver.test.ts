import { createContainers, SandboxError } from "@foundry/sandbox";
import { MemoryContainerStore } from "@foundry/sandbox/store/memory";
import { createCloudFakeDriver } from "@foundry/sandbox/testing";
import { describe, expect, it, vi } from "vitest";
import { Catalog } from "~/authoring/catalog";
import { createEngine } from "~/create";
import { createCodingTools } from "~/lib/sandbox/coding-tools";
import { FIRST_PARTY_DRIVERS } from "~/lib/sandbox/drivers";
import { prepareGuest } from "~/lib/sandbox/prepare";

const PREBAKED_MISSING_ERROR = /Pre-baked guest CLI/;

describe("Marbles cloud-native sandbox integration", () => {
  it("injects a cloud driver via createEngine and materializes workspaces via file sync without host bind mounts", async () => {
    const cloudDriver = createCloudFakeDriver();
    const materialized = vi.fn(async (container, { target }) => {
      await container.files.copyIn({
        [`${target}/README.md`]: "# Synced to cloud",
      });
    });

    const engine = createEngine({
      catalog: new Catalog(),
      dry: false,
      print: () => undefined,
      root: "/virtual/project",
      sandboxDriver: cloudDriver,
      workspaceId: "cloud-ws",
      workspaceMaterialization: materialized,
    });

    try {
      const handle = await engine.sandboxes.start({
        expose: [{ access: "private", port: 3000, protocol: "https" }],
        image: "ghcr.io/foundry/agent:latest",
        lifetime: { idleTimeoutMs: 60_000, whenReleased: "keep" },
        network: "internet",
      });

      expect(cloudDriver.handles).toHaveLength(1);
      expect(cloudDriver.handles[0]?.spec.mounts).toEqual([]);
      expect(materialized).toHaveBeenCalledWith(
        expect.objectContaining({ id: handle.id }),
        { source: "/virtual/project", target: "/workspace" }
      );
      expect(
        new TextDecoder().decode(
          await handle.files.readFile("/workspace/README.md")
        )
      ).toBe("# Synced to cloud");

      const endpoint = await handle.ports?.endpoint(3000);
      expect(endpoint?.url).toBe("https://3000-sbx-1.cloud.sandbox.test");

      await handle.close();
    } finally {
      await engine.dispose();
    }
  });

  it("supports pre-baked guest CLIs without host tar/download and runs built-in coding tools without POSIX storage", async () => {
    const cloudDriver = createCloudFakeDriver({
      files: { "/workspace/app.ts": "export const value = 1;\n" },
    });
    const containers = createContainers({
      driver: cloudDriver,
      instanceLabel: "marbles-cloud",
      store: new MemoryContainerStore(),
    });
    const container = await containers.start({
      image: "ghcr.io/foundry/prebaked-claude:latest",
      network: "none",
    });

    try {
      const download = vi.fn();
      const guest = await prepareGuest(container, {
        auth: { apiKey: "test-key", kind: "apiKey" },
        download,
        harness: "claude-code",
        preinstalledExecutable: "/usr/local/bin/claude",
        provisioning: "prebaked",
        sessionId: "cloud-session-1",
        signal: new AbortController().signal,
      });

      expect(guest.executable).toBe("/usr/local/bin/claude");
      expect(download).not.toHaveBeenCalled();

      const tools = createCodingTools(container);
      expect(Object.keys(tools)).toEqual(
        expect.arrayContaining([
          "read",
          "write",
          "edit",
          "glob",
          "grep",
          "bash",
        ])
      );

      await expect(
        Promise.resolve(
          FIRST_PARTY_DRIVERS["claude-code"]({
            auth: { apiKey: "test-key", kind: "apiKey" },
            guest,
            settings: {
              agentId: "agent-1",
              container,
              harness: "claude-code",
              hostCwd: "/virtual/project",
              instructions: "test",
              modelId: "claude-sonnet-4-5",
              options: {
                authority: { policy: {} as never },
                sandbox: {} as never,
              },
              provider: "anthropic",
              sessionId: "cloud-session-1",
              signal: new AbortController().signal,
              store: {} as never,
              write: () => undefined,
            },
          })
        ).then(async (driver) => {
          const stream = await driver.run({
            input: { parts: [{ text: "hi", type: "text" }] },
            onActivity: async () => undefined,
            onSessionId: async () => undefined,
            onToolEvent: async () => undefined,
            permission: async () => ({ behavior: "allow" }),
            profile: {
              allowedTools: [],
              disallowedTools: [],
              maxSteps: 1,
              mode: "scheduled",
              unresolved: "deny",
            },
            question: async () => ({ answers: {}, outcome: "answered" }),
            sessionId: "cloud-session-1",
            signal: new AbortController().signal,
          });
          for await (const _chunk of stream) {
            // drain until spawn rejects
          }
        })
      ).rejects.toThrow();
    } finally {
      await container.close();
      await containers.shutdown();
    }
  });

  it("fails clearly when provisioning is prebaked and the guest CLI is missing", async () => {
    const cloudDriver = createCloudFakeDriver({
      exec: (argv) => {
        if (argv[0] === "uname") {
          return { exitCode: 0, stderr: "", stdout: "x86_64\n" };
        }
        if (argv[0] === "mkdir") {
          return { exitCode: 0, stderr: "", stdout: "" };
        }
        return { exitCode: 1, stderr: "", stdout: "" };
      },
    });
    const containers = createContainers({
      driver: cloudDriver,
      instanceLabel: "marbles-prebaked-missing",
      store: new MemoryContainerStore(),
    });
    const container = await containers.start({
      image: "ghcr.io/foundry/empty:latest",
      network: "none",
    });

    try {
      await expect(
        prepareGuest(container, {
          auth: { apiKey: "test-key", kind: "apiKey" },
          harness: "claude-code",
          provisioning: "prebaked",
          sessionId: "cloud-session-2",
          signal: new AbortController().signal,
        })
      ).rejects.toThrow(PREBAKED_MISSING_ERROR);
    } finally {
      await container.close();
      await containers.shutdown();
    }
  });

  it("throws SandboxError(unsupported) when a CLI driver tries to spawn on a cloud driver without spawn", async () => {
    const cloudDriver = createCloudFakeDriver();
    const containers = createContainers({
      driver: cloudDriver,
      instanceLabel: "marbles-no-spawn",
      store: new MemoryContainerStore(),
    });
    const container = await containers.start({
      image: "ghcr.io/foundry/agent:latest",
      network: "none",
    });

    try {
      expect(container.processes?.spawn).toBeUndefined();
      const err = new SandboxError("unsupported", "no spawn");
      expect(err.code).toBe("unsupported");
    } finally {
      await container.close();
      await containers.shutdown();
    }
  });

  it("rejects an explicit workspace selection when the driver lacks host-directory mounts and no materializer is configured", async () => {
    const cloudDriver = createCloudFakeDriver();
    const engine = createEngine({
      catalog: new Catalog(),
      dry: false,
      print: () => undefined,
      root: "/virtual/project",
      sandboxDriver: cloudDriver,
      workspaceId: "cloud-ws-no-mat",
    });

    try {
      await expect(
        engine.sandboxes.start({
          image: "ghcr.io/foundry/agent:latest",
        })
      ).rejects.toMatchObject({
        code: "unsupported",
        name: SandboxError.name,
      });

      const empty = await engine.sandboxes.start({
        image: "ghcr.io/foundry/agent:latest",
        mount: "none",
      });
      await empty.close();
    } finally {
      await (await engine.sandboxes.containers()).shutdown();
    }
  });
});
