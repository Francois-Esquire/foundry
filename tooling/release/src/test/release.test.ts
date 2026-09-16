import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { YAML } from "bun";
import {
  discoverWorkspaces,
  extractReleaseNotes,
  publicWorkspaces,
  releaseVersion,
  validateTag,
  type Workspace,
} from "../release";

const INSTALL_COMMAND = /(?:npm|bun|npx|bunx)\s+(?:ci|install|add|exec|run)/;

function workspace(
  name: string,
  options: Partial<Workspace["manifest"]> = {}
): Workspace {
  return {
    directory: `packages/${name}`,
    manifest: {
      name,
      scripts: { "test:package": "bun test" },
      version: "0.1.0",
      ...options,
    },
  };
}

test("discovers manifest workspace patterns including future public packages", () => {
  const root = mkdtempSync(join(tmpdir(), "release-discovery-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        private: true,
        workspaces: ["apps/*", "packages/*", "tooling/*"],
      })
    );
    for (const directory of [
      "apps/quirks",
      "packages/future",
      "tooling/private",
    ]) {
      mkdirSync(join(root, directory), { recursive: true });
      writeFileSync(
        join(root, directory, "package.json"),
        JSON.stringify(
          workspace(directory, { private: directory === "tooling/private" })
            .manifest
        )
      );
    }
    expect(
      publicWorkspaces(discoverWorkspaces(root)).map((pkg) => pkg.manifest.name)
    ).toEqual(["apps/quirks", "packages/future"]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("public dependencies precede consumers and private packages are excluded", () => {
  const packages = publicWorkspaces([
    workspace("consumer", { dependencies: { library: "workspace:*" } }),
    workspace("private", { private: true }),
    workspace("library"),
  ]);
  expect(packages.map((pkg) => pkg.manifest.name)).toEqual([
    "library",
    "consumer",
  ]);
});

test("rejects private runtime dependencies in every dependency category", () => {
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    expect(() =>
      publicWorkspaces([
        workspace("consumer", { [field]: { secret: "workspace:*" } }),
        workspace("secret", { private: true }),
      ])
    ).toThrow("private package secret");
  }
});

test("rejects cycles, invalid versions, missing consumer checks, and no public packages", () => {
  expect(() =>
    publicWorkspaces([
      workspace("a", { dependencies: { b: "workspace:*" } }),
      workspace("b", { dependencies: { a: "workspace:*" } }),
    ])
  ).toThrow("Cyclic");
  expect(() =>
    publicWorkspaces([workspace("bad", { version: "01.2.3" })])
  ).toThrow("Invalid version");
  expect(() => publicWorkspaces([workspace("bad", { scripts: {} })])).toThrow(
    "test:package"
  );
  expect(() =>
    publicWorkspaces([workspace("private", { private: true })])
  ).toThrow("No non-private");
});

test("requires one version and a matching tag, including prereleases", () => {
  expect(releaseVersion([workspace("one"), workspace("two")])).toBe("0.1.0");
  expect(() =>
    releaseVersion([workspace("one"), workspace("two", { version: "0.2.0" })])
  ).toThrow("share the release version");
  expect(() => validateTag("0.1.0", "branch", "main")).toThrow("release tag");
  expect(() => validateTag("0.1.0", "tag", "v0.2.0")).toThrow("release tag");
  expect(() => validateTag("0.1.0", "tag", "v0.1.0")).not.toThrow();
  expect(() =>
    validateTag("0.2.0-beta.1", "tag", "v0.2.0-beta.1")
  ).not.toThrow();
});

test("extracts only the current release and rejects absent or empty notes", () => {
  const notes =
    "# [0.2.0](url)\n\n### Features\n\n* A change\n\n## 0.1.0\n\n* Old change\n";
  expect(extractReleaseNotes(notes, "0.2.0")).toBe(
    "# [0.2.0](url)\n\n### Features\n\n* A change\n"
  );
  expect(() => extractReleaseNotes(notes, "0.3.0")).toThrow(
    "No changelog entry"
  );
  expect(() =>
    extractReleaseNotes("## 0.2.0\n\n## 0.1.0\nOld", "0.2.0")
  ).toThrow("Empty changelog");
});

interface Workflow {
  jobs: Record<
    string,
    | {
        environment?: string;
        needs?: string[];
        permissions?: Record<string, string>;
        steps: {
          uses?: string;
          run?: string;
          with?: Record<string, unknown>;
        }[];
      }
    | undefined
  >;
  on: { push: { tags: string[] }; workflow_dispatch: unknown };
  permissions: Record<string, string>;
}

test("publishing requires tested artifacts and keeps installation out of the OIDC job", () => {
  const root = resolve(import.meta.dirname, "../../../..");
  const workflow = YAML.parse(
    readFileSync(join(root, ".github/workflows/publish.yml"), "utf8")
  ) as Workflow;
  const build = workflow.jobs.build;
  const publish = workflow.jobs.publish;
  expect(build).toBeDefined();
  expect(publish).toBeDefined();
  if (!(build && publish)) {
    throw new Error("Missing release jobs");
  }
  expect(workflow.on.push.tags).toEqual(["v*"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(build.permissions?.["id-token"]).toBeUndefined();
  expect(publish.needs).toEqual(["build"]);
  expect(publish.environment).toBe("npm");
  expect(publish.permissions?.["id-token"]).toBe("write");
  const buildCommands = build.steps.map((step) => step.run ?? "").join("\n");
  expect(buildCommands).toContain("bun install --frozen-lockfile");
  expect(buildCommands).toContain("bun run release:check --tag");
  expect(buildCommands.indexOf("bun run test")).toBeLessThan(
    buildCommands.indexOf("bun run release:pack")
  );
  const commands = publish.steps.map((step) => step.run ?? "").join("\n");
  expect(commands).toContain("npm publish");
  expect(commands).toContain("--ignore-scripts --access public");
  expect(commands).toContain("npm >=11.5.1");
  expect(commands).toContain("artifact/packages/*/package.tgz");
  expect(commands).not.toMatch(INSTALL_COMMAND);
  expect(
    publish.steps.some((step) => step.uses?.startsWith("actions/checkout"))
  ).toBe(false);
  expect(
    publish.steps.some((step) => step.uses?.startsWith("actions/cache"))
  ).toBe(false);
  const setupNode = publish.steps.find((step) =>
    step.uses?.startsWith("actions/setup-node@")
  );
  expect(setupNode).toBeDefined();
  expect(setupNode?.with?.["package-manager-cache"]).toBe(false);
  const upload = build.steps.find((step) =>
    step.uses?.startsWith("actions/upload-artifact@")
  );
  const download = publish.steps.find((step) =>
    step.uses?.startsWith("actions/download-artifact@")
  );
  expect(upload).toBeDefined();
  expect(download).toBeDefined();
  expect(upload?.with?.name).toBe(download?.with?.name);
  expect(upload?.with?.path).toContain(".cache/release/packages/*/package.tgz");
});
