import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactId, ContentId } from "@foundry/artifacts";
import { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";
import { createContainers } from "@foundry/sandbox/container/containers";
import { createMemoryContainerStore } from "@foundry/sandbox/container/store";
import { createFakeContainerRuntime } from "@foundry/sandbox/testing";
import { WorkspaceSystem } from "@foundry/workspaces";
import { git } from "@foundry/workspaces/git";
import { directory } from "@foundry/workspaces/node";
import { nodeObserver } from "@foundry/workspaces/node/watch";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { skills } from "~/authoring/resources";
import type { ManagerArgs } from "~/lib/bindings";
import { ArtifactsManager, artifactIdFor } from "~/lib/managers/artifacts";
import {
  allowedMountRoots,
  constraintsFor,
  guestFiles,
  SandboxesManager,
} from "~/lib/managers/sandboxes";
import { skillResolver } from "~/lib/managers/skills";
import { repositoryRoot, WorkspacesManager } from "~/lib/managers/workspaces";
import { current, RunScope } from "~/lib/run-scope";
import { seedRepository } from "./../helpers/repository";

const NOT_A_REPOSITORY = /not a git repository/;
const UNKNOWN_SKILL = /unknown skill nope/;

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "marbles-managers-"));
});

afterEach(async () => {
  await rm(tmp, { force: true, recursive: true });
});

function args(cwd = tmp): ManagerArgs & { readonly written: unknown[] } {
  const scope = new RunScope(`run-${Math.random()}`, cwd);
  const frame = scope.frame(["root"]);
  const written: unknown[] = [];
  return { frame, scope, write: (value) => written.push(value), written };
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
    await skill(join(tmp, "sibling", "skills", "shared"), "shared");
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
    // The static prefix resolves against the workspace, so a glob may leave
    // it or be absolute; a pattern without a glob names one directory.
    await expect(
      names(skills.load().add("../sibling/skills/*"))
    ).resolves.toEqual(["caveman", "shared", "unslop"]);
    await expect(
      names(skills.load().add(join(tmp, "sibling", "skills", "*")))
    ).resolves.toEqual(["caveman", "shared", "unslop"]);
    await expect(
      names(skills.load().add("extra/review/deep").pick("deep-review"))
    ).resolves.toEqual(["deep-review"]);
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
      const manager = new WorkspacesManager({ catalogue, root: repo });
      const a = args(repo);
      const workspaces = manager.scoped(a);
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

  it("cuts worktrees under the marbles-owned home when the caller names none", async () => {
    const repo = await seedRepository();
    const catalogue = new WorkspaceSystem().extend(
      directory({ observer: nodeObserver }),
      git()
    );
    const worktreeHome = join(tmp, "state", "worktrees");
    try {
      const workspaces = new WorkspacesManager({
        catalogue,
        root: repo,
        worktreeHome,
      }).scoped(args(repo));
      const root = await workspaces.current.git.withWorktree(
        { base: "main" },
        (worktree) => Promise.resolve(worktree.root)
      );
      expect(root.startsWith(realpathSync(worktreeHome))).toBe(true);
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
    const workspaces = new WorkspacesManager({ catalogue, root: tmp }).scoped(
      args()
    );
    expect(() => workspaces.current.git).toThrow(NOT_A_REPOSITORY);
  });
});

