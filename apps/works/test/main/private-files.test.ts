import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { installationIdSchema } from "@foundry/modules/domain";
import type { ContainerSandboxConstraints } from "@foundry/sandbox/container/constraints";
import { createContainers } from "@foundry/sandbox/container/containers";
import { createMemoryContainerStore } from "@foundry/sandbox/container/store";
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
  /** One Works process; a second call is a restart. */
  const open = (checkDatabase = checkSqlite) =>
    createModulePrivateFiles({
      checkDatabase,
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

/**
 * Private files as an earlier Works left them: a WAL database whose last
 * write is still only in its `-wal` companion, a backup, and an app file.
 */
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
  // Copy the files while the connection still holds the last write in the
  // WAL, as a stopped Program's crash would leave them.
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

describe("moving private data into the Module's data/", () => {
  it("moves a consistent, checked copy and lets the original go only then", async () => {
    const { folder, legacy, open, state } = await setup();
    await legacyFiles(legacy);
    expect(await readdir(legacy)).toContain("data.sqlite-wal");
    const checked: string[] = [];
    const files = open(async (file) => {
      // The original is still there whenever a copy is checked.
      expect(await readdir(legacy)).toContain("data.sqlite");
      checked.push(path.relative(folder.root, file));
      await checkSqlite(file);
    });

    const prepared = await files.prepare({
      installationId: id,
      persistence: "installation",
    });
    expect(prepared.hostPath).toBe(folder.data);
    // The WAL was folded into the copy, never copied beside it.
    expect((await readdir(folder.data)).sort()).toEqual([
      "data.sqlite",
      "data.sqlite.bak",
      "uploads",
    ]);
    expect(notes(path.join(folder.data, "data.sqlite"))).toEqual([
      "first",
      "second",
    ]);
    expect(notes(path.join(folder.data, "data.sqlite.bak"))).toEqual(["first"]);
    expect(
      await readFile(path.join(folder.data, "uploads", "photo.txt"), "utf8")
    ).toBe("app file");
    // Checked once staged, and again where it now lies.
    expect(checked).toEqual([
      ".data-moving/data.sqlite",
      ".data-moving/data.sqlite.bak",
      "data/data.sqlite",
      "data/data.sqlite.bak",
    ]);
    await expect(readdir(legacy)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(state, "utf8"))).toMatchObject({
      status: "done",
    });
    expect(await readdir(folder.root)).toEqual(["data"]);
  });

  it("leaves the original in use when the copy does not check out, and moves it on retry", async () => {
    const { folder, legacy, open } = await setup();
    await legacyFiles(legacy);
    /** The original's bytes; `-shm` is only SQLite's shared-memory index. */
    const original = async () =>
      Object.fromEntries(
        await Promise.all(
          ["data.sqlite", "data.sqlite-wal", "data.sqlite.bak"].map(
            async (name) => [name, await readFile(path.join(legacy, name))]
          )
        )
      );
    const before = await original();
    const failing = open(() =>
      Promise.reject(new Error("database disk image is malformed"))
    );
    await expect(
      failing.prepare({ installationId: id, persistence: "installation" })
    ).rejects.toThrow("The original was left in place");
    expect(await original()).toEqual(before);
    expect(await readdir(folder.root)).toEqual([]);

    await open().prepare({ installationId: id, persistence: "installation" });
    expect(notes(path.join(folder.data, "data.sqlite"))).toEqual([
      "first",
      "second",
    ]);
  });

  it("finishes an interrupted move after a restart, and only once", async () => {
    const { folder, legacy, open, state } = await setup();
    await legacyFiles(legacy);
    // The placed copy does not reopen at data/: the placement is undone.
    const interrupted = vi.fn(checkSqlite);
    const crashing = open(async (file) => {
      await interrupted(file);
      if (file.endsWith(path.join("data", "data.sqlite"))) {
        throw new Error("Works stopped");
      }
    });
    await expect(
      crashing.prepare({ installationId: id, persistence: "installation" })
    ).rejects.toThrow();
    // The original stays in use, so the next attempt starts from it again.
    expect(await readdir(legacy)).toContain("data.sqlite");

    // A move recorded as being placed is completed by the next process.
    await rm(folder.data, { force: true, recursive: true });
    await mkdir(path.join(folder.root, ".data-moving"), { recursive: true });
    await snapshotSqlite(
      path.join(legacy, "data.sqlite"),
      path.join(folder.root, ".data-moving", "data.sqlite")
    );
    await mkdir(path.dirname(state), { recursive: true });
    await writeFile(
      state,
      JSON.stringify({ format: "works.data-move/1", status: "adopting" })
    );
    const restarted = open();
    await restarted.prepare({
      installationId: id,
      persistence: "installation",
    });
    expect(notes(path.join(folder.data, "data.sqlite"))).toEqual([
      "first",
      "second",
    ]);
    await expect(readdir(legacy)).rejects.toMatchObject({ code: "ENOENT" });

    // Done is done: earlier files appearing again are not moved over data/.
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, "data.sqlite"), "");
    await open().prepare({ installationId: id, persistence: "installation" });
    expect(await readdir(legacy)).toEqual(["data.sqlite"]);
  });

  it("refuses to move into a data/ that already holds files", async () => {
    const { folder, legacy, open } = await setup();
    await legacyFiles(legacy);
    await mkdir(folder.data, { recursive: true });
    await writeFile(path.join(folder.data, "data.sqlite"), "newer");
    await expect(
      open().prepare({ installationId: id, persistence: "installation" })
    ).rejects.toThrow("Both were left untouched");
    expect(await readFile(path.join(folder.data, "data.sqlite"), "utf8")).toBe(
      "newer"
    );
    expect(await readdir(legacy)).toContain("data.sqlite-wal");
  });
});

it("gives a Version whose files are not kept a disposable directory, removed after its stop", async () => {
  const { folder, legacy, open, root } = await setup();
  await legacyFiles(legacy);
  const files = open();
  const prepared = await files.prepare({
    installationId: id,
    persistence: "none",
  });
  const disposable = path.join(
    root,
    ".library",
    "disposable",
    moduleDirectory(MODULE)
  );
  expect(prepared.hostPath).toBe(disposable);
  expect(await readdir(disposable)).toEqual([]);
  await writeFile(path.join(disposable, "scratch.txt"), "temporary");
  // The persistent data still moved, and is not touched.
  const kept = (await readdir(folder.data)).sort();
  await files.release(id);
  expect(await readdir(disposable)).toEqual(["scratch.txt"]);
  await files.stopped(id);
  await expect(readdir(disposable)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readdir(folder.data)).sort()).toEqual(kept);

  // A kept Version is not touched by `stopped`.
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
        store: createMemoryContainerStore(),
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
