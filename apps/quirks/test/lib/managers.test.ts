import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactId, ContentId } from "@foundry/artifacts";
import { ArtifactSystem, InMemoryArtifactStore } from "@foundry/artifacts";
import { createContainers } from "@foundry/sandbox/container/containers";
import { createMemoryContainerStore } from "@foundry/sandbox/container/store";
import { createFakeContainerRuntime } from "@foundry/sandbox/testing";
import { WorkspaceSystem } from "@foundry/workspaces";
import { git } from "@foundry/workspaces/git";
import { directory } from "@foundry/workspaces/node";
import { nodeObserver } from "@foundry/workspaces/node/watch";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ManagerArgs } from "~/lib/bindings";
import { artifactIdFor, artifactsManager } from "~/lib/managers/artifacts";
import {
  allowedMountRoots,
  constraintsFor,
  sandboxesManager,
} from "~/lib/managers/sandboxes";
import { skillResolver } from "~/lib/managers/skills";
import { repositoryRoot, workspacesManager } from "~/lib/managers/workspaces";
import { skills } from "~/lib/resources";
import { current, RunScope, runs } from "~/lib/run-scope";
import { seedRepository } from "./../helpers/repository";

const NOT_A_REPOSITORY = /not a git repository/;
const UNKNOWN_SKILL = /unknown skill nope/;
const FILES_UNSUPPORTED = /not supported yet/;

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "quirks-managers-"));
});

afterEach(async () => {
  runs.clear();
  await rm(tmp, { force: true, recursive: true });
});

function args(cwd = tmp): ManagerArgs & { readonly written: unknown[] } {
  const scope = new RunScope(`run-${Math.random()}`, cwd);
  const frame = scope.frame(["root"]);
  const written: unknown[] = [];
  return { cwd, frame, scope, write: (value) => written.push(value), written };
}

