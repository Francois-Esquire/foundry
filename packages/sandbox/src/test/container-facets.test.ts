import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ContainerSandboxConstraints } from "../container/constraints";
import { createContainers } from "../container/containers";
import { createMemoryContainerStore } from "../container/store";
import type { FakeContainerRuntimeOptions } from "../testing";
import { createFakeContainerRuntime } from "../testing";
import {
  SANDBOX_ARGV_FIXTURE,
  SANDBOX_SHELL_FIXTURE,
} from "./helpers/fixtures";
import { runSandboxContract } from "./helpers/sandbox-contract";

const BOUNDED_CONTRACT_ERROR = /bounded portable contract/i;
const OWNERSHIP_ERROR = /does not belong/i;
const DATA_MOUNT_PATH = /\/foundry\/data/;

const SPEC: ContainerSandboxConstraints = {
  format: "foundry.sandbox.container/1",
  image: "docker.io/oven/bun:1",
};

function fixture(
  runtimeOptions: FakeContainerRuntimeOptions = {},
  mounts: {
    readonly allowedMountRoots?: readonly string[];
    readonly mountTargetRoot?: string;
  } = {}
) {
  const runtime = createFakeContainerRuntime(runtimeOptions);
  const containers = createContainers({
    instanceLabel: "facets",
    runtime,
    store: createMemoryContainerStore(),
    ...mounts,
  });
  return { containers, runtime };
}

