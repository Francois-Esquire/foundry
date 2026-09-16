import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";
import { WithDirectory } from "../directory";
import type { GitPathStatus } from "../git";
import { Git, git as gitLayer, WithGit } from "../git";
import { InMemoryWorkspaceStore } from "../in-memory-workspace-store";
import { Workspace } from "../instance";
import { directorySystem } from "./helpers/directory-system";
import { hostWorkspace } from "./helpers/workspace-system-conformance";

/**
 * H-11 — `Git` over real temporary repositories.
 *
 * Every fixture is built with the `git` binary rather than through the class,
 * because `Git` has no way to create a repository and must not gain one.
 * Repositories live under the OS temp directory, never in the repo.
 */

const inspectGit = (root: string) => Git.at(root).status();

const execFile = promisify(execFileCallback);
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd,
    // The fixture must not inherit the developer's identity, template dir, or
    // init.defaultBranch — every assertion below names what it set itself.
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_NAME: "Workspace Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Workspace Fixture",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  return stdout.trim();
}

async function makeDirectory(
  tree: Record<string, string> = {}
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "foundry-workspace-git-"));
  roots.push(root);
  await write(root, tree);
  return root;
}

async function write(root: string, tree: Record<string, string>) {
  for (const [relativePath, contents] of Object.entries(tree)) {
    const absolute = join(root, relativePath);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, contents);
  }
}

/** A repository with `tree` committed on `main`. */
async function makeRepository(tree: Record<string, string>): Promise<string> {
  const root = await makeDirectory(tree);
  await git(root, "init", "-b", "main");
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "first");
  return root;
}

function statusFor(
  paths: readonly GitPathStatus[],
  path: string
): GitPathStatus | undefined {
  return paths.find((entry) => entry.path === path);
}

describe("Git.status outside a repository", () => {
  it("reports no capability for an ordinary directory", async () => {
    const root = await makeDirectory({ "README.md": "hello" });

    expect(await inspectGit(root)).toEqual({ kind: "none" });
  });

  it("reports no capability for a directory that is gone", async () => {
    const root = await makeDirectory();
    await rm(root, { force: true, recursive: true });

    expect(await inspectGit(root)).toEqual({ kind: "none" });
  });
});

describe("Git.status at a repository root", () => {
  it("names the current branch and reports a clean tree as no paths", async () => {
    const root = await makeRepository({ "README.md": "hello" });

    expect(await inspectGit(root)).toEqual({
      branch: "main",
      detached: false,
      kind: "repository",
      paths: [],
    });
  });

  it("distinguishes staged, unstaged, and untracked paths", async () => {
    const root = await makeRepository({
      "staged.md": "before",
      "unstaged.md": "before",
    });
    await write(root, {
      "fresh.md": "new",
      "staged.md": "after",
      "unstaged.md": "after",
    });
    await git(root, "add", "staged.md");

    const snapshot = await inspectGit(root);
    if (snapshot.kind !== "repository") {
      throw new Error("expected a repository");
    }

    expect(statusFor(snapshot.paths, "staged.md")).toEqual({
      path: "staged.md",
      staged: true,
      unstaged: false,
      untracked: false,
    });
    expect(statusFor(snapshot.paths, "unstaged.md")).toEqual({
      path: "unstaged.md",
      staged: false,
      unstaged: true,
      untracked: false,
    });
    expect(statusFor(snapshot.paths, "fresh.md")).toEqual({
      path: "fresh.md",
      staged: false,
      unstaged: false,
      untracked: true,
    });
  });

  it("reports a path edited after staging as both staged and unstaged", async () => {
    const root = await makeRepository({ "both.md": "before" });
    await write(root, { "both.md": "staged" });
    await git(root, "add", "both.md");
    await write(root, { "both.md": "and then edited again" });

    const snapshot = await inspectGit(root);
    if (snapshot.kind !== "repository") {
      throw new Error("expected a repository");
    }

    expect(statusFor(snapshot.paths, "both.md")).toEqual({
      path: "both.md",
      staged: true,
      unstaged: true,
      untracked: false,
    });
  });

  it("reports both ends of a rename", async () => {
    const root = await makeRepository({ "old-name.md": "hello" });
    await git(root, "mv", "old-name.md", "new-name.md");

    const snapshot = await inspectGit(root);
    if (snapshot.kind !== "repository") {
      throw new Error("expected a repository");
    }

    expect(snapshot.paths.map((entry) => entry.path)).toEqual([
      "new-name.md",
      "old-name.md",
    ]);
    expect(snapshot.paths.every((entry) => entry.staged)).toBe(true);
  });

  it("gives a rename's origin the index column alone", async () => {
    const root = await makeRepository({ "old-name.md": "hello" });
    await git(root, "mv", "old-name.md", "new-name.md");
    // Edited after the rename was staged, which makes the raw status
    // `{ index: "R", working_dir: "M", from: "old-name.md" }`. The `M`
    // describes the destination's bytes; the origin has no working-tree
    // entry at all and must not inherit it.
    await write(root, { "new-name.md": "hello, edited afterwards" });

    const snapshot = await inspectGit(root);
    if (snapshot.kind !== "repository") {
      throw new Error("expected a repository");
    }

    expect(statusFor(snapshot.paths, "old-name.md")).toEqual({
      path: "old-name.md",
      staged: true,
      unstaged: false,
      untracked: false,
    });
    expect(statusFor(snapshot.paths, "new-name.md")).toEqual({
      path: "new-name.md",
      staged: true,
      unstaged: true,
      untracked: false,
    });
  });

  it("names no branch on a detached HEAD", async () => {
    const root = await makeRepository({ "README.md": "hello" });
    const head = await git(root, "rev-parse", "HEAD");
    await git(root, "checkout", "--detach", head);

    const snapshot = await inspectGit(root);
    if (snapshot.kind !== "repository") {
      throw new Error("expected a repository");
    }

    expect(snapshot.detached).toBe(true);
    expect(snapshot.branch).toBeNull();
  });
});