async function skill(dir: string, name: string, description = name) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nUse ${name}.\n`
  );
}

describe("skills", () => {
  it("loads global and workspace skills, adds globs, and picks by name", async () => {
    const home = join(tmp, "home");
    const workspace = join(tmp, "ws");
    await skill(join(home, ".foundry", "skills", "caveman"), "caveman");
    await skill(join(workspace, "skills", "unslop"), "unslop");
    await skill(join(workspace, "extra", "review", "deep"), "deep-review");
    await mkdir(join(workspace, "extra", "review", "notes"), {
      recursive: true,
    });
    const resolve = skillResolver({
      global: join(home, ".foundry", "skills"),
      workspace,
    });

    const names = async (set: Parameters<typeof resolve>[0]) =>
      (await resolve(set)).map((entry) => entry.name).sort();

    await expect(names(undefined)).resolves.toEqual([]);
    await expect(names(skills.load())).resolves.toEqual(["caveman", "unslop"]);
    await expect(names(skills.load().add("./extra/review/*"))).resolves.toEqual(
      ["caveman", "deep-review", "unslop"]
    );
    await expect(
      names(skills.load().add("extra/**").pick("deep-review", "caveman"))
    ).resolves.toEqual(["caveman", "deep-review"]);
    await expect(names(skills.load().pick("nope"))).rejects.toThrow(
      UNKNOWN_SKILL
    );
    const loaded = await resolve(skills.load());
    expect(loaded.find((entry) => entry.name === "unslop")?.instructions).toBe(
      "Use unslop."
    );
  });
});

describe("workspaces", () => {
  it("exposes the config directory as current, with files and git", async () => {
    const repo = await seedRepository();
    const catalogue = new WorkspaceSystem().extend(
      directory({ observer: nodeObserver }),
      git()
    );
    try {
      const manager = workspacesManager({ catalogue, root: repo });
      const a = args(repo);
      const workspaces = manager(a);
      expect(workspaces.current.root).toBe(repo);
      await expect(workspaces.current.files()).resolves.toContain("README.md");
      expect(repositoryRoot(join(repo, "nested", "deeper"))).toBe(repo);

      const seen: string[] = [];
      await current.run({ cwd: repo, frame: a.frame, scope: a.scope }, () =>
        workspaces.current.git.withWorktree({ base: "main" }, (worktree) => {
          seen.push(current.getStore()?.cwd ?? "");
          return Promise.resolve(worktree.root);
        })
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]).not.toBe(repo);
      expect(current.getStore()).toBeUndefined();

      const other = await workspaces.load({ path: repo });
      expect(other.root).toBe(realpathSync(repo));
      expect(other.git).toBeDefined();
    } finally {
      await catalogue.closeAll();
      await rm(repo, { force: true, recursive: true });
    }
  });

  it("refuses git outside a repository with a clear message", () => {
    const catalogue = new WorkspaceSystem().extend(
      directory({ observer: nodeObserver }),
      git()
    );
    const workspaces = workspacesManager({ catalogue, root: tmp })(args());
    expect(() => workspaces.current.git).toThrow(NOT_A_REPOSITORY);
  });
});

describe("artifacts", () => {
  it("keeps a declared artifact's identity and adds a version per write", async () => {
    const system = new ArtifactSystem({ store: new InMemoryArtifactStore() });
    const manager = artifactsManager({ artifacts: system, workspaceId: "ws" });
    const report = {
      id: "artifact#1",
      kind: "artifact",
      name: "Weekly",
      type: "text/markdown",
    } as const;
    const a = args();
    const artifacts = manager(a);

    const first = await artifacts.write(report, { "report.md": "# one\n" });
    expect(first.artifactId).toBe(artifactIdFor("ws", "Weekly"));

    const b = args();
    const second = await manager(b).write(report, { "report.md": "# two\n" });
    expect(second.artifactId).toBe(first.artifactId);
    expect(second.contentId).not.toBe(first.contentId);
    const stored = await system.get(first.artifactId as ArtifactId);
    expect(stored?.content?.id).toBe(second.contentId);
    const file = await system.readFile(
      second.contentId as ContentId,
      "report.md"
    );
    expect(new TextDecoder().decode(file?.blob)).toBe("# two\n");

    // A replay of the same body returns the recorded version, no new write.
    await a.scope.enter(a.frame);
    const replayed = await artifacts.write(report, { "report.md": "# x\n" });
    expect(replayed).toEqual(first);

    const fresh = await artifacts.create({
      entries: { "index.html": "<p>hi</p>" },
      name: "Prototype",
      type: "text/html",
    });
    expect(fresh.artifactId).not.toBe(first.artifactId);
  });
});

describe("sandboxes", () => {
  it("translates a definition into constraints with the fixed mount policy", async () => {
    const home = join(tmp, "home");
    await mkdir(join(home, ".claude"), { recursive: true });
    const root = join(tmp, "project");
    await mkdir(root, { recursive: true });
    const site = {
      id: "workspace#1",
      kind: "workspace",
      path: "../site",
    } as const;
    await mkdir(join(tmp, "site"), { recursive: true });

    const plain = constraintsFor({ image: "img:1" }, root, home);
    expect(plain).toEqual({
      format: "foundry.sandbox.container/1",
      image: "img:1",
      mounts: [
        {
          access: "read-write",
          id: "workspace",
          source: root,
          target: "/workspace",
        },
        {
          access: "read-only",
          id: "claude",
          source: join(home, ".claude"),
          target: "/root/.claude",
        },
      ],
      workdir: "/workspace",
    });
    const sized = constraintsFor(
      { image: "img:1", mount: site, resources: { cpus: 2 } },
      root,
      home
    );
    expect(sized.mounts?.[0]?.source).toBe(join(tmp, "site"));
    expect(sized.resources).toEqual({ cpus: 2 });
    // Only host folders that exist are allowed; the registry canonicalizes them.
    expect(allowedMountRoots([root, join(tmp, "site")], home)).toEqual([
      root,
      join(tmp, "site"),
      join(home, ".claude"),
    ]);
  });

  it("starts containers, runs commands, closes with the run, and reopens on replay", async () => {
    const root = join(tmp, "project");
    const home = join(tmp, "home");
    await mkdir(root, { recursive: true });
    await mkdir(home, { recursive: true });
    const commands: string[][] = [];
    const runtime = createFakeContainerRuntime({
      exec: (command) => {
        commands.push([...command]);
        return { exitCode: 0, stderr: "", stdout: `ran ${command.join(" ")}` };
      },
    });
    const containers = createContainers({
      allowedMountRoots: allowedMountRoots([root], home),
      instanceLabel: "test",
      runtime,
      store: createMemoryContainerStore(),
    });
    const manager = sandboxesManager({
      containers: () => Promise.resolve(containers),
      home,
      root,
    });
    const a = args(root);
    const sandboxes = manager(a);

    const env = await sandboxes.start({ image: "docker.io/oven/bun:1-slim" });
    const result = await env.exec(["bun", "test"]);
    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "ran bun test" });
    expect(commands).toEqual([["bun", "test"]]);

    await a.scope.enter(a.frame);
    const again = await sandboxes.start({ image: "docker.io/oven/bun:1-slim" });
    expect(again.id).toBe(env.id);
    expect((await containers.list()).map((row) => row.id)).toEqual([env.id]);

    await expect(
      sandboxes.start({
        files: { "a.txt": "x" },
        id: "sandbox#1",
        kind: "sandbox",
      })
    ).rejects.toThrow(FILES_UNSUPPORTED);

    await a.scope.settle();
    await containers.shutdown();
  });
});
