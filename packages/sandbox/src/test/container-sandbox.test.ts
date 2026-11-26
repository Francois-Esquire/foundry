import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ContainerSandboxConstraints } from "../container/constraints";
import { createContainers } from "../container/containers";
import type { ContainerConfig } from "../container/runtime";
import { resolveContainerSpec } from "../container/spec";
import { MemoryContainerStore } from "../store/memory";
import type { FakeContainerRuntimeOptions } from "../testing/index";
import { createFakeContainerRuntime } from "../testing/index";

const PORT_RANGE_ERROR = /1 through 65535/i;
const DUPLICATE_PORT_ERROR = /must be unique/i;
const REMOVED_CONTAINER_ERROR = /has been removed/;

const SPEC: ContainerSandboxConstraints = {
  format: "foundry.sandbox.container/1",
};

async function started(
  config: ContainerConfig = {},
  options: FakeContainerRuntimeOptions = {}
) {
  const runtime = createFakeContainerRuntime(options);
  const containers = createContainers({
    config,
    instanceLabel: "facet-contract",
    runtime,
    store: new MemoryContainerStore(),
  });
  const container = await containers.start(SPEC);
  const [instance] = runtime.instances;
  if (instance === undefined) {
    throw new Error("expected a booted instance");
  }
  return { container, containers, instance, runtime };
}

describe("resolveContainerSpec", () => {
  it("converts container resource limits to microVM units", async () => {
    const spec = await resolveContainerSpec({
      resources: { cpus: 1.5, memoryBytes: 512 * 1024 * 1024, pids: 256 },
    });

    expect(spec.memoryMib).toBe(512);
    expect(spec.cpus).toBe(2);
    expect(spec.pidsLimit).toBe(256);
  });

  it("rounds a partial MiB of memory up so the requested minimum is met", async () => {
    const spec = await resolveContainerSpec({
      resources: { memoryBytes: 512 * 1024 * 1024 + 1 },
    });

    expect(spec.memoryMib).toBe(513);
  });

  it("stamps the base and immutable environment-id labels alongside caller labels", async () => {
    const spec = await resolveContainerSpec({
      labels: {
        "com.foundry.environment.id": "forged",
        "com.foundry.session": "s1",
      },
    });

    expect(spec.labels).toEqual({
      "com.foundry.environment.id": spec.name,
      "com.foundry.sandbox": "1",
      "com.foundry.session": "s1",
    });
  });

  it("assigns a distinct loopback host port per published guest port", async () => {
    const spec = await resolveContainerSpec({ ports: [3000, 5173] });

    expect(spec.ports.map((p) => p.guestPort)).toEqual([3000, 5173]);
    expect(spec.ports.map((p) => p.host)).toEqual(["127.0.0.1", "127.0.0.1"]);
    const hostPorts = spec.ports.map((p) => p.hostPort);
    expect(new Set(hostPorts).size).toBe(2);
    for (const port of hostPorts) {
      expect(port).toBeGreaterThan(0);
    }
  });

  it("rejects invalid or repeated guest ports before assigning host ingress", async () => {
    await expect(resolveContainerSpec({ ports: [0] })).rejects.toThrow(
      PORT_RANGE_ERROR
    );
    await expect(resolveContainerSpec({ ports: [3000, 3000] })).rejects.toThrow(
      DUPLICATE_PORT_ERROR
    );
    await expect(resolveContainerSpec({ ports: [0] })).rejects.toMatchObject({
      code: "invalid-contract",
      name: "SandboxError",
    });
  });
});