describe("Git.status inside a repository", () => {
  it("publishes only paths within the Workspace root, re-based onto it", async () => {
    const repository = await makeRepository({
      "inside/nested/kept.md": "hello",
      "outside/other.md": "hello",
    });
    await write(repository, {
      "inside/fresh.md": "new",
      "inside/nested/kept.md": "changed",
      "outside/fresh.md": "new",
      "outside/other.md": "changed",
    });

    const snapshot = await inspectGit(join(repository, "inside"));
    if (snapshot.kind !== "repository") {
      throw new Error("expected a repository");
    }

    expect(snapshot.branch).toBe("main");
    expect(snapshot.paths.map((entry) => entry.path)).toEqual([
      "fresh.md",
      "nested/kept.md",
    ]);
    // The changed sibling directory is not merely re-based — it is absent.
    expect(JSON.stringify(snapshot)).not.toContain("outside");
  });

  it("keeps a backslash in a filename, which POSIX allows and Git reports literally", async () => {
    // The name below is one path segment containing backslashes. Rewriting
    // them to `/` would annotate a path the catalog does not hold, losing the
    // mark — and, for a name that starts with `..\`, would name a directory
    // outside the Workspace entirely.
    const repository = await makeRepository({ "inside/kept.md": "hello" });
    await write(repository, {
      [join("inside", String.raw`a\b.md`)]: "backslashes",
      [join("inside", String.raw`..\..\secretdir\pwned.txt`)]: "hostile name",
    });

    const snapshot = await inspectGit(join(repository, "inside"));
    if (snapshot.kind !== "repository") {
      throw new Error("expected a repository");
    }

    expect(snapshot.paths.map((entry) => entry.path)).toEqual([
      String.raw`..\..\secretdir\pwned.txt`,
      String.raw`a\b.md`,
    ]);
    // Whatever a file is called, nothing published may leave the Workspace.
    expect(
      snapshot.paths.every((entry) => !entry.path.split("/").includes(".."))
    ).toBe(true);
  });

  it("keeps a colon in a filename, which POSIX allows and no Git path ever means as a drive", async () => {
    // `:` is legal in a POSIX filename, and Git porcelain reports
    // repository-relative paths on every platform — never drive-lettered. A
    // drive-letter guard would therefore have no true positives at all, and
    // would silently drop exactly these two marks.
    const repository = await makeRepository({ "inside/kept.md": "hello" });
    await write(repository, {
      [join("inside", "C:notes.md")]: "colon after a letter",
      [join("inside", "D:")]: "a name that is only a drive letter",
      [join("inside", "notes:2026.md")]: "colon in the middle",
    });

    const snapshot = await inspectGit(join(repository, "inside"));
    if (snapshot.kind !== "repository") {
      throw new Error("expected a repository");
    }

    expect(snapshot.paths.map((entry) => entry.path)).toEqual([
      "C:notes.md",
      "D:",
      "notes:2026.md",
    ]);
  });

  it("publishes the changes of a Workspace directory whose name begins with dots", async () => {
    const repository = await makeRepository({ "..leading/kept.md": "hello" });
    await write(repository, { "..leading/kept.md": "changed" });

    const snapshot = await inspectGit(join(repository, "..leading"));
    if (snapshot.kind !== "repository") {
      throw new Error("expected a repository");
    }

    expect(snapshot.paths.map((entry) => entry.path)).toEqual(["kept.md"]);
  });

  it("returns no absolute path anywhere in the snapshot", async () => {
    const repository = await makeRepository({ "inside/kept.md": "hello" });
    await write(repository, { "inside/kept.md": "changed" });

    const snapshot = await inspectGit(join(repository, "inside"));

    expect(JSON.stringify(snapshot)).not.toContain(repository);
  });
});

