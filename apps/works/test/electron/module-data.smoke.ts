import assert from "node:assert/strict";
import { copyFileSync, watch } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readJsonFile } from "@foundry/lib/atomic-file";
import { ModelManager } from "@foundry.sh/marbles/engine";
import { protocol } from "electron";
import { moduleDirectory, moduleFolder } from "~/main/modules/local-library";
import {
  registerModuleProtocol,
  registerModuleScheme,
} from "~/main/modules/runtime/protocol";
import { checkSqlite, snapshotSqlite } from "~/main/modules/runtime/sqlite";
import { systemTheme } from "~/main/system/theme";
import { composeWorks, type Works } from "~/main/works";
import type { ModuleSourceRevision } from "~/shared/modules";
import { openAppWindow } from "../helpers/app-window";
import { runElectronSmoke } from "../helpers/electron";
import { smokeWorks } from "../helpers/smoke-works";

registerModuleScheme();

const APP = "packages/app/src/App.tsx";
const NAME = "Data journey";
const DATABASE = "data.sqlite";
const BACKUP = "data.sqlite.bak";
const OFFLINE_RECOVERY = /requires offline recovery/;

async function build(
  works: Works,
  moduleId: string,
  tag: string,
  binding: ModuleSourceRevision
) {
  for await (const event of works.rpc.builds.watch(moduleId, tag, binding)) {
    if (event.phase === "failed") {
      throw new Error(`Build ${tag} failed: ${event.message}`);
    }
    if (event.phase === "complete") {
      return event;
    }
  }
  throw new Error(`Build ${tag} ended without a result`);
}

async function compose(userData: string): Promise<Works> {
  const works = systemTheme.snapshot()
    ? await composeWorks({
        artifactRoot: path.join(userData, "foundry", "artifacts"),
        models: new ModelManager(),
        moduleRoot: path.join(userData, "foundry", "modules"),
        print: (line) => process.stderr.write(`${line}\n`),
        routes: {
          route: () => {
            throw new Error("No models in this smoke");
          },
        },
        theme: systemTheme,
        userData,
      })
    : await smokeWorks(userData);
  if (protocol.isProtocolHandled("module-app")) {
    protocol.unhandle("module-app");
  }
  registerModuleProtocol(works.rpc.sessions);
  return works;
}

function notesOf(result: unknown): string[] {
  const notes =
    result && typeof result === "object" && "data" in result
      ? (result.data as { notes?: { body: string }[] } | null)?.notes
      : undefined;
  if (!notes) {
    throw new Error(`Unexpected GraphQL answer: ${JSON.stringify(result)}`);
  }
  return notes.map((note) => note.body).sort();
}

function notesIn(file: string): string[] {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return database
      .prepare("SELECT body FROM notes")
      .all()
      .map((row) => String(row.body))
      .sort();
  } finally {
    database.close();
  }
}

function catchBackup(directory: string, copy: string) {
  let caught = false;
  const watcher = watch(directory, (_event, name) => {
    if (caught || name !== BACKUP) {
      return;
    }
    try {
      copyFileSync(path.join(directory, BACKUP), copy);
      caught = true;
    } catch {
      // Renamed in but not readable yet, or already gone: wait for the next event.
    }
  });
  return {
    get caught() {
      return caught;
    },
    stop: () => watcher.close(),
  };
}

async function exists(file: string) {
  return (await lstat(file).catch(() => undefined)) !== undefined;
}

