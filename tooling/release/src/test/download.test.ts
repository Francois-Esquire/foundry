import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RELEASE_BUILD_WORKFLOW,
  selectReleaseBuild,
  verifyBuiltPackages,
  type WorkflowRun,
} from "../download";
import { packRelease } from "../release";

const REPOSITORY = "Francois-Esquire/foundry";
const SHA = "a".repeat(40);

function run(id: number, options: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    conclusion: "success",
    created_at: `2026-10-29T00:00:0${id}Z`,
    event: "push",
    head_branch: "main",
    head_repository: { full_name: REPOSITORY },
    head_sha: SHA,
    html_url: `https://github.com/${REPOSITORY}/actions/runs/${id}`,
    id,
    path: RELEASE_BUILD_WORKFLOW,
    ...options,
  };
}

test("release archives reject untrusted runs and require successful CI at the released commit", () => {
  expect(selectReleaseBuild([run(1), run(2)], REPOSITORY, SHA).id).toBe(2);
  for (const rejected of [
    run(3, { event: "pull_request" }),
    run(3, { head_branch: "feature" }),
    run(3, { head_sha: "b".repeat(40) }),
    run(3, { path: ".github/workflows/other.yml" }),
    run(3, { conclusion: "failure" }),
    run(3, { conclusion: null }),
    run(3, { head_repository: { full_name: "fork/foundry" } }),
  ]) {
    expect(selectReleaseBuild([run(1), rejected], REPOSITORY, SHA).id).toBe(1);
    expect(() => selectReleaseBuild([rejected], REPOSITORY, SHA)).toThrow(
      `No successful CI build at ${SHA}`
    );
  }
});

test("manual CI at the release tag can regenerate the exact commit's expired archives", () => {
  const manual = run(3, {
    event: "workflow_dispatch",
    head_branch: "marbles-v0.0.3",
  });
  expect(selectReleaseBuild([run(1), manual], REPOSITORY, SHA).id).toBe(3);
  expect(() =>
    selectReleaseBuild(
      [{ ...manual, head_sha: "b".repeat(40) }],
      REPOSITORY,
      SHA
    )
  ).toThrow("No successful CI build");
  expect(() =>
    selectReleaseBuild(
      [{ ...manual, head_repository: { full_name: "fork/foundry" } }],
      REPOSITORY,
      SHA
    )
  ).toThrow("No successful CI build");
});

test("collected CI archives must match the released identities and recorded digests", () => {
  const root = mkdtempSync(join(tmpdir(), "release-collect-"));
  const packages = ["first", "second"].map((name) => ({
    directory: `packages/${name}`,
    manifest: {
      name,
      scripts: { "test:package": "true" },
      version: "0.1.0",
    },
  }));
  try {
    for (const pkg of packages) {
      mkdirSync(join(root, pkg.directory), { recursive: true });
      writeFileSync(
        join(root, pkg.directory, "package.json"),
        JSON.stringify(pkg.manifest)
      );
    }
    packRelease(root, packages);
    const destination = join(root, ".cache/release");
    const built = readFileSync(join(destination, "packages.json"), "utf8");
    const restore = () =>
      writeFileSync(join(destination, "packages.json"), built);

    expect(() =>
      verifyBuiltPackages(destination, [{ name: "second", version: "0.2.0" }])
    ).toThrow("did not package second@0.2.0");
    expect(() =>
      verifyBuiltPackages(destination, [{ name: "third", version: "0.1.0" }])
    ).toThrow("did not package third@0.1.0");
    expect(() => verifyBuiltPackages(destination, [])).toThrow(
      "No released packages"
    );

    const selected = verifyBuiltPackages(destination, [
      { name: "second", version: "0.1.0" },
    ]);
    expect(selected.map(({ name }) => name)).toEqual(["second"]);
    expect(
      JSON.parse(readFileSync(join(destination, "packages.json"), "utf8"))
    ).toEqual(selected);

    restore();
    const [first] = JSON.parse(built);
    writeFileSync(
      join(destination, "packages.json"),
      JSON.stringify([{ ...first, archive: "../../escape.tgz" }])
    );
    expect(() =>
      verifyBuiltPackages(destination, [{ name: "first", version: "0.1.0" }])
    ).toThrow("Built archive changed");

    restore();
    writeFileSync(join(destination, first.zip), "tampered");
    expect(() =>
      verifyBuiltPackages(destination, [{ name: "first", version: "0.1.0" }])
    ).toThrow("Built archive changed for first@0.1.0");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
