import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Artifacts } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import { describe, expect, it } from "vitest";
import type { ResourceCommandContext } from "~/cli/resources/commands";
import { getResource, listResources } from "~/cli/resources/commands";
import { artifactBlobs } from "~/database/local-artifacts";
import { initializeDatabase } from "~/database/open";
import { stateDatabase } from "~/layout";
import { ResourceAssociationError } from "~/lib/resources";
import { workspaceState } from "~/lib/state/workspace";
import { cliArgs } from "./helpers/cli";
import { touchWorkspace } from "./helpers/registry";
import { seedRuns } from "./helpers/stored-runs";
import { temporaryDirectory } from "./helpers/temporary";

const RUN_LINE = /^rn-1 {2}guides {2}\[complete\]/;

async function machine() {
  const home = await realpath(temporaryDirectory("marbles-resource-cli-"));
  const state = join(home, "marbles");
  const artifacts = join(home, "artifacts");
  const one = workspaceState(state, mkdirAt(join(home, "one")));
  const two = workspaceState(state, mkdirAt(join(home, "two")));
  await touchWorkspace(state, one, null);
  await touchWorkspace(state, two, null);
  const opened = await initializeDatabase(stateDatabase(state));
  const notes = await new Artifacts({
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
  it("lists and gets resources for this workspace, by --workspace id or path, and with --all", async () => {
    const { context, notes, one, two } = await machine();
    const first = context(one);
    await listResources("artifact", { all: false }, first.context);
    expect(first.lines).toEqual([
      expect.stringMatching(`^${notes.id}  notes  text/markdown  \\[`),
    ]);
    await listResources("run", { all: false }, first.context);
    expect(first.lines.at(-1)).toMatch(RUN_LINE);

    const second = context(two);
    await listResources("artifact", { all: false }, second.context);
    await listResources("run", { all: false }, second.context);
    expect(second.lines).toEqual([]);

    await listResources(
      "artifact",
      { all: false, workspace: one.id },
      second.context
    );
    expect(second.lines).toEqual([
      expect.stringMatching(`^${notes.id}  notes  text/markdown  \\[`),
    ]);

    const byPath = context(two);
    await getResource(
      "artifact",
      notes.id,
      { all: false, workspace: one.root },
      byPath.context
    );
    expect(byPath.lines).toContain(`id: ${notes.id}`);
    expect(byPath.lines).toContain("name: notes");

    const allView = context(two);
    await listResources("artifact", { all: true }, allView.context);
    expect(allView.lines).toEqual([
      expect.stringMatching(` {2}from ${one.id}$`),
    ]);
  });

  it("refuses unknown workspaces and missing resource ids", async () => {
    const { context, two } = await machine();
    await expect(
      listResources(
        "artifact",
        { all: false, workspace: "no-such-ws" },
        context(two).context
      )
    ).rejects.toThrow(ResourceAssociationError);
    await expect(
      getResource(
        "artifact",
        "artifact#missing",
        { all: false },
        context(two).context
      )
    ).rejects.toThrow('no artifact "artifact#missing"');
  });
});

describe("the resource commands from the CLI", { timeout: 120_000 }, () => {
  it("lists and gets resources under each resource noun with --workspace, --all, and --json", async () => {
    const { home, notes, one, two } = await machine();
    await writeFile(
      join(one.root, "marbles.ts"),
      'import "@foundry.sh/marbles";\n'
    );
    const marbles = (cwd: string, ...args: string[]) =>
      spawnSync("bun", cliArgs(...args), {
        cwd,
        encoding: "utf8",
        env: { ...process.env, FOUNDRY_ROOT: home },
        input: "",
        timeout: 60_000,
      });

    const listed = marbles(one.root, "artifacts");
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).toContain(`${notes.id}  notes`);
    expect(marbles(two.root, "artifacts", "list", "--all").stdout).toContain(
      notes.id
    );
    expect(
      marbles(two.root, "artifacts", "list", "--workspace", one.id).stdout
    ).toContain(`${notes.id}  notes`);

    const got = marbles(
      two.root,
      "artifacts",
      "get",
      notes.id,
      "--workspace",
      one.id,
      "--json"
    );
    expect(got.status, got.stderr).toBe(0);
    expect(JSON.parse(got.stdout)).toMatchObject({
      id: notes.id,
      name: "notes",
      owner: one.id,
    });

    const runGot = marbles(one.root, "runs", "get", "rn-1");
    expect(runGot.status, runGot.stderr).toBe(0);
    expect(runGot.stdout).toContain("id: rn-1");
    expect(runGot.stdout).toContain("step: guides");

    const wsGot = marbles(one.root, "workspaces", "get", one.id, "--json");
    expect(wsGot.status, wsGot.stderr).toBe(0);
    expect(JSON.parse(wsGot.stdout)).toMatchObject({ id: one.id });

    const missing = marbles(one.root, "runs", "get", "rn-missing");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('no run "rn-missing"');

    for (const removed of ["share", "unshare", "relink"]) {
      const refused = marbles(
        one.root,
        removed,
        "artifact",
        notes.id,
        two.root
      );
      expect(refused.status, removed).toBe(1);
      expect(refused.stderr).toContain(`unknown command "${removed}"`);
    }
  });
});
