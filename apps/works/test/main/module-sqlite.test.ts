import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { installationIdSchema } from "@foundry/modules/domain";
import { createModuleInstallationFiles } from "@foundry/modules/node/installation-files";
import { afterEach, expect, it } from "vitest";
import { snapshotSqlite } from "~/main/modules/runtime/sqlite";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

it("backs up a Module's WAL database before a Version change", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "works-sqlite-"));
  directories.push(root);
  const id = installationIdSchema.parse("notes");
  await mkdir(path.join(root, id), { recursive: true });
  const database = new DatabaseSync(path.join(root, id, "data.sqlite"));
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("CREATE TABLE notes (body TEXT)");
  database.prepare("INSERT INTO notes (body) VALUES (?)").run("kept");
  database.close();

  const files = createModuleInstallationFiles({
    root,
    snapshotDatabase: snapshotSqlite,
  });
  await files.backup(id);
  const copy = new DatabaseSync(path.join(root, id, "data.sqlite.bak"), {
    readOnly: true,
  });
  try {
    expect(copy.prepare("SELECT body FROM notes").all()).toEqual([
      { body: "kept" },
    ]);
  } finally {
    copy.close();
  }
});
