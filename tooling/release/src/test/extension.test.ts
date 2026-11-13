import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import YAML from "yaml";
import { missingExtensionAssets, verifyExtension } from "../extension";

interface Step {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}
interface Job {
  environment?: string;
  if?: string;
  needs?: string[];
  permissions?: Record<string, string>;
  steps?: Step[];
  uses?: string;
  with?: Record<string, string>;
}
interface Workflow {
  jobs: Record<string, Job | undefined>;
  on: Record<
    string,
    { outputs?: Record<string, { value: string } | undefined> } | undefined
  >;
  permissions?: Record<string, string>;
}

const ROOT = resolve(import.meta.dirname, "../../../..");
const ACTION_SHA = /@[a-f0-9]{40}$/;
const read = (name: string) =>
  readFileSync(join(ROOT, ".github/workflows", name), "utf8");
const load = (name: string) => YAML.parse(read(name)) as Workflow;

test("only the separate, enabled, approval-gated Marketplace workflow can publish", () => {
  const release = load("extension-release.yml");
  const publish = load("marketplace-publish.yml");
  expect(Object.keys(release.jobs)).toEqual(["assets"]);
  expect(release.on.workflow_call?.outputs?.sha256?.value).toContain(
    "jobs.assets.outputs.sha256"
  );
  expect(read("extension-release.yml")).not.toContain("id-token");
  expect(read("extension-release.yml")).not.toContain("vsce");
  expect(Object.keys(publish.on)).toEqual(["workflow_dispatch"]);
  expect(publish.permissions).toEqual({ contents: "read" });
  expect(publish.jobs.assets?.uses).toBe(
    "./.github/workflows/extension-release.yml"
  );
  expect(publish.jobs.assets?.if).toContain("refs/heads/main");
  expect(publish.jobs.publish).toMatchObject({
    environment: "marketplace",
    if: "vars.MARKETPLACE_PUBLISH_ENABLED == 'true'",
    needs: ["assets"],
    permissions: { contents: "read", "id-token": "write" },
  });
  expect(publish.jobs.assets?.permissions?.["id-token"]).toBeUndefined();
  const steps = publish.jobs.publish?.steps ?? [];
  // The OIDC job runs no lifecycle scripts and restores no cache.
  expect(steps.some(({ uses }) => uses?.startsWith("./"))).toBe(false);
  expect(steps.some(({ uses }) => uses?.startsWith("actions/cache"))).toBe(
    false
  );
  const commands = steps.map(({ run }) => run ?? "");
  expect(commands).toContain("bun install --frozen-lockfile --ignore-scripts");
  expect(commands.join("\n")).toContain("sha256sum --check --strict");
  const publication = commands.findIndex((run) => run.includes("vsce"));
  expect(commands[publication]).toBe(
    'bun run --cwd tooling/vscode-extension vsce publish --packagePath "$GITHUB_WORKSPACE/artifact/prompts.vsix" --oidc --skip-duplicate'
  );
  expect(publication).toBeGreaterThan(
    commands.findIndex((run) => run.includes("sha256sum"))
  );
  for (const workflow of [release, publish]) {
    for (const job of Object.values(workflow.jobs)) {
      for (const { uses } of job?.steps ?? []) {
        if (uses && !uses.startsWith("./")) {
          expect(uses).toMatch(ACTION_SHA);
        }
      }
    }
  }
});

test("a new extension release attaches the VSIX, then dispatches the publisher once without recursion", () => {
  const release = load("release.yml");
  expect(release.jobs.extension).toMatchObject({
    needs: ["release"],
    permissions: { actions: "read", contents: "write" },
    uses: "./.github/workflows/extension-release.yml",
  });
  const dispatch = release.jobs.marketplace;
  expect(dispatch).toMatchObject({
    if: "needs.release.outputs.extensions != '' && needs.release.outputs.extensions != '[]'",
    needs: ["release", "extension"],
    permissions: { actions: "write", contents: "read" },
  });
  expect(dispatch?.steps?.map(({ run }) => run)).toEqual([
    'gh workflow run marketplace-publish.yml --ref main -f "version=$RELEASE_VERSION"',
  ]);
  for (const name of ["extension-release.yml", "marketplace-publish.yml"]) {
    expect(read(name)).not.toContain("gh workflow run");
    expect(read(name)).not.toContain("actions: write");
  }
});