async function smoke(userData: string) {
  const report: string[] = [];
  const note = (line: string) => {
    report.push(line);
    process.stdout.write(`  ${line}\n`);
  };
  const moduleRoot = path.join(userData, "foundry", "modules");
  let works = await compose(userData);
  let open = true;
  try {
    const module = await works.rpc.modules.create(NAME);
    const folder = moduleFolder(moduleRoot, module.id);
    const initial = await works.rpc.modules.details(module.id);
    assert.ok(initial?.binding);
    const first = await build(works, module.id, "0.1.0", initial.binding);
    const v1 = first.release.contentId;

    let app = await openAppWindow(works.rpc.sessions, module.id, v1);
    try {
      for (const body of ["First note", "Second note"]) {
        await app.graphql(
          `mutation { insertIntoNotesSingle(values: { body: ${JSON.stringify(body)} }) { body } }`
        );
      }
      assert.deepEqual(notesOf(await app.graphql("query { notes { body } }")), [
        "First note",
        "Second note",
      ]);
    } finally {
      await app.close();
    }
    const written = await readdir(folder.data);
    note(`v1 wrote two rows; data/ holds ${written.sort().join(", ")}`);

    const edited = await works.rpc.modules.details(module.id);
    assert.ok(edited?.binding);
    const editedApp = edited.source[APP];
    assert.ok(editedApp);
    const source = {
      ...edited.source,
      [APP]: editedApp.replace(JSON.stringify(NAME), '"Data journey v2"'),
    };
    const binding = await works.rpc.modules.saveSource(
      module.id,
      source,
      edited.binding
    );
    const second = await build(works, module.id, "0.1.1", binding);
    const v2 = second.release.contentId;

    const toV2 = catchBackup(folder.data, path.join(userData, "to-v2.bak"));
    app = await openAppWindow(works.rpc.sessions, module.id, v2);
    try {
      toV2.stop();
      assert.equal(await app.heading(), "Data journey v2");
      assert.deepEqual(notesOf(await app.graphql("query { notes { body } }")), [
        "First note",
        "Second note",
      ]);
      await app.graphql(
        'mutation { insertIntoNotesSingle(values: { body: "Third note" }) { body } }'
      );
    } finally {
      toV2.stop();
      await app.close();
    }
    assert.ok(toV2.caught, "No backup appeared during the switch to v2");
    assert.deepEqual(notesIn(path.join(userData, "to-v2.bak")), [
      "First note",
      "Second note",
    ]);
    assert.equal(await exists(path.join(folder.data, BACKUP)), false);
    note(
      "switch v1 → v2: rows kept; the VACUUM INTO backup held both rows and was discarded after the start succeeded"
    );

    const toV1 = catchBackup(folder.data, path.join(userData, "to-v1.bak"));
    app = await openAppWindow(works.rpc.sessions, module.id, v1);
    try {
      toV1.stop();
      assert.equal(await app.heading(), NAME);
      assert.deepEqual(notesOf(await app.graphql("query { notes { body } }")), [
        "First note",
        "Second note",
        "Third note",
      ]);
    } finally {
      toV1.stop();
      await app.close();
    }
    assert.ok(toV1.caught, "No backup appeared during the switch back to v1");
    assert.deepEqual(notesIn(path.join(userData, "to-v1.bak")), [
      "First note",
      "Second note",
      "Third note",
    ]);
    note(
      "switch v2 → v1: rows kept, including the one v2 wrote; a fresh backup held all three"
    );

    open = false;
    await works.close();
    const legacy = path.join(moduleRoot, ".data", moduleDirectory(module.id));
    const staging = path.join(userData, "wal-staging");
    await mkdir(legacy, { recursive: true });
    await mkdir(staging);
    for (const name of await readdir(folder.data)) {
      await rename(path.join(folder.data, name), path.join(staging, name));
    }
    await rm(folder.data, { recursive: true });
    const database = new DatabaseSync(path.join(staging, DATABASE));
    try {
      database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
      database
        .prepare("INSERT INTO notes (body) VALUES (?)")
        .run("Only in the WAL");
      for (const name of await readdir(staging)) {
        await copyFile(path.join(staging, name), path.join(legacy, name));
      }
    } finally {
      database.close();
    }
    const seeded = (await readdir(legacy)).sort();
    assert.ok(seeded.includes(`${DATABASE}-wal`));
    assert.ok((await lstat(path.join(legacy, `${DATABASE}-wal`))).size > 0);
    note(`seeded .data/${moduleDirectory(module.id)}/: ${seeded.join(", ")}`);

    works = await compose(userData);
    open = true;
    await assert.rejects(
      openAppWindow(works.rpc.sessions, module.id, v1),
      OFFLINE_RECOVERY
    );
    assert.equal(await exists(legacy), true);
    assert.equal(await exists(folder.data), false);
    await works.close();
    open = false;
    const recovery = path.join(userData, "legacy-data-recovery");
    await rename(legacy, recovery);
    await mkdir(folder.data, { recursive: true });
    await snapshotSqlite(
      path.join(recovery, DATABASE),
      path.join(folder.data, DATABASE)
    );
    for (const name of await readdir(recovery)) {
      if (![DATABASE, `${DATABASE}-wal`, `${DATABASE}-shm`].includes(name)) {
        await copyFile(path.join(recovery, name), path.join(folder.data, name));
      }
    }
    await checkSqlite(path.join(folder.data, DATABASE));
    works = await compose(userData);
    open = true;
    app = await openAppWindow(works.rpc.sessions, module.id, v1);
    try {
      assert.deepEqual(notesOf(await app.graphql("query { notes { body } }")), [
        "First note",
        "Only in the WAL",
        "Second note",
        "Third note",
      ]);
    } finally {
      await app.close();
    }
    assert.equal(await exists(legacy), false);
    assert.equal(await exists(path.join(folder.root, ".data-moving")), false);
    assert.deepEqual(
      await readJsonFile(
        path.join(
          moduleRoot,
          ".library",
          "data-moves",
          `${moduleDirectory(module.id)}.json`
        )
      ),
      undefined
    );
    assert.equal(await exists(path.join(recovery, DATABASE)), true);
    assert.deepEqual(notesIn(path.join(folder.data, DATABASE)), [
      "First note",
      "Only in the WAL",
      "Second note",
      "Third note",
    ]);
    note(
      `automatic adoption refused; offline recovery into data/ (${(await readdir(folder.data)).sort().join(", ")}) kept the original at ${recovery}, and the Program reopened all four rows`
    );
    process.stdout.write(
      `Electron data journeys passed (Electron ${process.versions.electron}, Node ${process.versions.node}, SQLite ${process.versions.sqlite}, ${report.length} checks)\n`
    );
  } finally {
    if (open) {
      await works.close();
    }
  }
}

runElectronSmoke("module data", smoke);
