import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSkill } from "@foundry/agents/skills";
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
import { echoGit } from "~/create";
import type { Bindings, ManagerArgs } from "~/lib/bindings";
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

/** These managers never reach the bindings a body's context carries. */
const NO_BINDINGS = {} as Bindings;

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
  it("keeps binary skill files as bytes and takes skills defined in code", async () => {
    const workspace = join(tmp, "ws-bytes");
    const dir = join(workspace, "skills", "brand");
    await skill(dir, "brand");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]);
    await writeFile(join(dir, "logo.png"), png);
    await writeFile(join(dir, "notes.md"), "Use the logo.");
    const resolve = skillResolver({ global: join(tmp, "none"), workspace });

    const [brand] = await resolve(skills.load());
    expect(brand?.files?.["logo.png"]).toEqual(png);
    expect(brand?.files?.["notes.md"]).toBe("Use the logo.");

    const tone = defineSkill({
      manifest:
        "---\nname: tone\ndescription: Write plainly.\n---\nWrite plainly.",
    });
    const defined = await resolve(skills.none().add(tone));
    expect(defined.map((entry) => entry.name)).toEqual(["tone"]);
    expect(
      (await resolve(skills.load().add(tone).pick("tone"))).map((e) => e.name)
    ).toEqual(["tone"]);
    await expect(resolve(skills.none())).resolves.toEqual([]);
  });

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
      const files = await workspaces.current.files();
      expect(files.map((file) => file.path)).toContain("README.md");
      expect(files.find((file) => file.path === "README.md")).toMatchObject({
        extension: "md",
        type: "file",
      });
      expect(repositoryRoot(join(repo, "nested", "deeper"))).toBe(repo);

      const seen: string[] = [];
      await current.run({ ...a, bindings: NO_BINDINGS, cwd: repo }, () =>
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

  it("cuts every worktree under the marbles-owned home when the caller names none", async () => {
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
      const home = realpathSync(worktreeHome);
      expect(root.startsWith(home)).toBe(true);

      // `worktree()` takes the same default, and so does a worktree's own call.
      const cut = await workspaces.current.git.worktree({ base: "main" });
      expect(cut.root.startsWith(home)).toBe(true);
      const nested = await cut.withWorktree({ base: "main" }, (inner) =>
        Promise.resolve(inner.root)
      );
      expect(nested.startsWith(home)).toBe(true);
      const listed = await workspaces.current.git.worktrees();
      const again = await listed[0]?.worktree({ base: "main" });
      expect(again?.root.startsWith(home)).toBe(true);
      await again?.remove();
      await cut.remove();
    } finally {
      await catalogue.closeAll();
      await rm(repo, { force: true, recursive: true });
    }
  });

  it("answers hasBranch from the repository even when git is echoed", async () => {
    const repo = await seedRepository();
    const printed: string[] = [];
    const gitOptions = { run: echoGit((line) => printed.push(line)) };
    const catalogue = new WorkspaceSystem().extend(
      directory({ observer: nodeObserver }),
      git(gitOptions)
    );
    try {
      const workspaces = new WorkspacesManager({
        catalogue,
        gitOptions,
        root: repo,
      }).scoped(args(repo));
      expect(await workspaces.current.git.hasBranch("main")).toBe(true);
      expect(await workspaces.current.git.hasBranch("design/x")).toBe(false);
      expect(printed).toEqual([]);
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
    expect(second.id).not.toBe(first.id);
    const stored = await system.get(first.artifactId as ArtifactId);
    expect(stored?.content?.id).toBe(second.id);
    const file = await system.readFile(second.id as ContentId, "report.md");
    expect(new TextDecoder().decode(file?.blob)).toBe("# two\n");

    // A replay of the same body returns the recorded version, no new write.
    await a.scope.enter(a.frame);
    const replayed = await artifacts.write(report, { "report.md": "# x\n" });
    expect(replayed.id).toBe(first.id);

    const prototype = {
      entries: { "index.html": "<p>hi</p>" },
      name: "Prototype",
      type: "text/html",
    };
    const fresh = await artifacts.create(prototype);
    expect(fresh.artifactId).not.toBe(first.artifactId);

    // A replayed create returns the artifact it made, not a second one.
    await a.scope.enter(a.frame);
    await artifacts.write(report, { "report.md": "# x\n" });
    expect((await artifacts.create(prototype)).id).toBe(fresh.id);
  });

  it("reads the latest version, from the real store under a dry run", async () => {
    const real = new ArtifactManager({ store: new InMemoryArtifactStore() });
    const memory = {
      id: "artifact#1",
      kind: "artifact",
      name: "Memory",
      type: "application/json",
    } as const;
    const live = new ArtifactsManager({ artifacts: real, workspaceId: "ws" });
    await expect(live.latest(memory)).resolves.toBeUndefined();
    await live.write(memory, { "ref.json": '{"id":"s-1"}' });
    const kept = await live.latest(memory);
    expect(JSON.parse((await kept?.text("ref.json")) ?? "{}")).toEqual({
      id: "s-1",
    });
    await expect(kept?.text("missing.json")).resolves.toBeUndefined();

    // A dry run writes to memory and reads what real runs left.
    const dry = new ArtifactsManager({
      artifacts: new ArtifactManager({ store: new InMemoryArtifactStore() }),
      readThrough: real,
      workspaceId: "ws",
    });
    expect((await dry.latest(memory))?.version.id).toBe(kept?.version.id);
    await dry.write(memory, { "ref.json": '{"id":"s-2"}' });
    expect(await (await dry.latest(memory))?.text("ref.json")).toBe(
      '{"id":"s-2"}'
    );
    expect(await (await live.latest(memory))?.text("ref.json")).toBe(
      '{"id":"s-1"}'
    );
  });

  it("reads versions back, records who wrote them, and changes only some files", async () => {
    const manager = new ArtifactsManager({
      artifacts: new ArtifactManager({ store: new InMemoryArtifactStore() }),
      workspaceId: "ws",
    });
    const site = {
      id: "artifact#1",
      kind: "artifact",
      name: "Site",
      type: "text/html",
    } as const;
    const a = args();
    const artifacts = manager.scoped(a);
    const first = await artifacts.write(site, {
      "about.html": "<p>about</p>",
      "index.html": "<p>home</p>",
    });
    expect(first.metadata).toMatchObject({
      runId: a.scope.id,
      sessionId: a.scope.session.id,
    });
    expect(first.digest).toEqual(expect.any(String));

    const b = args();
    const second = await manager
      .scoped(b)
      .write(site, { "index.html": "<p>new</p>" }, { replace: false });
    const about = await artifacts.readFile(second.id, "about.html");
    expect(new TextDecoder().decode(about?.blob)).toBe("<p>about</p>");
    const root = await artifacts.readRoot(second.id);
    expect(new TextDecoder().decode(root?.blob)).toBe("<p>new</p>");

    expect((await artifacts.get(site))?.content?.id).toBe(second.id);
    const versions = (await artifacts.listContents(site)).map((row) => row.id);
    expect([...versions].sort()).toEqual([first.id, second.id].sort());
    expect((await artifacts.getContent(first.id))?.id).toBe(first.id);
  });
});

