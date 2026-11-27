import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { createContainers } from "../containers/containers";
import type { ContainerDefaults } from "../containers/driver";
import type { ContainerSpecInput } from "../containers/spec";
import { resolveContainerSpec } from "../containers/spec";
import { reserveLoopbackPorts } from "../node/network";
import { MemoryContainerStore } from "../store/memory";
import type { FakeDriverOptions } from "../testing/index";
import { createFakeDriver } from "../testing/index";

const PORT_RANGE_ERROR = /1 through 65535/i;
const DUPLICATE_PORT_ERROR = /must be unique/i;
const REMOVED_CONTAINER_ERROR = /has been removed/;

const SPEC: ContainerSpecInput = {};

async function started(
  defaults: ContainerDefaults = {},
  options: FakeDriverOptions = {}
) {
  const runtime = createFakeDriver(options);
  const containers = createContainers({
    defaults,
    driver: runtime,
    instanceLabel: "facet-contract",
    store: new MemoryContainerStore(),
  });
  const container = await containers.start(SPEC);
  const [instance] = runtime.handles;
  if (instance === undefined) {
    throw new Error("expected a booted instance");
  }
  return { container, containers, instance, runtime };
}

describe("resolveContainerSpec", () => {
  it("converts container resource limits to microVM units", () => {
    const spec = resolveContainerSpec({
      input: {
        resources: { cpus: 1.5, memoryBytes: 512 * 1024 * 1024, pids: 256 },
      },
      labels: {},
      name: "c1",
    });

    expect(spec.memoryMib).toBe(512);
    expect(spec.cpus).toBe(2);
    expect(spec.pidsLimit).toBe(256);
  });

  it("rounds a partial MiB of memory up so the requested minimum is met", () => {
    const spec = resolveContainerSpec({
      input: {
        resources: { memoryBytes: 512 * 1024 * 1024 + 1 },
      },
      labels: {},
      name: "c2",
    });

    expect(spec.memoryMib).toBe(513);
  });

  it("stamps the base and immutable environment-id labels alongside caller labels", () => {
    const spec = resolveContainerSpec({
      input: {
        labels: {
          "com.foundry.environment.id": "forged",
          "com.foundry.session": "s1",
        },
      },
      labels: {},
      name: "c3",
    });

    expect(spec.labels).toEqual({
      "com.foundry.environment.id": spec.name,
      "com.foundry.sandbox": "1",
      "com.foundry.session": "s1",
    });
  });

  it("validates guest ports and lets local drivers reserve distinct loopback ports", async () => {
    const spec = resolveContainerSpec({
      input: { expose: [{ port: 3000 }, { port: 5173 }] },
      labels: {},
      name: "c4",
    });

    expect(spec.expose.map((e) => e.port)).toEqual([3000, 5173]);
    const mappings = await reserveLoopbackPorts(spec.expose.map((e) => e.port));
    expect(mappings.map((p) => p.guestPort)).toEqual([3000, 5173]);
    expect(mappings.map((p) => p.host)).toEqual(["127.0.0.1", "127.0.0.1"]);
    const hostPorts = mappings.map((p) => p.hostPort);
    expect(new Set(hostPorts).size).toBe(2);
    for (const port of hostPorts) {
      expect(port).toBeGreaterThan(0);
    }
  });

  it("rejects invalid or repeated guest ports before assigning host ingress", () => {
    expect(() =>
      resolveContainerSpec({
        input: { expose: [{ port: 0 }] },
        labels: {},
        name: "c5",
      })
    ).toThrow(PORT_RANGE_ERROR);
    expect(() =>
      resolveContainerSpec({
        input: { expose: [{ port: 3000 }, { port: 3000 }] },
        labels: {},
        name: "c6",
      })
    ).toThrow(DUPLICATE_PORT_ERROR);
    try {
      resolveContainerSpec({
        input: { expose: [{ port: 0 }] },
        labels: {},
        name: "c7",
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid-contract",
        name: "SandboxError",
      });
    }
  });
});

