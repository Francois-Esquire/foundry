import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createContainers } from "../container/containers";
import { createMicrosandboxRuntime } from "../container/microsandbox-runtime";
import { createMemoryContainerStore } from "../container/store";

it("executes workspace tools while preserving nosuid/nodev and config noexec", async () => {
  const source = await realpath(
    await mkdtemp(join(tmpdir(), "sandbox-executable-"))
  );
  await writeFile(join(source, "tool"), "#!/bin/sh\nprintf 'workspace-tool'\n");
  await chmod(join(source, "tool"), 0o755);
  const containers = createContainers({
    allowedMountRoots: [source],
    instanceLabel: `exec-test-${crypto.randomUUID()}`,
    runtime: createMicrosandboxRuntime(),
    store: createMemoryContainerStore(),
  });
  try {
    const container = await containers.start({
      format: "foundry.sandbox.container/1",
      mounts: [
        {
          access: "read-write",
          executable: true,
          id: "workspace",
          source,
          target: "/mounts/workspace",
        },
        { access: "read-only", id: "config", source, target: "/mounts/config" },
      ],
    });
    expect(
      await container.commands.exec(["/mounts/workspace/tool"])
    ).toMatchObject({ exitCode: 0, stdout: "workspace-tool" });
    const config = await container.commands.exec([
      "sh",
      "-c",
      "/mounts/config/tool",
    ]);
    expect(config.exitCode).not.toBe(0);
    const mounts = (
      await container.commands.exec(["cat", "/proc/mounts"])
    ).stdout.split("\n");
    const flags = (target: string) =>
      mounts
        .find((line) => line.split(" ")[1] === target)
        ?.split(" ")[3]
        ?.split(",");
    expect(flags("/mounts/workspace")).toEqual(
      expect.arrayContaining(["nosuid", "nodev"])
    );
    expect(flags("/mounts/workspace")).not.toContain("noexec");
    expect(flags("/mounts/config")).toEqual(
      expect.arrayContaining(["ro", "nosuid", "nodev", "noexec"])
    );
    await container.close();
  } finally {
    await containers.shutdown();
    await rm(source, { force: true, recursive: true });
  }
}, 120_000);