runSandboxContract({
  create: async () => {
    const { containers } = fixture({
      exec: (command) => {
        if (
          command.length === 3 &&
          command.every((part, index) => part === SANDBOX_ARGV_FIXTURE[index])
        ) {
          return { exitCode: 0, stderr: "", stdout: "argv value" };
        }
        if (
          command.length === 3 &&
          command[0] === "sh" &&
          command[1] === "-c" &&
          command[2] === SANDBOX_SHELL_FIXTURE
        ) {
          return { exitCode: 0, stderr: "", stdout: "shell value" };
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });
    const container = await containers.start(SPEC);
    return { dispose: () => container.close(), sandbox: container };
  },
  label: "container",
});

describe("container shell", () => {
  it("offers polling signals for guest storage and releases its timer", async () => {
    const { containers } = fixture();
    const container = await containers.start(SPEC);
    vi.useFakeTimers();
    try {
      const changed = vi.fn();
      const subscription = await container.files.watch(
        "/workspace",
        changed,
        vi.fn()
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(changed).toHaveBeenCalledTimes(1);
      await subscription.close();
      await vi.advanceTimersByTimeAsync(1000);
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      await containers.shutdown();
    }
  });
  it("opens an interactive session whose close is idempotent", async () => {
    const { containers } = fixture();
    const container = await containers.start(SPEC);
    const shell = await container.shell.open();
    const chunks: string[] = [];
    const unsubscribe = shell.onData((chunk) => chunks.push(chunk));
    shell.write("echo hi\n");
    expect(chunks.join("")).toBe("echo hi\n");
    unsubscribe();
    await shell.close();
    await shell.close();
    await container.close();
  });
});

describe("container managed services", () => {
  it("starts, observes, and terminates a long-lived non-TTY process idempotently", async () => {
    const { runtime, containers } = fixture();
    const container = await containers.start(SPEC);
    const { services } = container;
    const service = await services.start({
      argv: ["bun", "start"],
      cwd: "/workspace",
      environment: { FOUNDRY_GATEWAY_TOKEN: "ephemeral" },
      id: "program",
      readiness: { kind: "started" },
      terminationGraceMs: 0,
    });

    expect(service.status).toBe("ready");
    expect(await services.list()).toEqual([service]);
    expect(runtime.instances[0]?.commands).toEqual([["bun", "start"]]);

    const [first, second] = await Promise.all([
      service.terminate(),
      service.terminate(),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      exitCode: 143,
      stderr: "",
      stdout: "",
      terminationRequested: true,
    });
    expect(service.status).toBe("terminated");

    await services.stop("program");
    await expect(
      services.start({
        argv: ["bun", "start"],
        environment: { FOUNDRY_GATEWAY_TOKEN: "x".repeat(8193) },
        id: "bad-environment",
        readiness: { kind: "started" },
      })
    ).rejects.toThrow(BOUNDED_CONTRACT_ERROR);
    await expect(services.stop("another-service")).rejects.toThrow(
      OWNERSHIP_ERROR
    );
    await container.close();
    expect(runtime.instances[0]?.removed).toBe(true);
  });

  it("settles a service whose exec session ends without an exit event", async () => {
    const { runtime, containers } = fixture({
      process: () => {
        throw new Error("runtime error: exec session ended without exit event");
      },
    });
    const container = await containers.start(SPEC);
    const service = await container.services.start({
      argv: ["bun", "start"],
      id: "program",
      readiness: { kind: "started" },
      terminationGraceMs: 0,
    });

    await expect(service.wait()).resolves.toMatchObject({
      exitCode: 137,
      terminationRequested: false,
    });
    expect(service.status).toBe("exited");
    await expect(service.terminate()).resolves.toMatchObject({
      exitCode: 137,
    });
    // Close must stay clean: the dead session is an exit, not a failure.
    await container.close();
    expect(runtime.instances[0]?.removed).toBe(true);
  });

  it("keeps settled stdout and stderr separate from service control", async () => {
    const { containers } = fixture({
      process: () => ({
        exitCode: 7,
        stderr: "program diagnostic",
        stdout: "program output",
      }),
    });
    const container = await containers.start(SPEC);
    const service = await container.services.start({
      argv: ["bun", "start"],
      id: "program",
      readiness: { kind: "started" },
    });

    await expect(service.wait()).resolves.toMatchObject({
      exitCode: 7,
      stderr: "program diagnostic",
      stdout: "program output",
      terminationRequested: false,
    });
    expect(service.status).toBe("exited");
    await container.close();
  });
});

describe("container scoped mounts", () => {
  it("accepts only canonical allowed sources and scopes unmounting to one container", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "foundry-container-mount-")
    );
    const root = path.join(directory, "allowed");
    const source = path.join(root, "installation-1");
    const outside = path.join(directory, "outside");
    await mkdir(source, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(root, "escape"));
    try {
      const { runtime, containers } = fixture(
        {},
        { allowedMountRoots: [root] }
      );
      const container = await containers.start({
        ...SPEC,
        mounts: [
          {
            access: "read-write",
            id: "data",
            source,
            target: "/foundry/data",
          },
        ],
      });
      const { volumes } = container;
      if (volumes === undefined) {
        throw new Error("expected volumes");
      }

      expect(runtime.instances[0]?.spec.mounts).toEqual([
        {
          id: "data",
          readOnly: false,
          source: await realpath(source),
          target: "/foundry/data",
        },
      ]);
      expect(await volumes.list()).toEqual([
        { access: "read-write", id: "data", target: "/foundry/data" },
      ]);
      await volumes.unmount("data");
      await volumes.unmount("data");
      expect(await volumes.list()).toEqual([]);
      await expect(volumes.unmount("another-container")).rejects.toThrow(
        OWNERSHIP_ERROR
      );

      await expect(
        containers.start({
          ...SPEC,
          mounts: [
            {
              access: "read-only",
              id: "escape",
              source: path.join(root, "escape"),
              target: "/foundry/data",
            },
          ],
        })
      ).rejects.toThrow();
      expect(runtime.instances).toHaveLength(1);

      await container.close();
      expect(runtime.instances[0]?.removed).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("confines targets to the configured root and accepts any path without one", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "foundry-container-target-")
    );
    try {
      const spec: ContainerSandboxConstraints = {
        ...SPEC,
        mounts: [
          {
            access: "read-write",
            id: "home",
            source: directory,
            target: "/home/user",
          },
        ],
      };

      const confined = fixture(
        {},
        { allowedMountRoots: [directory], mountTargetRoot: "/foundry/data" }
      );
      await expect(confined.containers.start(spec)).rejects.toThrow(
        DATA_MOUNT_PATH
      );

      const open = fixture({}, { allowedMountRoots: [directory] });
      const container = await open.containers.start(spec);
      expect(container.row.status).toBe("running");
      await container.close();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("offers no volumes when the registry was given no mount roots", async () => {
    const { containers } = fixture();
    const container = await containers.start(SPEC);
    expect(container.volumes).toBeUndefined();
    await container.close();
  });
});
