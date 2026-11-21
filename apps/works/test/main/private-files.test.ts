import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { installationIdSchema } from "@foundry/modules/domain";
import { createModuleInstallationFiles } from "@foundry/modules/node/installation-files";
import type { ContainerSandboxConstraints } from "@foundry/sandbox/container/constraints";
import { createContainers } from "@foundry/sandbox/container/containers";
import { MemoryContainerStore } from "@foundry/sandbox/store/memory";
import { createFakeContainerRuntime } from "@foundry/sandbox/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { moduleDirectory, moduleFolder } from "~/main/modules/local-library";
import {
  createModulePrivateFiles,
  restrictProgramMounts,
} from "~/main/modules/runtime/private-files";
import { checkSqlite, snapshotSqlite } from "~/main/modules/runtime/sqlite";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

const MODULE = "1f0c9a52-6f0e-4a83-9d62-2a7d0c3b5e11";
const id = installationIdSchema.parse(MODULE);

async function setup() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "works-private-files-"))
  );
  directories.push(root);
  const legacy = path.join(root, ".data", moduleDirectory(MODULE));
  const state = path.join(
    root,
    ".library",
    "data-moves",
    `${moduleDirectory(MODULE)}.json`
  );
  const open = (
    checkDatabase = checkSqlite,
    installationFiles?: typeof createModuleInstallationFiles
  ) =>
    createModulePrivateFiles({
      checkDatabase,
      ...(installationFiles ? { installationFiles } : {}),
      root,
      snapshotDatabase: snapshotSqlite,
    });
  return {
    folder: moduleFolder(root, MODULE),
    legacy,
    open,
    root,
    state,
  };
}

async function legacyFiles(legacy: string) {
  await mkdir(path.join(legacy, "uploads"), { recursive: true });
  const database = new DatabaseSync(path.join(legacy, "data.sqlite"));
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA wal_autocheckpoint = 0");
  database.exec("CREATE TABLE notes (body TEXT)");
  database.prepare("INSERT INTO notes (body) VALUES (?)").run("first");
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  await snapshotSqlite(
    path.join(legacy, "data.sqlite"),
    path.join(legacy, "data.sqlite.bak")
  );
  database.prepare("INSERT INTO notes (body) VALUES (?)").run("second");
  const crashed = path.join(legacy, "..", "crashed");
  await mkdir(crashed);
  for (const name of ["data.sqlite", "data.sqlite-wal"]) {
    await copyFile(path.join(legacy, name), path.join(crashed, name));
  }
  database.close();
  for (const name of ["data.sqlite", "data.sqlite-wal"]) {
    await copyFile(path.join(crashed, name), path.join(legacy, name));
  }
  await rm(crashed, { recursive: true });
  await writeFile(path.join(legacy, "uploads", "photo.txt"), "app file");
}

function notes(file: string) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return database
      .prepare("SELECT body FROM notes ORDER BY rowid")
      .all()
      .map((row) => row.body);
  } finally {
    database.close();
  }
}

