import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GitHubRelease,
  resolvePackage,
  resolveReleaseCommit,
  selectRelease,
} from "../resolve";

function release(
  tag: string,
  options: Partial<GitHubRelease> = {}
): GitHubRelease {
  return {
    draft: false,
    html_url: `https://github.com/Francois-Esquire/foundry/releases/tag/${tag}`,
    id: 1,
    prerelease: true,
    published_at: "2026-10-14T12:00:00Z",
    tag_name: tag,
    ...options,
  };
}

test("only explicitly enabled packages can be selected for publication", () => {
  expect(resolvePackage("marbles").name).toBe("@foundry.sh/marbles");
  expect(resolvePackage("@foundry.sh/marbles").directory).toBe("apps/marbles");
  for (const input of [
    "atlas",
    "@foundry/marbles",
    "@foundry/models",
    "",
    "../marbles",
    "marbles\nsha=bad",
  ]) {
    expect(() => resolvePackage(input)).toThrow("not enabled");
  }
});

test("latest is the highest package version, including published alpha releases", () => {
  const releases = [
    release("atlas-v9.0.0"),
    release("marbles-v0.0.2", { published_at: "2026-10-15T00:00:00Z" }),
    release("marbles-v0.0.10"),
    release("marbles-v0.0.11", { draft: true }),
    release("marbles-v0.0.12", { published_at: null }),
    release("marbles-vinvalid"),
  ];
  const selected = selectRelease(resolvePackage("marbles"), releases);
  expect(selected.version).toBe("0.0.10");
  expect(selected.distTag).toBe("alpha");
});

test("exact versions resolve only matching published releases", () => {
  const releases = [release("marbles-v0.0.1"), release("marbles-v0.0.2")];
  expect(
    selectRelease(resolvePackage("marbles"), releases, "0.0.1").release.tag_name
  ).toBe("marbles-v0.0.1");
  for (const version of ["0.0.3", "v0.0.1", "latest", "0.0.1\n", "01.0.0"]) {
    expect(() =>
      selectRelease(resolvePackage("marbles"), releases, version)
    ).toThrow();
  }
  expect(() => selectRelease(resolvePackage("marbles"), [])).toThrow(
    "No published GitHub release"
  );
});

test("release channels distinguish alpha policy, prereleases, and the API milestone", () => {
  const target = resolvePackage("marbles");
  expect(
    selectRelease(target, [release("marbles-v0.1.0-beta.1")]).distTag
  ).toBe("next");
  expect(
    selectRelease(target, [release("marbles-v0.1.0", { prerelease: false })])
      .distTag
  ).toBe("latest");
  expect(() =>
    selectRelease(target, [release("marbles-v0.0.1", { prerelease: false })])
  ).toThrow("prerelease");
  expect(() =>
    selectRelease(target, [
      release("marbles-v0.1.0-beta.1", { prerelease: false }),
    ])
  ).toThrow("prerelease");
});

test("release source must be a tagged commit on main with the selected public package version", () => {
  const root = mkdtempSync(join(tmpdir(), "release-source-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  const target = resolvePackage("marbles");
  try {
    git("init", "--initial-branch=main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Release test");
    git("config", "commit.gpgsign", "false");
    mkdirSync(join(root, target.directory), { recursive: true });
    const path = join(root, target.directory, "package.json");
    const manifest = { name: target.name, private: false, version: "0.0.1" };
    writeFileSync(path, JSON.stringify(manifest));
    git("add", ".");
    git("commit", "-m", "feat: first release");
    const sha = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", sha);
    git(
      "-c",
      "tag.gpgsign=false",
      "tag",
      "-a",
      "marbles-v0.0.1",
      "-m",
      "alpha"
    );
    expect(resolveReleaseCommit(root, target, "marbles-v0.0.1", "0.0.1")).toBe(
      sha
    );
    expect(() =>
      resolveReleaseCommit(root, target, "marbles-v0.0.1", "0.0.2")
    ).toThrow("public");
    expect(() =>
      resolveReleaseCommit(
        root,
        { ...target, name: "wrong" },
        "marbles-v0.0.1",
        "0.0.1"
      )
    ).toThrow("public");
    expect(() =>
      resolveReleaseCommit(root, target, "marbles-v0.0.2", "0.0.2")
    ).toThrow();
    writeFileSync(
      path,
      JSON.stringify({ ...manifest, private: true, version: "0.0.2" })
    );
    git("add", ".");
    git("commit", "-m", "feat: unreleased branch work");
    git("-c", "tag.gpgsign=false", "tag", "marbles-v0.0.2");
    expect(() =>
      resolveReleaseCommit(root, target, "marbles-v0.0.2", "0.0.2")
    ).toThrow();
    git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
    expect(() =>
      resolveReleaseCommit(root, target, "marbles-v0.0.2", "0.0.2")
    ).toThrow("public");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
