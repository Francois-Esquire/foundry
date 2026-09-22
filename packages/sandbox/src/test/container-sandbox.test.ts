import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  createContainerSandbox,
  resolveContainerSpec,
} from "../container/sandbox";
import { createFakeContainerRuntime } from "../testing";

const PORT_RANGE_ERROR = /1 through 65535/i;
const DUPLICATE_PORT_ERROR = /must be unique/i;
const REMOVED_CONTAINER_ERROR = /has been removed/;

describe("resolveContainerSpec", () => {
  it("converts container resource limits to microVM units", async () => {
    const spec = await resolveContainerSpec({
      resources: { cpus: 1.5, memoryBytes: 512 * 1024 * 1024, pids: 256 },
    });

    expect(spec.memoryMib).toBe(512);
    // 1.5 fractional cores cannot be handed to a guest — round up to 2.
    expect(spec.cpus).toBe(2);
    expect(spec.pidsLimit).toBe(256);
  });

  it("stamps the base and immutable environment-id labels alongside caller labels", async () => {
    const spec = await resolveContainerSpec({
      labels: {
        // A caller label can never spoof the native identity.
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
  });
});

describe("container sandbox", () => {
  it("reads back what it writes, and reports the mapped host port", async () => {
    const runtime = createFakeContainerRuntime();
    await using box = await createContainerSandbox(
      { ports: [3000], workdir: "/workspace" },
      { runtime }
    );

    await box.writeFile("/workspace/hello.txt", "from the host");
    expect(await box.readTextFile("/workspace/hello.txt")).toBe(
      "from the host"
    );

    const spec = runtime.instances[0]?.spec;
    expect(await box.hostPort(3000)).toBe(spec?.ports[0]?.hostPort);
    // A port that was never published has no mapping.
    expect(await box.hostPort(9999)).toBeUndefined();
  });

  /**
   * The regression behind "[InvalidConfig] workdir does not exist in guest".
   * The microVM runtime refuses to boot without the workdir, and stock images
   * rarely carry the caller's path (`node:*-slim` ships `/home/node`, not
   * `/home/user`).
   */
  it("creates the working directory in the guest before handing the sandbox over", async () => {
    const runtime = createFakeContainerRuntime();
    await using box = await createContainerSandbox(
      { workdir: "/home/user" },
      { runtime }
    );

    expect(runtime.instances[0]?.directories).toEqual(["/home/user"]);
    expect(box.workdir).toBe("/home/user");
  });

  it("runs a bare string through the guest shell and argv arrays directly", async () => {
    const runtime = createFakeContainerRuntime({
      exec: (command) => ({
        exitCode: 0,
        stderr: "",
        stdout: command.join(" "),
      }),
    });
    await using box = await createContainerSandbox({}, { runtime });

    expect((await box.exec("echo hi")).stdout).toBe("sh -c echo hi");
    expect((await box.exec(["echo", "hi"])).stdout).toBe("echo hi");
  });

  it("merges sandbox env under per-exec env, defaulting cwd to the workdir", async () => {
    const runtime = createFakeContainerRuntime();
    await using box = await createContainerSandbox(
      { env: { A: "sandbox", B: "sandbox" }, workdir: "/srv" },
      { runtime }
    );

    let seen: { cwd: string; env: Record<string, string> } | undefined;
    const withCapture = createFakeContainerRuntime({
      exec: (_command, options) => {
        seen = { cwd: options.cwd, env: options.env };
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });
    await using capturing = await createContainerSandbox(
      { env: { A: "sandbox", B: "sandbox" }, workdir: "/srv" },
      { runtime: withCapture }
    );
    await capturing.exec(["true"], { environment: { B: "exec" } });

    expect(seen).toEqual({ cwd: "/srv", env: { A: "sandbox", B: "exec" } });
    expect(box.workdir).toBe("/srv");
  });

  it("copies a directory tree out as a flat path map", async () => {
    const runtime = createFakeContainerRuntime({
      files: {
        "/workspace/a.txt": "a",
        "/workspace/nested/b.txt": "b",
      },
    });
    await using box = await createContainerSandbox({}, { runtime });

    const out = await box.copyOut("/workspace");

    expect(Object.keys(out).sort()).toEqual([
      "/workspace/a.txt",
      "/workspace/nested/b.txt",
    ]);
    expect(
      Buffer.from(out["/workspace/a.txt"] ?? new Uint8Array()).toString()
    ).toBe("a");
  });

  it("enumerates one level by default and the whole tree when recursive", async () => {
    const runtime = createFakeContainerRuntime({
      files: {
        "/workspace/a.txt": "a",
        "/workspace/nested/b.txt": "b",
      },
    });
    await using box = await createContainerSandbox({}, { runtime });

    expect(
      (await box.listDirectory("/workspace", false)).map((e) => e.path)
    ).toEqual(["/workspace/a.txt", "/workspace/nested"]);
    expect(
      (await box.listDirectory("/workspace", true)).map((e) => e.path).sort()
    ).toEqual([
      "/workspace/a.txt",
      "/workspace/nested",
      "/workspace/nested/b.txt",
    ]);
  });

  it("refuses further work once removed, and removes idempotently", async () => {
    const runtime = createFakeContainerRuntime();
    const box = await createContainerSandbox({}, { runtime });

    await box.remove();
    await box.remove();

    expect(runtime.instances[0]?.removed).toBe(true);
    expect(box.status).toBe("removed");
    await expect(box.exec(["true"])).rejects.toThrow(REMOVED_CONTAINER_ERROR);
  });
});