describe("Git.status failures", () => {
  /**
   * The first question — "is this a working tree?" — has three outcomes, and
   * only two of them mean the same thing. A `false` is an answer: no
   * repository. A throw is not: the repository is there and Git cannot open
   * it, and calling that an ordinary directory hides a broken environment.
   *
   * Deliberately not fixtured with `chmod` (G-04) and deliberately not with a
   * corrupt `HEAD`: Git itself reports that as "not a git repository", so
   * `simple-git` resolves false and no caller can tell it from a plain
   * directory. That is recorded below rather than asserted as unavailable.
   */
  it("reports a repository whose config Git refuses as unavailable", async () => {
    const root = await makeRepository({ "README.md": "hello" });
    await writeFile(
      join(root, ".git", "config"),
      "[core]\n\tbare = notabool\n"
    );

    expect(await inspectGit(root)).toMatchObject({ kind: "unavailable" });
  });

  it("reports a repository format Git cannot handle as unavailable", async () => {
    const root = await makeRepository({ "README.md": "hello" });
    await git(root, "config", "core.repositoryformatversion", "99");

    expect(await inspectGit(root)).toMatchObject({ kind: "unavailable" });
  });

  it("reports a repository whose index cannot be parsed as unavailable", async () => {
    const root = await makeRepository({ "README.md": "hello" });
    await writeFile(join(root, ".git", "index"), "not an index");

    expect(await inspectGit(root)).toMatchObject({ kind: "unavailable" });
  });

  it("names no absolute path in an unavailable reason", async () => {
    const root = await makeRepository({ "README.md": "hello" });
    await writeFile(
      join(root, ".git", "config"),
      "[core]\n\tbare = notabool\n"
    );

    expect(JSON.stringify(await inspectGit(root))).not.toContain(root);
  });

  it("still reports a plain directory as no repository, not as unavailable", async () => {
    // The other side of the boundary above: widening `unavailable` must not
    // swallow the ordinary case the whole capability rests on.
    expect(await inspectGit(await makeDirectory({ "a.md": "hi" }))).toEqual({
      kind: "none",
    });
  });
});

describe("Git.isRepository and Git.open", () => {
  it("answers for a working tree root and never for a resource URI", async () => {
    const root = await makeRepository({ "README.md": "hello" });

    expect(await Git.isRepository(root)).toBe(true);
    expect(await Git.isRepository("foundry://abc.artifact")).toBe(false);
    expect((await Git.open(root))?.root).toBe(root);
    expect(await Git.open("foundry://abc.artifact")).toBeNull();
  });

  it("is false for a plain directory, so open returns null there", async () => {
    const root = await makeDirectory({ "a.md": "hi" });
    expect(await Git.isRepository(root)).toBe(false);
    expect(await Git.open(root)).toBeNull();
  });
});

/**
 * The layer. Git is optional, supplementary, and never allowed to touch the
 * catalog it annotates.
 */