describe("sandboxes", () => {
  it("mounts only explicit workspaces and never host credential directories", async () => {
    const root = join(tmp, "project");
    await mkdir(root, { recursive: true });
    const site = {
      id: "workspace#1",
      kind: "workspace",
      path: "../site",
    } as const;
    await mkdir(join(tmp, "site"), { recursive: true });

    const dirs = { cwd: root, root };
    const plain = constraintsFor({ image: "img:1" }, dirs);
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
      dirs
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
      dirs
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
      constraintsFor({ image: "img:1" }, inWorktree).mounts?.[0]?.source
    ).toBe(join(tmp, "wt"));
    expect(
      constraintsFor({ image: "img:1", mount: site }, inWorktree).mounts?.[0]
        ?.source
    ).toBe(join(tmp, "site"));
    // Only host folders that exist are allowed; the registry canonicalizes them.
    expect(allowedMountRoots([root, join(tmp, "site")])).toEqual([
      root,
      join(tmp, "site"),
    ]);
  });

  it("passes the container's own constraints through, with /workspace as a default", () => {
    const dirs = { cwd: tmp, root: tmp };
    expect(
      constraintsFor(
        {
          image: "img:1",
          labels: { team: "design" },
          ports: [3000],
          resources: { pids: 64 },
          target: "/src",
        },
        dirs
      )
    ).toMatchObject({
      labels: { team: "design" },
      mounts: [{ source: tmp, target: "/src" }],
      ports: [3000],
      resources: { pids: 64 },
      workdir: "/src",
    });
    expect(
      constraintsFor({ image: "img:1", workdir: "/workspace/app" }, dirs)
    ).toMatchObject({
      mounts: [{ target: "/workspace" }],
      workdir: "/workspace/app",
    });
  });

  it("starts containers, runs commands, closes with the run, and reopens on replay", async () => {
    const root = join(tmp, "project");
    await mkdir(root, { recursive: true });
    const commands: string[][] = [];
    const seen: { cwd?: string; env?: unknown; signal?: unknown }[] = [];
    const runtime = createFakeContainerRuntime({
      exec: (command, options) => {
        commands.push([...command]);
        seen.push(options as (typeof seen)[number]);
        return { exitCode: 0, stderr: "", stdout: `ran ${command.join(" ")}` };
      },
    });
    const containers = createContainers({
      allowedMountRoots: allowedMountRoots([root]),
      instanceLabel: "test",
      runtime,
      store: createMemoryContainerStore(),
    });
    const manager = new SandboxesManager({
      containers: () => Promise.resolve(containers),
      root,
    });
    const a = args(root);
    const sandboxes = manager.scoped(a);

    const env = await sandboxes.start({ image: "docker.io/oven/bun:1-slim" });
    const result = await env.exec(["bun", "test"]);
    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "ran bun test" });
    expect(commands).toEqual([["bun", "test"]]);
    // The step's stream shows the command and its output.
    expect(a.written).toContain("$ bun test\nran bun test");
    // The container is all there, with the package's exec options.
    await env.commands.exec(["ls"], { cwd: "/tmp", environment: { A: "1" } });
    // The runtime gets them as the container passes them on.
    expect(seen.at(-1)).toMatchObject({ cwd: "/tmp", env: { A: "1" } });
    expect(seen.at(-1)?.signal).toBeInstanceOf(AbortSignal);
    expect(typeof env.files.readFile).toBe("function");
    expect("row" in env).toBe(false);

    await a.scope.enter(a.frame);
    const again = await sandboxes.start({ image: "docker.io/oven/bun:1-slim" });
    expect(again.id).toBe(env.id);
    expect((await containers.list()).map((row) => row.id)).toEqual([env.id]);

    await a.scope.settle();
    await containers.shutdown();
  });

  it("a sandbox started inside a worktree callback mounts the worktree", async () => {
    const root = join(tmp, "project");
    const worktreeHome = join(tmp, "state", "worktrees");
    const worktree = join(worktreeHome, "worktree-abc");
    await mkdir(root, { recursive: true });
    await mkdir(worktree, { recursive: true });
    const containers = createContainers({
      allowedMountRoots: allowedMountRoots([root, worktreeHome]),
      instanceLabel: "test",
      runtime: createFakeContainerRuntime(),
      store: createMemoryContainerStore(),
    });
    const manager = new SandboxesManager({
      containers: () => Promise.resolve(containers),
      root,
    });
    const a = args(root);
    const sandboxes = manager.scoped(a);
    const env = await current.run(
      { ...a, bindings: NO_BINDINGS, cwd: worktree },
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

  it("adopts a host-owned container without taking over its lifetime", async () => {
    const runtime = createFakeContainerRuntime();
    const containers = createContainers({
      allowedMountRoots: [],
      instanceLabel: "test",
      runtime,
      store: createMemoryContainerStore(),
    });
    const owned = await containers.start({
      format: "foundry.sandbox.container/1",
      mounts: [],
      workdir: "/workspace",
    });
    const manager = new SandboxesManager({
      containers: () => Promise.reject(new Error("not this engine's")),
      root: tmp,
    });
    const handle = manager.adopt(owned);
    expect(manager.containerOf(handle)).toBe(owned);
    expect(handle.id).toBe(owned.id);
    await handle.close();
    expect(runtime.instances[0]?.stopped).toBe(false);
    await owned.close();
  });

  it("a files sandbox mounts nothing and seeds its files under /workspace", async () => {
    const root = join(tmp, "project");
    await mkdir(root, { recursive: true });
    const scratch = constraintsFor(
      { files: { "a.txt": "x" }, image: "img:2" },
      { cwd: root, root }
    );
    expect(scratch).toEqual({
      format: "foundry.sandbox.container/1",
      image: "img:2",
      mounts: [],
      workdir: "/workspace",
    });
    expect(
      constraintsFor({ files: { "a.txt": "x" } }, { cwd: root, root }).image
    ).toBe(undefined);
    expect(guestFiles({ "/etc/motd": "hi", "a.txt": "x" })).toEqual({
      "/etc/motd": "hi",
      "/workspace/a.txt": "x",
    });

    const runtime = createFakeContainerRuntime();
    const containers = createContainers({
      allowedMountRoots: allowedMountRoots([root]),
      instanceLabel: "test",
      runtime,
      store: createMemoryContainerStore(),
    });
    const a = args(root);
    const sandboxes = new SandboxesManager({
      containers: () => Promise.resolve(containers),
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
