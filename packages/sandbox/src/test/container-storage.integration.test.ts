import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createContainers } from "../container/containers";
import { createMicrosandboxRuntime } from "../container/microsandbox-runtime";
import { createMemoryContainerStore } from "../container/store";

it("uses guest storage over a mounted slice and enforces a read-only mount", async () => {
  const runtime = createMicrosandboxRuntime();
  if (!(await runtime.isInstalled())) {
    throw new Error(
      "Install the MicroSandbox runtime before running test:integration"
    );
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "guest-storage-")));
  const source = join(root, "selected");
  await mkdir(source);
  await writeFile(join(source, "notes.md"), "initial");
  await writeFile(join(root, "outside.txt"), "outside");
  await symlink("notes.md", join(source, "link"));
  await symlink(join(root, "outside.txt"), join(source, "escape"));
  const containers = createContainers({
    allowedMountRoots: [source],
    instanceLabel: `storage-test-${crypto.randomUUID()}`,
    mountTargetRoot: "/mounts",
    runtime,
    store: createMemoryContainerStore(),
  });
  try {
    const container = await containers.start({
      format: "foundry.sandbox.container/1",
      mounts: [
        {
          access: "read-write",
          id: "workspace",
          source,
          target: "/mounts/workspace",
        },
        {
          access: "read-only",
          id: "read-only",
          source,
          target: "/mounts/readonly",
        },
      ],
      network: "disabled",
      workdir: "/mounts/workspace",
    });
    expect(await container.files.lstat("link")).toMatchObject({
      type: "symlink",
    });
    expect(await container.files.realpath("link")).toBe(
      "/mounts/workspace/notes.md"
    );
    expect(
      (await container.files.readDirectory("."))
        .map((entry) => entry.name)
        .sort()
    ).toEqual(["escape", "link", "notes.md"]);
    await expect(container.files.readFile("escape")).rejects.toThrow();
    await expect(
      container.files.replaceFile("link", new Uint8Array([1]))
    ).rejects.toThrow();
    await container.files.replaceFile(
      "notes.md",
      new TextEncoder().encode("saved")
    );
    expect(await readFile(join(source, "notes.md"), "utf8")).toBe("saved");
    expect(
      (await container.commands.exec(["cat", "/mounts/workspace/notes.md"]))
        .stdout
    ).toBe("saved");
    await expect(
      container.files.replaceFile(
        "/mounts/readonly/notes.md",
        new Uint8Array([1])
      )
    ).rejects.toThrow();
    expect(await readFile(join(source, "notes.md"), "utf8")).toBe("saved");
    await container.close();
  } finally {
    try {
      await containers.shutdown();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
}, 120_000);