describe("a container's facets", () => {
  it("reads back what it writes, and reports the mapped host port", async () => {
    const { container, containers, instance } = await started({
      ports: [3000],
      workdir: "/workspace",
    });

    await container.files.writeFile("hello.txt", "from the host");
    expect(
      Buffer.from(
        await container.files.readFile("/workspace/hello.txt")
      ).toString()
    ).toBe("from the host");

    expect(await container.ports.hostPort(3000)).toEqual({
      host: "127.0.0.1",
      port: instance.spec.ports[0]?.hostPort,
    });
    expect(await container.ports.hostPort(9999)).toBeUndefined();
    await containers.shutdown();
  });

  it("creates the working directory in the guest before handing the container over", async () => {
    const { container, containers, instance } = await started({
      workdir: "/home/user",
    });

    expect(instance.directories).toEqual(["/home/user"]);
    expect(container.workingDirectory).toBe("/home/user");
    await containers.shutdown();
  });

  it("runs a bare string through the guest shell and argv arrays directly", async () => {
    const { container, containers } = await started(
      {},
      {
        exec: (command) => ({
          exitCode: 0,
          stderr: "",
          stdout: command.join(" "),
        }),
      }
    );

    expect((await container.commands.exec("echo hi")).stdout).toBe(
      "sh -c echo hi"
    );
    expect((await container.commands.exec(["echo", "hi"])).stdout).toBe(
      "echo hi"
    );
    await containers.shutdown();
  });

  it("merges sandbox env under per-exec env, defaulting cwd to the workdir", async () => {
    let seen: { cwd: string; env: Record<string, string> } | undefined;
    const { container, containers } = await started(
      { env: { A: "sandbox", B: "sandbox" }, workdir: "/srv" },
      {
        exec: (_command, options) => {
          seen = { cwd: options.cwd, env: options.env };
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      }
    );
    await container.commands.exec(["true"], { environment: { B: "exec" } });

    expect(seen).toEqual({ cwd: "/srv", env: { A: "sandbox", B: "exec" } });
    await containers.shutdown();
  });

  it("resolves cwd the same way for exec, spawn, start, and shell", async () => {
    const { container, containers, instance } = await started({
      workdir: "/srv",
    });
    const seen: string[] = [];
    const record = (
      _command: string[],
      options: { readonly cwd: string }
    ): never => {
      seen.push(options.cwd);
      return { wait: () => Promise.resolve() } as never;
    };
    vi.spyOn(instance, "exec").mockImplementation(record);
    vi.spyOn(instance, "spawn").mockImplementation(record);
    vi.spyOn(instance, "startProcess").mockImplementation(record);
    vi.spyOn(instance, "execStream").mockImplementation(record);

    await container.commands.exec(["true"], { cwd: "app" });
    await container.processes.spawn(["true"], { cwd: "app/src" });
    await container.processes.start(["true"], { cwd: "/opt/./tool" });
    await container.shell.open({ cwd: "app" });
    await container.commands.exec(["true"]);
    expect(seen).toEqual([
      "/srv/app",
      "/srv/app/src",
      "/opt/tool",
      "/srv/app",
      "/srv",
    ]);

    for (const run of [
      () => container.commands.exec(["true"], { cwd: "../etc" }),
      () => container.processes.spawn(["true"], { cwd: "../etc" }),
      () => container.processes.start(["true"], { cwd: "../etc" }),
      () => container.shell.open({ cwd: "../etc" }),
    ]) {
      await expect(run()).rejects.toMatchObject({ code: "invalid-contract" });
    }
    await containers.shutdown();
  });

  it("copies a directory tree out as a flat path map", async () => {
    const { container, containers } = await started(
      {},
      {
        files: {
          "/workspace/a.txt": "a",
          "/workspace/nested/b.txt": "b",
        },
      }
    );

    const out = await container.files.copyOut("/workspace");

    expect(Object.keys(out).sort()).toEqual([
      "/workspace/a.txt",
      "/workspace/nested/b.txt",
    ]);
    expect(
      Buffer.from(out["/workspace/a.txt"] ?? new Uint8Array()).toString()
    ).toBe("a");
    await containers.shutdown();
  });

  it("enumerates one level by default and the whole tree when recursive", async () => {
    const { container, containers } = await started(
      {},
      {
        files: {
          "/workspace/a.txt": "a",
          "/workspace/nested/b.txt": "b",
        },
      }
    );

    expect(
      (await container.files.list("/workspace")).map((e) => e.path)
    ).toEqual(["/workspace/a.txt", "/workspace/nested"]);
    expect(
      (await container.files.list("/workspace", { recursive: true }))
        .map((e) => e.path)
        .sort()
    ).toEqual([
      "/workspace/a.txt",
      "/workspace/nested",
      "/workspace/nested/b.txt",
    ]);
    await containers.shutdown();
  });

  it("refuses every operation on every facet once closed", async () => {
    const source = await mkdtemp(join(tmpdir(), "sandbox-facets-"));
    const runtime = createFakeContainerRuntime();
    const containers = createContainers({
      allowedMountRoots: [source],
      instanceLabel: "facet-contract",
      runtime,
      store: new MemoryContainerStore(),
    });
    const container = await containers.start({
      ...SPEC,
      mounts: [
        { access: "read-only", id: "data", source, target: "/workspace/data" },
      ],
    });
    const { commands, files, ports, processes, services, shell, volumes } =
      container;
    if (volumes === undefined) {
      throw new Error("expected a volumes facet");
    }
    await services.start({
      argv: ["serve"],
      id: "program",
      readiness: { kind: "started" },
    });

    await container.close();

    expect(runtime.instances[0]?.removed).toBe(true);
    for (const run of [
      () => commands.exec(["true"]),
      () => files.copyIn({}),
      () => files.copyOut("."),
      () => files.isDirectory("."),
      () => files.list("."),
      () => files.list(".", { recursive: true }),
      () => files.lstat("a"),
      () => files.readDirectory("."),
      () => files.readFile("a"),
      () => files.readLink("a"),
      () => files.realpath("a"),
      () => files.replaceFile("a", new Uint8Array()),
      () =>
        files.watch(
          ".",
          () => undefined,
          () => undefined
        ),
      () => files.writeFile("a", "a"),
      () => ports.hostPort(3000),
      () => processes.spawn(["true"]),
      () => processes.start(["true"]),
      () => services.list(),
      () =>
        services.start({
          argv: ["serve"],
          id: "late",
          readiness: { kind: "started" },
        }),
      () => services.stop("program"),
      () => services.stop("unknown"),
      () => shell.open(),
      () => volumes.list(),
      () => volumes.unmount("data"),
      () => volumes.unmount("unknown"),
    ]) {
      await expect(run()).rejects.toThrow(REMOVED_CONTAINER_ERROR);
      await expect(run()).rejects.toMatchObject({
        code: "invalid-transition",
      });
    }
    await containers.shutdown();
    await rm(source, { force: true, recursive: true });
  });

  it.each(["close", "restart", "shutdown"] as const)(
    "stops an active watcher on %s",
    async (ending) => {
      const { container, containers } = await started();
      vi.useFakeTimers();
      try {
        const changed = vi.fn();
        const closed = vi.fn();
        await container.files.watch(".", changed, vi.fn());
        const watcher = await container.files.watch(".", closed, vi.fn());
        await watcher.close();
        await vi.advanceTimersByTimeAsync(2000);
        expect(changed).toHaveBeenCalledTimes(2);

        await {
          close: () => container.close(),
          restart: () => containers.restart(container.id),
          shutdown: () => containers.shutdown(),
        }[ending]();
        await vi.advanceTimersByTimeAsync(5000);

        expect(changed).toHaveBeenCalledTimes(2);
        expect(closed).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
      await containers.shutdown();
    }
  );

  it("refuses further operations once removal began, even if it failed, and retries the removal", async () => {
    const { container, containers, instance } = await started();
    const remove = vi
      .spyOn(instance, "remove")
      .mockRejectedValueOnce(new Error("still here"));

    await expect(container.close()).rejects.toThrow("still here");
    await expect(container.commands.exec(["true"])).rejects.toThrow(
      REMOVED_CONTAINER_ERROR
    );
    await containers.shutdown();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(instance.removed).toBe(true);
  });

  it("cancels a running piped process when the container closes", async () => {
    let signal: AbortSignal | undefined;
    const { container, containers } = await started(
      {},
      {
        spawn: (_command, options) => {
          ({ signal } = options);
          return {} as never;
        },
      }
    );
    await container.processes.spawn(["serve"]);
    expect(signal?.aborted).toBe(false);

    await container.close();

    expect(signal?.aborted).toBe(true);
    await containers.shutdown();
  });
});
