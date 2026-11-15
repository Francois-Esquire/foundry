import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactManager, artifactIdSchema } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import { describe, expect, it } from "vitest";
import { initializeDatabase } from "~/database/open";
import { artifactBlobs } from "~/database/stores";
import { resourceLinks, stateDatabase, workspaceLinks } from "~/layout";
import { ResourceAssociationError } from "~/lib/resources";
import { workspaceState } from "~/lib/state/workspace";
import type { ResourceCommandContext } from "~/resources/commands";
import { changeAssociation, listResources, relink } from "~/resources/commands";
import { LinksPlacementError } from "~/resources/links";
import { touchWorkspace } from "./helpers/registry";
import { seedRuns } from "./helpers/stored-runs";
import { temporaryDirectory } from "./helpers/temporary";

/**
 * The resource commands read through the database's views, change only
 * associations, and make a workspace's links from what its view shows.
 */

const RUN_LINE = /^rn-1 {2}guides {2}\[complete\]/;
const NOT_HERE = /no artifact artifact#missing in this workspace/;

async function machine() {
  const home = await realpath(temporaryDirectory("marbles-resource-cli-"));
  const state = join(home, "marbles");
  const artifacts = join(home, "artifacts");
  const one = workspaceState(state, mkdirAt(join(home, "one")));
  const two = workspaceState(state, mkdirAt(join(home, "two")));
  await touchWorkspace(state, one, null);
  await touchWorkspace(state, two, null);
  const opened = await initializeDatabase(stateDatabase(state));
  const notes = await new ArtifactManager({
    files: blobFiles(artifactBlobs(artifacts, one.id)),
    store: new SqliteArtifactStore({
      database: opened.database,
      scope: one.id,
    }),
  }).create({
    entries: {
      "docs/guide.md": { bytes: "# Guide\n", mime: "text/markdown" },
      "notes.md": { bytes: "# Notes\n", mime: "text/markdown" },
    },
    name: "notes",
    type: "text/markdown",
  });
  opened.close();
  await seedRuns(state, one.id, [
    { createdAt: 1, id: "rn-1", owner: null, status: "complete" },
  ]);
  const context = (workspace: typeof one) => {
    const lines: string[] = [];
    const made: ResourceCommandContext = {
      artifacts,
      directory: home,
      print: (line) => lines.push(line),
      state,
      workspace,
    };
    return { context: made, lines };
  };
  return { artifacts, context, home, notes, one, state, two };
}

function mkdirAt(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

describe("the resource commands", () => {
  it("list what this workspace shows, and with --all every workspace's, marking where each is from", async () => {
    const { context, notes, one, two } = await machine();
    const first = context(one);
    await listResources("artifact", false, first.context);
    expect(first.lines).toEqual([
      expect.stringMatching(`^${notes.id}  notes  text/markdown  \\[`),
    ]);
    await listResources("run", false, first.context);
    expect(first.lines.at(-1)).toMatch(RUN_LINE);
    const second = context(two);
    await listResources("artifact", false, second.context);
    await listResources("run", false, second.context);
    expect(second.lines).toEqual([]);
    await listResources("artifact", true, second.context);
    expect(second.lines).toEqual([
      expect.stringMatching(` {2}from ${one.id}$`),
    ]);
  });

  it("share an artifact with another workspace and link its files there, then take both back, leaving the artifact", async () => {
    const { artifacts, context, home, notes, one, two } = await machine();
    const { context: here, lines } = context(one);
    await changeAssociation(
      "share",
      { id: notes.id, kind: "artifact", with: "two" },
      here
    );
    expect(lines[0]).toBe(
      `shared with ${join(home, "two")}: artifact ${notes.id}`
    );
    const linked = join(
      resourceLinks(two.root, "artifact"),
      encodeURIComponent(notes.id)
    );
    expect(lstatSync(join(linked, "notes.md")).isSymbolicLink()).toBe(true);
    expect(await readFile(join(linked, "docs", "guide.md"), "utf8")).toBe(
      "# Guide\n"
    );
    expect(
      await readFile(join(workspaceLinks(two.root), ".gitignore"), "utf8")
    ).toBe("*\n");
    const there = context(two);
    await listResources("artifact", false, there.context);
    expect(there.lines).toEqual([expect.stringMatching(` {2}from ${one.id}$`)]);

    await changeAssociation(
      "unshare",
      { id: notes.id, kind: "artifact", with: "two" },
      here
    );
    expect(existsSync(linked)).toBe(false);
    const after = context(one);
    await listResources("artifact", false, after.context);
    expect(after.lines).toHaveLength(1);
    // The blob files the links pointed at are the artifact's, and stay.
    expect(
      readdirSync(artifactBlobs(artifacts, one.id)).filter(
        (name) => !name.startsWith(".")
      )
    ).toHaveLength(2);
  });

  it("rebuild a workspace's links from the database, removing stale links and keeping what is not a link", async () => {
    const { context, notes, one } = await machine();
    const dir = resourceLinks(one.root, "artifact");
    mkdirSync(join(dir, "gone"), { recursive: true });
    symlinkSync("/nowhere", join(dir, "gone", "stale.md"));
    await writeFile(join(dir, "mine.txt"), "kept");
    const { context: here, lines } = context(one);
    await relink(false, here);
    expect(existsSync(join(dir, "gone"))).toBe(false);
    expect(await readFile(join(dir, "mine.txt"), "utf8")).toBe("kept");
    expect(
      await readFile(
        join(dir, encodeURIComponent(notes.id), "notes.md"),
        "utf8"
      )
    ).toBe("# Notes\n");
    expect(lines).toEqual([
      `${dir}: 2 linked`,
      "  .marbles/artifacts/mine.txt: not a link, left as it is",
    ]);
  });

  it("link nothing outside the artifacts directory, whatever an artifact's id", async () => {
    const { artifacts, context, one, state } = await machine();
    const opened = await initializeDatabase(stateDatabase(state));
    await new ArtifactManager({
      files: blobFiles(artifactBlobs(artifacts, one.id)),
      store: new SqliteArtifactStore({
        database: opened.database,
        scope: one.id,
      }),
    }).create({
      entries: { "escape.md": { bytes: "# Out\n", mime: "text/markdown" } },
      id: artifactIdSchema.parse(".."),
      name: "dots",
      type: "text/markdown",
    });
    opened.close();
    const { context: here, lines } = context(one);
    await relink(false, here);
    expect(existsSync(join(workspaceLinks(one.root), "escape.md"))).toBe(false);
    expect(lines[0]).toBe(
      `${resourceLinks(one.root, "artifact")}: 2 linked, 1 left unlinked (no one blob file holds it)`
    );
  });

  it("refuse a links directory that is a link, and a resource this workspace does not show", async () => {
    const { context, home, one, two } = await machine();
    symlinkSync(join(home, "two"), workspaceLinks(one.root));
    await expect(relink(false, context(one).context)).rejects.toThrow(
      LinksPlacementError
    );
    await expect(
      changeAssociation(
        "share",
        { id: "artifact#missing", kind: "artifact", with: "one" },
        context(two).context
      )
    ).rejects.toThrow(NOT_HERE);
    await expect(
      changeAssociation(
        "share",
        { id: "x", kind: "artifact", with: "three" },
        context(two).context
      )
    ).rejects.toThrow(ResourceAssociationError);
  });
});