describe("artifacts", () => {
  it("keeps a declared artifact's identity and adds a version per write", async () => {
    const system = new ArtifactManager({ store: new InMemoryArtifactStore() });
    const manager = new ArtifactsManager({
      artifacts: system,
      workspaceId: "ws",
    });
    const report = {
      id: "artifact#1",
      kind: "artifact",
      name: "Weekly",
      type: "text/markdown",
    } as const;
    const a = args();
    const artifacts = manager.scoped(a);

    const first = await artifacts.write(report, { "report.md": "# one\n" });
    expect(first.artifactId).toBe(artifactIdFor("ws", "Weekly"));

    const b = args();
    const second = await manager
      .scoped(b)
      .write(report, { "report.md": "# two\n" });
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
  it("mounts only explicit workspaces and never host credential directories", async () => {
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

    const dirs = { cwd: root, root };
    const plain = constraintsFor({ image: "img:1" }, dirs, home);
    expect(plain).toEqual({
      format: "foundry.sandbox.container/1",
      image: "img:1",
      mounts: [
        {
          access: "read-write",
          executable: false,
          id: "workspace",
          source: root,
          target: "/workspace",
        },
      ],
      workdir: "/workspace",
    });
    const sized = constraintsFor(
      { image: "img:1", mount: site, resources: { cpus: 2 } },
      dirs,
      home
    );
    expect(sized.mounts?.[0]?.source).toBe(join(tmp, "site"));
    expect(sized.resources).toEqual({ cpus: 2 });
    const executable = constraintsFor(
      {
        executable: true,
        image: "img:1",
        network: {
          destinations: [{ host: "api.anthropic.com", ports: [443] }],
          mode: "allowlist",
        },
      },
      dirs,
      home
    );
    expect(executable.mounts?.[0]?.executable).toBe(true);
    expect(executable.network).toEqual({
      destinations: [{ host: "api.anthropic.com", ports: [443] }],
      mode: "allowlist",
    });
    // "." is the step's working directory; a declared workspace stays
    // relative to the config's directory.
    const inWorktree = { cwd: join(tmp, "wt"), root };
    expect(
      constraintsFor({ image: "img:1" }, inWorktree, home).mounts?.[0]?.source
    ).toBe(join(tmp, "wt"));
    expect(
      constraintsFor({ image: "img:1", mount: site }, inWorktree, home)
        .mounts?.[0]?.source
    ).toBe(join(tmp, "site"));
    // Only host folders that exist are allowed; the registry canonicalizes them.
    expect(allowedMountRoots([root, join(tmp, "site")], home)).toEqual([
      root,
      join(tmp, "site"),
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
    const manager = new SandboxesManager({
      containers: () => Promise.resolve(containers),
      home,
      root,
    });
    const a = args(root);
    const sandboxes = manager.scoped(a);

    const env = await sandboxes.start({ image: "docker.io/oven/bun:1-slim" });
    const result = await env.exec(["bun", "test"]);
    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "ran bun test" });
    expect(commands).toEqual([["bun", "test"]]);

    await a.scope.enter(a.frame);
    const again = await sandboxes.start({ image: "docker.io/oven/bun:1-slim" });
    expect(again.id).toBe(env.id);
    expect((await containers.list()).map((row) => row.id)).toEqual([env.id]);

    await a.scope.settle();
    await containers.shutdown();
  });

  it("a sandbox started inside a worktree callback mounts the worktree", async () => {
    const root = join(tmp, "project");
    const home = join(tmp, "home");
    const worktreeHome = join(tmp, "state", "worktrees");
    const worktree = join(worktreeHome, "worktree-abc");
    await mkdir(root, { recursive: true });
    await mkdir(home, { recursive: true });
    await mkdir(worktree, { recursive: true });
    const containers = createContainers({
      allowedMountRoots: allowedMountRoots([root, worktreeHome], home),
      instanceLabel: "test",
      runtime: createFakeContainerRuntime(),
      store: createMemoryContainerStore(),
    });
    const manager = new SandboxesManager({
      containers: () => Promise.resolve(containers),
      home,
      root,
    });
    const a = args(root);
    const sandboxes = manager.scoped(a);
    const env = await current.run(
      { cwd: worktree, frame: a.frame, scope: a.scope },
      () => sandboxes.start({ image: "img:1" })
    );
    const [row] = await containers.list();
    const spec = JSON.parse(row?.spec ?? "{}") as {
      mounts?: readonly { id: string; source: string }[];
    };
    // The registry accepted the mount, so the worktree home is trusted.
    expect(spec.mounts?.find((mount) => mount.id === "workspace")?.source).toBe(
      worktree
    );
    await env.close();
    await a.scope.settle();
    await containers.shutdown();
  });

  it("a files sandbox mounts nothing and seeds its files under /workspace", async () => {
    const root = join(tmp, "project");
    const home = join(tmp, "home");
    await mkdir(root, { recursive: true });
    await mkdir(home, { recursive: true });
    const scratch = constraintsFor(
      { files: { "a.txt": "x" }, image: "img:2" },
      { cwd: root, root },
      home
    );
    expect(scratch).toEqual({
      format: "foundry.sandbox.container/1",
      image: "img:2",
      mounts: [],
      workdir: "/workspace",
    });
    expect(
      constraintsFor({ files: { "a.txt": "x" } }, { cwd: root, root }, home)
        .image
    ).toBe(undefined);
    expect(guestFiles({ "/etc/motd": "hi", "a.txt": "x" })).toEqual({
      "/etc/motd": "hi",
      "/workspace/a.txt": "x",
    });

    const runtime = createFakeContainerRuntime();
    const containers = createContainers({
      allowedMountRoots: allowedMountRoots([root], home),
      instanceLabel: "test",
      runtime,
      store: createMemoryContainerStore(),
    });
    const a = args(root);
    const sandboxes = new SandboxesManager({
      containers: () => Promise.resolve(containers),
      home,
      root,
    }).scoped(a);
    const env = await sandboxes.start({
      files: { "b.txt": "beta", "notes/a.txt": "alpha" },
      id: "sandbox#1",
      image: "img:2",
      kind: "sandbox",
    });
    const [instance] = runtime.instances;
    const written = new Map(
      [...(instance?.files ?? [])].map(([path, bytes]) => [
        path,
        new TextDecoder().decode(bytes),
      ])
    );
    expect(written.get("/workspace/notes/a.txt")).toBe("alpha");
    expect(written.get("/workspace/b.txt")).toBe("beta");
    expect(instance?.spec.mounts ?? []).toEqual([]);

    // A recorded container that is gone (a new process) is started afresh.
    await env.close();
    await containers.remove(env.id);
    await a.scope.enter(a.frame);
    const fresh = await sandboxes.start({
      files: { "b.txt": "beta" },
      id: "sandbox#1",
      image: "img:2",
      kind: "sandbox",
    });
    expect(fresh.id).not.toBe(env.id);
    await a.scope.settle();
    await containers.shutdown();
  });
});