describe("a container's facets", () => {
  it("reads back what it writes, and reports the mapped host port", async () => {
    const { container, containers } = await started({
      expose: [{ port: 3000 }],
      workdir: "/workspace",
    });

    await container.files.writeFile("hello.txt", "from the host");
    expect(
      Buffer.from(
        await container.files.readFile("/workspace/hello.txt")
      ).toString()
    ).toBe("from the host");

    expect(await container.ports?.endpoint(3000)).toMatchObject({
      host: "127.0.0.1",
      port: 43_000,
    });
    expect(await container.ports?.endpoint(9999)).toBeUndefined();
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
      _command: unknown,
      options: { readonly cwd: string }
    ): never => {
      seen.push(options.cwd);
      return { wait: () => Promise.resolve() } as never;
    };
    vi.spyOn(instance, "exec").mockImplementation(record);
    vi.spyOn(instance as Required<typeof instance>, "spawn").mockImplementation(
      record
    );
    vi.spyOn(
      instance as Required<typeof instance>,
      "startProcess"
    ).mockImplementation(record);
    vi.spyOn(
      instance as Required<typeof instance>,
      "execStream"
    ).mockImplementation(record);

    await container.commands.exec(["true"], { cwd: "app" });
    await container.processes?.spawn?.(["true"], { cwd: "app/src" });
    await container.processes?.start(["true"], { cwd: "/opt/./tool" });
    await container.shell?.open({ cwd: "app" });
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
      () => container.processes?.spawn?.(["true"], { cwd: "../etc" }),
      () => container.processes?.start(["true"], { cwd: "../etc" }),
      () => container.shell?.open({ cwd: "../etc" }),
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
    const runtime = createFakeDriver();
    const containers = createContainers({
      driver: runtime,
      instanceLabel: "facet-contract",
      store: new MemoryContainerStore(),
    });
    const container = await containers.start({
      ...SPEC,
      mounts: [
        {
          access: "read-only",
          id: "data",
          source: { kind: "host-directory", path: source },
          target: "/workspace/data",
        },
      ],
    });
    const { commands, files, ports, processes, services, shell, volumes } =
      container;
    if (volumes === undefined || services === undefined) {
      throw new Error("expected volumes and services facets");
    }
    await services.start({
      argv: ["serve"],
      id: "program",
      readiness: { kind: "started" },
    });

    await container.close();

    expect(runtime.handles[0]?.removed).toBe(true);
    for (const run of [
      () => commands.exec(["true"]),
      () => files.copyIn({}),
      () => files.copyOut("."),
      () => files.isDirectory("."),
      () => files.list("."),
      () => files.list(".", { recursive: true }),
      () => files.lstat?.("a"),
      () => files.readDirectory?.("."),
      () => files.readFile("a"),
      () => files.readLink?.("a"),
      () => files.realpath?.("a"),
      () => files.replaceFile?.("a", new Uint8Array()),
      () =>
        files.watch?.(
          ".",
          () => undefined,
          () => undefined
        ),
      () => files.writeFile("a", "a"),
      () => ports?.endpoint(3000),
      () => processes?.spawn?.(["true"]),
      () => processes?.start(["true"]),
      () => services?.list(),
      () =>
        services.start({
          argv: ["serve"],
          id: "late",
          readiness: { kind: "started" },
        }),
      () => services.stop("program"),
      () => services.stop("unknown"),
      () => shell?.open(),
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
        await container.files.watch?.(".", changed, vi.fn());
        const watcher = await container.files.watch?.(".", closed, vi.fn());
        await watcher?.close();
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
    await container.processes?.spawn?.(["serve"]);
    expect(signal?.aborted).toBe(false);

    await container.close();

    expect(signal?.aborted).toBe(true);
    await containers.shutdown();
  });
});
