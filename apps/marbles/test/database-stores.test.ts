import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactIdSchema } from "@foundry/artifacts";
import { afterEach, describe, expect, it } from "vitest";
import { Catalog } from "~/authoring/catalog";
import { createEngine } from "~/create";
import { workspaceStores } from "~/database/stores";
import type { Engine } from "~/lib/engine";
import { artifactIdFor } from "~/lib/managers/artifacts";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";

/**
 * The Marbles process keeps a workspace's artifacts, sandbox containers and
 * workspace catalogue in the Marbles database, each package's SQLite store
 * scoped by the workspace id; a dry run keeps them in memory and reads what
 * real runs left there.
 */

const machines: TestMachine[] = [];
const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) {
    await engine.dispose();
  }
  for (const machine of machines.splice(0)) {
    machine.close();
  }
});

const NOTES = {
  id: "artifact#notes",
  kind: "artifact",
  name: "notes",
  type: "text/markdown",
} as const;

async function arranged() {
  const machine = await testMachine();
  machines.push(machine);
  const root = await realpath(await mkdtemp(join(tmpdir(), "marbles-root-")));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "a.md"), "# A\n");
  const artifacts = join(machine.root, "artifacts");
  const engine = (dry: boolean, workspaceId = "ws") => {
    const built = createEngine({
      artifacts,
      catalog: new Catalog(),
      database: machine.database.database,
      dry,
      print: () => undefined,
      providers: [],
      root,
      stateRoot: machine.root,
      workspaceId,
    });
    engines.push(built);
    return built;
  };
  return { artifacts, engine, machine, root };
}

describe("an engine with no database handle", () => {
  it("keeps its artifacts in memory, writing nothing to the artifact store", async () => {
    const { artifacts, machine, root } = await arranged();
    const built = createEngine({
      artifacts,
      catalog: new Catalog(),
      dry: false,
      print: () => undefined,
      providers: [],
      root,
      stateRoot: machine.root,
      workspaceId: "ws",
    });
    engines.push(built);
    const engine = await built.start();
    await engine.artifacts.write(NOTES, { "a.md": "# Notes" });
    expect(await (await engine.artifacts.latest(NOTES))?.text("a.md")).toBe(
      "# Notes"
    );
    expect(existsSync(artifacts)).toBe(false);
  });
});

describe("an engine over the Marbles database", () => {
  it("keeps its artifacts' records there under its workspace id, and their bytes in its own blob directory", async () => {
    const { artifacts, engine, machine } = await arranged();
    const real = engine(false);
    const written = await real.artifacts.write(NOTES, { "a.md": "# Notes" });

    const id = artifactIdFor("ws", NOTES.name);
    const stored = workspaceStores(machine.database.database, "ws");
    const record = await stored.artifacts.getArtifact(id);
    expect(record?.contentId).toBe(written.id);
    expect(
      await workspaceStores(
        machine.database.database,
        "other"
      ).artifacts.getArtifact(id)
    ).toBeNull();
    expect(existsSync(join(artifacts, "records.json"))).toBe(false);
    expect(
      readdirSync(join(artifacts, "workspaces", "ws", "blobs")).filter(
        (name) => !name.startsWith(".")
      )
    ).toHaveLength(1);
    const latest = await real.artifacts.latest(NOTES);
    expect(await latest?.text("a.md")).toBe("# Notes");
  });

  it("never shows one workspace another's artifacts", async () => {
    const { engine } = await arranged();
    const created = await engine(false, "ws").artifacts.create({
      entries: { "a.md": "# A" },
      name: "Shared?",
      type: "text/markdown",
    });
    const other = engine(false, "other");
    expect(
      await other.artifacts.get(artifactIdSchema.parse(created.artifactId))
    ).toBeNull();
  });

  it("under dry, writes to memory and reads through to what real runs left there", async () => {
    const { engine, machine } = await arranged();
    await engine(false).artifacts.write(NOTES, { "a.md": "# Real" });

    const dry = engine(true);
    const latest = await dry.artifacts.latest(NOTES);
    expect(await latest?.text("a.md")).toBe("# Real");
    await dry.artifacts.write(NOTES, { "a.md": "# Dry" });
    expect(await (await dry.artifacts.latest(NOTES))?.text("a.md")).toBe(
      "# Dry"
    );
    const stored = await workspaceStores(
      machine.database.database,
      "ws"
    ).artifacts.listContents(artifactIdFor("ws", NOTES.name));
    expect(stored).toHaveLength(1);
  });

  it("keeps its workspace catalogue there under its workspace id", async () => {
    const { engine, machine, root } = await arranged();
    const files = await engine(false).workspaces.current.files();
    expect(files.map((file) => file.path)).toContain("docs/a.md");

    const stored = workspaceStores(machine.database.database, "ws");
    const registration = await stored.workspaces.findWorkspaceByPath(root);
    if (registration === null) {
      throw new Error("the workspace was not registered in the database");
    }
    const entries = await stored.workspaces.listEntries(registration.id);
    expect(entries.map((entry) => entry.path)).toContain("docs/a.md");
    expect(
      await workspaceStores(
        machine.database.database,
        "other"
      ).workspaces.findWorkspaceByPath(root)
    ).toBeNull();
  });

  it("under dry, reads through to nothing for an artifact no run wrote, and makes no directory", async () => {
    const { artifacts, engine } = await arranged();
    expect(await engine(true).artifacts.latest(NOTES)).toBeUndefined();
    expect(existsSync(artifacts)).toBe(false);
  });

  it("keeps nothing there under dry", async () => {
    const { engine, machine, root } = await arranged();
    const dry = engine(true);
    await dry.artifacts.write(NOTES, { "a.md": "# Dry" });
    await dry.workspaces.current.files();

    const stored = workspaceStores(machine.database.database, "ws");
    expect(
      await stored.artifacts.getArtifact(artifactIdFor("ws", NOTES.name))
    ).toBeNull();
    expect(await stored.workspaces.findWorkspaceByPath(root)).toBeNull();
  });
});