describe("WithGit", () => {
  it("applies to a directory Workspace inside a working tree and reads live status", async () => {
    const root = await makeRepository({ "README.md": "hello" });
    const system = directorySystem().extend(gitLayer());
    const added = await system.add({ path: root });

    await writeFile(join(root, "README.md"), "changed outside Studio");
    const snapshot = await added.git?.status();

    expect(snapshot).toEqual({
      branch: "main",
      detached: false,
      kind: "repository",
      paths: [
        { path: "README.md", staged: false, unstaged: true, untracked: false },
      ],
    });
    // The status was live, and the catalog it describes never moved.
    expect((await added.files()).map((file) => file.path)).toEqual([
      "README.md",
    ]);
  });

  it("does not apply to an ordinary directory", async () => {
    const root = await makeDirectory({ "README.md": "hello" });
    const system = directorySystem().extend(gitLayer());
    const added = await system.add({ path: root });

    expect(added.git).toBeUndefined();
  });

  it("carries the injected runner into worktrees", async () => {
    const root = await makeRepository({ "README.md": "hello" });
    const runs: string[][] = [];
    const system = directorySystem().extend(
      gitLayer({
        run: (cwd, args) => {
          runs.push([cwd, ...args]);
          return Promise.resolve("");
        },
      })
    );
    const added = await system.add({ path: root });

    await added.git?.worktrees();

    expect(runs).toEqual([
      [await realpath(root), "worktree", "list", "--porcelain"],
    ]);
  });

  it("composes by hand over the directory layer", async () => {
    const root = await realpath(await makeRepository({ "README.md": "hello" }));
    const store = new InMemoryWorkspaceStore();
    const record = hostWorkspace({ path: root });
    await store.commitCreate({ files: [], workspace: record });
    const Composed = WithGit(WithDirectory(Workspace));

    const workspace = new Composed(record, {
      close: () => Promise.resolve(),
      observing: new Map(),
      serialized: new Map(),
      store,
    });

    expect(workspace.git.root).toBe(root);
    expect((await workspace.refresh()).files.map((f) => f.path)).toEqual([
      "README.md",
    ]);
  });

  it("does not write while answering", async () => {
    const root = await makeRepository({ "README.md": "hello" });
    const store = new InMemoryWorkspaceStore();
    const system = directorySystem({ store }).extend(gitLayer());
    const added = await system.add({ path: root });
    const writes: string[] = [];
    for (const method of [
      "commitCreate",
      "commitReconcile",
      "removeWorkspace",
    ] as const) {
      const original = store[method].bind(store);
      (store as unknown as Record<string, unknown>)[method] = (
        ...args: unknown[]
      ) => {
        writes.push(method);
        return (original as (...a: unknown[]) => unknown)(...args);
      };
    }

    await added.git?.status();
    expect(writes).toEqual([]);

    // The probe's positive control. Without it an empty list would prove only
    // that the instrumentation never fired.
    await writeFile(join(root, "arrived.md"), "new file");
    await added.refresh();
    expect(writes).toEqual(["commitReconcile"]);
  });
});

describe("Git worktrees", () => {
  it("checks a base out detached, lists it, and removes it", async () => {
    const repository = await makeRepository({ "README.md": "hello" });
    const home = await makeDirectory();
    const repo = Git.at(repository);

    const worktree = await repo.worktree({ base: "main", home });
    roots.push(worktree.root);
    expect(worktree.repository).toBe(repository);
    expect(worktree.branch).toBeNull();
    expect(await worktree.status()).toMatchObject({
      detached: true,
      kind: "repository",
      paths: [],
    });
    expect((await repo.worktrees()).map((entry) => entry.root)).toEqual([
      worktree.root,
    ]);

    await worktree.remove();
    expect(await repo.worktrees()).toEqual([]);
  });

  it("lands outside the repository by default", async () => {
    const repository = await makeRepository({ "README.md": "hello" });
    const worktree = await Git.at(repository).worktree({ base: "main" });
    expect(worktree.root.startsWith(repository)).toBe(false);
    await worktree.remove();
  });

  it("creates a branch at the base when asked", async () => {
    const repository = await makeRepository({ "README.md": "hello" });
    const home = await makeDirectory();

    const worktree = await Git.at(repository).worktree({
      base: "main",
      branch: "review/1",
      home,
    });
    expect(worktree.branch).toBe("review/1");
    expect(await worktree.status()).toMatchObject({ branch: "review/1" });
    expect((await Git.at(repository).worktrees())[0]?.branch).toBe("review/1");
    await worktree.remove();
  });

  it("withWorktree removes the checkout even when the body throws", async () => {
    const repository = await makeRepository({ "README.md": "hello" });
    const home = await makeDirectory();
    const repo = Git.at(repository);

    await expect(
      repo.withWorktree({ base: "main", home }, () =>
        Promise.reject(new Error("body failed"))
      )
    ).rejects.toThrow("body failed");
    expect(await repo.worktrees()).toEqual([]);
  });

  it("routes every mutation through the injected runner", async () => {
    const calls: string[] = [];
    const repo = Git.at("/repo", {
      run: (cwd, args) => {
        calls.push(`${cwd}: git ${args.join(" ")}`);
        return Promise.resolve("");
      },
    });

    const worktree = await repo.worktree({ base: "main", branch: "b" });
    roots.push(worktree.root);
    await worktree.remove();
    expect(calls).toEqual([
      `/repo: git worktree add -b b ${worktree.root} main`,
      `/repo: git worktree remove --force ${worktree.root}`,
    ]);
  });
});