test("attachment promotes CI's VSIX of the tagged main commit and hands on the attached bytes", () => {
  const release = load("extension-release.yml");
  const steps = release.jobs.assets?.steps ?? [];
  expect(release.jobs.assets?.if).toContain("refs/heads/main");
  expect(release.jobs.assets?.permissions).toEqual({
    actions: "read",
    contents: "write",
  });
  // The tag's ancestry check needs main's history.
  expect(steps[0]?.with).toMatchObject({ "fetch-depth": 0 });
  expect(steps.map(({ run }) => run)).toContain(
    "bun tooling/release/src/extension-cli.ts"
  );
  const text = read("extension-release.yml");
  for (const rebuild of ["bun run build", "vsce package", "--clobber"]) {
    expect(text).not.toContain(rebuild);
  }
  expect(steps.at(-1)?.with?.path).toBe(
    ".cache/extension-release/attached/prompts.vsix"
  );

  const ci = load("ci.yml").jobs.release?.steps ?? [];
  const build = ci.findIndex(({ run }) => run === "bun run build");
  const tested = ci.findIndex(
    ({ run }) => run === "bun run --cwd tooling/vscode-extension test"
  );
  const upload = ci.findIndex(
    ({ with: options }) => options?.name === "release-extension"
  );
  // The release job tests the very archive it uploads.
  expect(build).toBeGreaterThanOrEqual(0);
  expect(tested).toBeGreaterThan(build);
  expect(upload).toBe(tested + 1);
  expect(String(ci[upload]?.with?.path)).toContain("dist/prompts.vsix");
  expect(String(ci[upload]?.with?.path)).toContain("dist/extension.json");
});

test("attachment adds only missing files and verifies a fully attached release on its own", () => {
  expect(missingExtensionAssets([])).toEqual([
    "prompts.vsix",
    "extension.json",
  ]);
  expect(missingExtensionAssets([{ name: "prompts.vsix" }])).toEqual([
    "extension.json",
  ]);
  expect(
    missingExtensionAssets([
      { name: "extension.json" },
      { name: "prompts.vsix" },
      { name: "notes.txt" },
    ])
  ).toEqual([]);
});

function writeArtifact(
  root: string,
  extension: Record<string, unknown>,
  record: Record<string, unknown> = {}
): string {
  mkdirSync(join(root, "extension"), { recursive: true });
  writeFileSync(
    join(root, "extension/package.json"),
    JSON.stringify(extension)
  );
  rmSync(join(root, "prompts.vsix"), { force: true });
  execFileSync("zip", ["-q", "prompts.vsix", "extension/package.json"], {
    cwd: root,
  });
  const sha256 = createHash("sha256")
    .update(readFileSync(join(root, "prompts.vsix")))
    .digest("hex");
  writeFileSync(
    join(root, "extension.json"),
    JSON.stringify({
      archive: "prompts.vsix",
      clean: true,
      name: "prompts",
      publisher: "foundry-sh",
      sha: "a".repeat(40),
      sha256,
      version: "0.0.1",
      ...record,
    })
  );
  return sha256;
}

test("extension promotion rejects mismatched identity, dirty builds, and tampered VSIX bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "extension-release-"));
  const sha = "a".repeat(40);
  const identity = {
    name: "prompts",
    publisher: "foundry-sh",
    version: "0.0.1",
  };
  try {
    const sha256 = writeArtifact(root, identity);
    expect(verifyExtension(root, "0.0.1", sha)).toBe(sha256);
    expect(() => verifyExtension(root, "0.0.2", sha)).toThrow("does not match");
    expect(() => verifyExtension(root, "0.0.1", "b".repeat(40))).toThrow(
      "does not match"
    );
    writeFileSync(join(root, "prompts.vsix"), "tampered");
    expect(() => verifyExtension(root, "0.0.1", sha)).toThrow("digest changed");

    writeArtifact(root, identity, { clean: false });
    expect(() => verifyExtension(root, "0.0.1", sha)).toThrow(
      "uncommitted sources"
    );
    // A matching checksum cannot disguise an archive for another extension.
    writeArtifact(root, { ...identity, name: "other" });
    expect(() => verifyExtension(root, "0.0.1", sha)).toThrow("VSIX identity");
    writeArtifact(root, { ...identity, version: "0.0.2" });
    expect(() => verifyExtension(root, "0.0.1", sha)).toThrow("VSIX identity");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