describe("legacy private data requires offline recovery", () => {
  it("refuses handover with an old SQLite writer, preserving its later committed rows", async () => {
    const { folder, legacy, root, state } = await setup();
    await mkdir(legacy, { recursive: true });
    const writer = new DatabaseSync(path.join(legacy, "data.sqlite"));
    writer.exec(
      "CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('before')"
    );
    const snapshot = vi.fn(snapshotSqlite);
    const files = createModulePrivateFiles({
      checkDatabase: checkSqlite,
      root,
      snapshotDatabase: snapshot,
    });
    try {
      for (const action of [
        () =>
          files.prepare({ installationId: id, persistence: "installation" }),
        () => files.backup(id),
        () => files.restoreBackup(id),
        () => files.discardBackup(id),
      ]) {
        await expect(action()).rejects.toThrow("requires offline recovery");
      }
      writer.exec("INSERT INTO notes VALUES ('after refusal')");
      expect(notes(path.join(legacy, "data.sqlite"))).toEqual([
        "before",
        "after refusal",
      ]);
      expect(snapshot).not.toHaveBeenCalled();
      await expect(readdir(folder.data)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(state)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      writer.close();
    }
  });

  it.each(["copying", "adopting", "done"])(
    "never trusts a %s journal over existing legacy data",
    async (status) => {
      const { folder, legacy, open, state } = await setup();
      await legacyFiles(legacy);
      await mkdir(folder.data, { recursive: true });
      await writeFile(path.join(folder.data, "data.sqlite"), "newer copy");
      await mkdir(path.dirname(state), { recursive: true });
      const journal = JSON.stringify({ format: "works.data-move/1", status });
      await writeFile(state, journal);
      const before = await readFile(path.join(legacy, "data.sqlite"));
      await expect(
        open().prepare({ installationId: id, persistence: "installation" })
      ).rejects.toThrow("requires offline recovery");
      expect(await readFile(path.join(legacy, "data.sqlite"))).toEqual(before);
      expect(
        await readFile(path.join(folder.data, "data.sqlite"), "utf8")
      ).toBe("newer copy");
      expect(await readFile(state, "utf8")).toBe(journal);
    }
  );

  it("refuses to adopt staging even when the original path is absent", async () => {
    const { folder, open, state } = await setup();
    const staging = path.join(folder.root, ".data-moving");
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, "keep.txt"), "unreconciled");
    await mkdir(path.dirname(state), { recursive: true });
    await writeFile(
      state,
      JSON.stringify({ format: "works.data-move/1", status: "adopting" })
    );
    await expect(
      open().prepare({ installationId: id, persistence: "installation" })
    ).rejects.toThrow("requires offline recovery");
    expect(await readFile(path.join(staging, "keep.txt"), "utf8")).toBe(
      "unreconciled"
    );
    await expect(readdir(folder.data)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("retries only after offline WAL-aware recovery, keeping the original as a recovery copy", async () => {
    const { folder, legacy, open, root } = await setup();
    await legacyFiles(legacy);
    const files = open();
    await expect(
      files.prepare({ installationId: id, persistence: "installation" })
    ).rejects.toThrow("requires offline recovery");
    const recovery = path.join(root, "offline-recovery");
    await rename(legacy, recovery);
    await mkdir(folder.data, { recursive: true });
    await snapshotSqlite(
      path.join(recovery, "data.sqlite"),
      path.join(folder.data, "data.sqlite")
    );
    await copyFile(
      path.join(recovery, "data.sqlite.bak"),
      path.join(folder.data, "data.sqlite.bak")
    );
    await cp(
      path.join(recovery, "uploads"),
      path.join(folder.data, "uploads"),
      { recursive: true }
    );
    expect(
      await files.prepare({ installationId: id, persistence: "installation" })
    ).toMatchObject({ hostPath: folder.data });
    expect(notes(path.join(folder.data, "data.sqlite"))).toEqual([
      "first",
      "second",
    ]);
    expect(notes(path.join(recovery, "data.sqlite"))).toEqual([
      "first",
      "second",
    ]);
    expect(
      await readFile(path.join(folder.data, "uploads", "photo.txt"), "utf8")
    ).toBe("app file");
  });

  it("preserves a recovered database when validation fails and retries without cached admission", async () => {
    const { folder, open } = await setup();
    await legacyFiles(folder.data);
    const before = await readFile(path.join(folder.data, "data.sqlite"));
    const check = vi
      .fn(checkSqlite)
      .mockRejectedValueOnce(new Error("database check failed"));
    const files = open(check);
    await expect(
      files.prepare({ installationId: id, persistence: "installation" })
    ).rejects.toThrow("database check failed");
    expect(await readFile(path.join(folder.data, "data.sqlite"))).toEqual(
      before
    );
    expect(
      await files.prepare({ installationId: id, persistence: "installation" })
    ).toMatchObject({ hostPath: folder.data });
  });

  it("rechecks legacy data even after an earlier prepare succeeded", async () => {
    const { legacy, open } = await setup();
    const files = open();
    await files.prepare({ installationId: id, persistence: "installation" });
    await legacyFiles(legacy);
    await expect(
      files.prepare({ installationId: id, persistence: "installation" })
    ).rejects.toThrow("requires offline recovery");
    expect(notes(path.join(legacy, "data.sqlite"))).toEqual([
      "first",
      "second",
    ]);
  });
});

it("gives a Version whose files are not kept a disposable directory, removed after its stop", async () => {
  const { folder, open, root } = await setup();
  await legacyFiles(folder.data);
  const files = open();
  const prepared = await files.prepare({
    installationId: id,
    persistence: "none",
  });
  const disposableRoot = path.join(root, ".library", "disposable");
  const disposable = prepared.hostPath;
  expect([
    path.join(disposableRoot, moduleDirectory(MODULE)),
    path.join(disposableRoot, ".ephemeral", moduleDirectory(MODULE)),
  ]).toContain(disposable);
  expect(await readdir(disposable)).toEqual([]);
  await writeFile(path.join(disposable, "scratch.txt"), "temporary");
  const kept = (await readdir(folder.data)).sort();
  await files.release(id);
  await files.stopped(id);
  await expect(readdir(disposable)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readdir(folder.data)).sort()).toEqual(kept);

  await files.prepare({ installationId: id, persistence: "installation" });
  await files.stopped(id);
  expect((await readdir(folder.data)).sort()).toEqual(kept);
});

describe("Program mounts", () => {
  async function mounts() {
    const { folder, open, root } = await setup();
    const files = open();
    for (const directory of [folder.source, folder.artifact, folder.data]) {
      await mkdir(directory, { recursive: true });
    }
    const runtime = createFakeContainerRuntime();
    const containers = restrictProgramMounts(
      createContainers({
        allowedMountRoots: [root],
        instanceLabel: "private-files-test",
        mountTargetRoot: "/foundry",
        runtime,
        store: new MemoryContainerStore(),
      }),
      files
    );
    const spec = (
      program: { source: string; access: "read-only" | "read-write" },
      data: { source: string; access: "read-only" | "read-write" }
    ): ContainerSandboxConstraints => ({
      format: "foundry.sandbox.container/1",
      image: "docker.io/oven/bun:1-slim",
      labels: { "com.foundry.installation": id },
      mounts: [
        { id: "program", target: "/foundry/program", ...program },
        { id: "installation-files", target: "/foundry/files", ...data },
      ],
      network: "disabled",
    });
    return { containers, folder, spec };
  }

  it("mounts artifact/ read-only and data/ read-write", async () => {
    const { containers, folder, spec } = await mounts();
    const container = await containers.start(
      spec(
        { access: "read-only", source: folder.artifact },
        { access: "read-write", source: folder.data }
      )
    );
    expect(
      ((await container.volumes?.list()) ?? []).map((mount) => [
        mount.target,
        mount.access,
      ])
    ).toEqual([
      ["/foundry/program", "read-only"],
      ["/foundry/files", "read-write"],
    ]);
    await container.close();
  });

  it("refuses source/, the Module folder and any other access", async () => {
    const { containers, folder, spec } = await mounts();
    const refused = [
      spec(
        { access: "read-only", source: folder.source },
        { access: "read-write", source: folder.data }
      ),
      spec(
        { access: "read-only", source: folder.artifact },
        { access: "read-write", source: folder.source }
      ),
      spec(
        { access: "read-only", source: folder.artifact },
        { access: "read-write", source: folder.root }
      ),
      spec(
        { access: "read-write", source: folder.artifact },
        { access: "read-write", source: folder.data }
      ),
      spec(
        { access: "read-only", source: folder.artifact },
        { access: "read-only", source: folder.data }
      ),
    ];
    for (const constraints of refused) {
      await expect(containers.start(constraints)).rejects.toThrow(
        "may mount only its artifact folder read-only and its data folder read-write"
      );
    }
    expect(await containers.list()).toEqual([]);
  });
});

function ephemeralStore(
  outside?: string
): typeof createModuleInstallationFiles {
  return (options) => {
    const store = createModuleInstallationFiles(options);
    return {
      ...store,
      async prepare(input) {
        if (input.persistence !== "none") {
          return await store.prepare(input);
        }
        const hostPath =
          outside ??
          path.join(
            path.resolve(options.root),
            ".ephemeral",
            input.installationId
          );
        await rm(hostPath, { force: true, recursive: true });
        await mkdir(hostPath, { mode: 0o700, recursive: true });
        return { hostPath, installationId: input.installationId };
      },
    };
  };
}

describe("Program mounts of disposable files", () => {
  const OTHER = "2a1d8b63-7f1e-4b94-8e73-3b8e1d4c6f22";

  async function programMounts(
    installationFiles?: typeof createModuleInstallationFiles
  ) {
    const { folder, open, root } = await setup();
    const files = open(checkSqlite, installationFiles);
    for (const directory of [folder.artifact, folder.data]) {
      await mkdir(directory, { recursive: true });
    }
    const containers = restrictProgramMounts(
      createContainers({
        allowedMountRoots: [root],
        instanceLabel: "private-files-test",
        mountTargetRoot: "/foundry",
        runtime: createFakeContainerRuntime(),
        store: new MemoryContainerStore(),
      }),
      files
    );
    const start = (source: string) =>
      containers.start({
        format: "foundry.sandbox.container/1",
        image: "docker.io/oven/bun:1-slim",
        labels: { "com.foundry.installation": id },
        mounts: [
          {
            access: "read-only",
            id: "program",
            source: folder.artifact,
            target: "/foundry/program",
          },
          {
            access: "read-write",
            id: "installation-files",
            source,
            target: "/foundry/files",
          },
        ],
        network: "disabled",
      });
    const admits = async (source: string) => {
      await (await start(source)).close();
    };
    const refuses = async (source: string) => {
      await mkdir(source, { recursive: true });
      await expect(start(source)).rejects.toThrow(
        "may mount only its artifact folder read-only and its data folder read-write"
      );
    };
    const disposableRoot = path.join(root, ".library", "disposable");
    return { admits, disposableRoot, files, folder, refuses };
  }

  it("mounts only the disposable directory a `none` Version prepared (this checkout's store)", async () => {
    const { admits, disposableRoot, files, folder, refuses } =
      await programMounts();
    const directory = moduleDirectory(MODULE);
    await refuses(path.join(disposableRoot, directory));
    const prepared = await files.prepare({
      installationId: id,
      persistence: "none",
    });
    expect(prepared.hostPath).toBe(
      path.join(disposableRoot, ".ephemeral", directory)
    );
    await admits(prepared.hostPath);
    await refuses(folder.data);
    await refuses(path.join(disposableRoot, ".backups", directory));
    await refuses(path.join(disposableRoot, moduleDirectory(OTHER)));
    await refuses(disposableRoot);
    await files.stopped(id);
    await refuses(path.join(disposableRoot, directory));
  });

  it("mounts the exact `.ephemeral` directory the newer store prepares, and none of its other paths", async () => {
    const { admits, disposableRoot, files, folder, refuses } =
      await programMounts(ephemeralStore());
    const directory = moduleDirectory(MODULE);
    const prepared = await files.prepare({
      installationId: id,
      persistence: "none",
    });
    expect(prepared.hostPath).toBe(
      path.join(disposableRoot, ".ephemeral", directory)
    );
    await admits(prepared.hostPath);
    await refuses(folder.data);
    await refuses(path.join(disposableRoot, directory));
    await refuses(path.join(disposableRoot, ".backups", directory));
    await refuses(
      path.join(disposableRoot, ".ephemeral", moduleDirectory(OTHER))
    );
    await refuses(path.join(disposableRoot, ".ephemeral"));
  });

  it("refuses disposable files a store prepared anywhere else", async () => {
    const outside = await realpath(
      await mkdtemp(path.join(tmpdir(), "works-outside-"))
    );
    directories.push(outside);
    const { files } = await programMounts(ephemeralStore(outside));
    await expect(
      files.prepare({ installationId: id, persistence: "none" })
    ).rejects.toThrow("prepared outside their directory");
  });
});
