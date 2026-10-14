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
  packRelease,
  publicWorkspaces,
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
      "apps/marbles",
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
    ).toEqual(["apps/marbles", "packages/future"]);
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

test("public apps can have independent versions and private development dependencies", () => {
  const packages = publicWorkspaces([
    workspace("marbles", {
      devDependencies: { library: "workspace:*" },
      version: "0.0.1",
    }),
    workspace("atlas", { version: "0.3.0" }),
    workspace("library", { private: true }),
  ]);
  expect(
    packages.map(({ manifest }) => [manifest.name, manifest.version])
  ).toEqual([
    ["marbles", "0.0.1"],
    ["atlas", "0.3.0"],
  ]);
});

test("packing refuses a tarball modified by its consumer check", () => {
  const root = mkdtempSync(join(tmpdir(), "release-artifact-"));
  const pkg = workspace("fixture", {
    scripts: {
      "test:package":
        'bun -e \'require("node:fs").appendFileSync(process.env.PACKAGE_TARBALL, "tampered")\'',
    },
  });
  try {
    mkdirSync(join(root, pkg.directory), { recursive: true });
    writeFileSync(
      join(root, pkg.directory, "package.json"),
      JSON.stringify(pkg.manifest)
    );
    expect(() => packRelease(root, [pkg])).toThrow(
      "Consumer check modified the tarball"
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

interface Workflow {
  jobs: Record<
    string,
    | {
        environment?: string | { name: string; url?: string };
        if?: string;
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
  on: Record<string, unknown>;
  permissions: Record<string, string>;
}

const ACTION_SHA = /@[a-f0-9]{40}$/;

test("PR validation and Pages deployment do not run the same checks on a main push", () => {
  const root = resolve(import.meta.dirname, "../../../..");
  const ci = YAML.parse(
    readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")
  ) as Workflow;
  expect(Object.keys(ci.on).sort()).toEqual([
    "pull_request",
    "workflow_dispatch",
  ]);
  expect(ci.permissions).toEqual({ contents: "read" });
  expect(ci.jobs["deploy-docs"]).toBeUndefined();
  expect(
    ci.jobs.docs?.steps.map(({ run }) => run ?? "").join("\n")
  ).not.toContain("docs:typecheck");
  const docs = YAML.parse(
    readFileSync(join(root, ".github/workflows/docs.yml"), "utf8")
  ) as Workflow;
  expect(Object.keys(docs.on).sort()).toEqual(["push", "workflow_dispatch"]);
  expect(docs.on.push).toEqual({ branches: ["main"] });
  expect(docs.jobs.deploy?.needs).toEqual(["build"]);
  expect(docs.jobs.deploy?.environment).toMatchObject({ name: "github-pages" });
  expect(docs.jobs.deploy?.permissions).toEqual({
    "id-token": "write",
    pages: "write",
  });
});

test("only manual main-branch dispatch can publish an isolated tested artifact", () => {
  const root = resolve(import.meta.dirname, "../../../..");
  const workflow = YAML.parse(
    readFileSync(join(root, ".github/workflows/publish.yml"), "utf8")
  ) as Workflow;
  const { resolve: resolver, build, publish } = workflow.jobs;
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(resolver?.if).toContain("refs/heads/main");
  expect(build?.needs).toEqual(["resolve"]);
  expect(publish?.needs).toEqual(["resolve", "build"]);
  expect(publish?.environment).toBe("npm");
  expect(publish?.if).toBe("vars.NPM_PUBLISH_ENABLED == 'true'");
  expect(publish?.permissions).toEqual({
    contents: "read",
    "id-token": "write",
  });
  expect(build?.permissions?.["id-token"]).toBeUndefined();
  expect(resolver?.permissions?.["id-token"]).toBeUndefined();
  const commands =
    publish?.steps.map((step) => step.run ?? "").join("\n") ?? "";
  expect(commands).toContain(
    "npm publish artifact/package.tgz --ignore-scripts --access public"
  );
  expect(commands).toContain("npm >=11.5.1");
  expect(commands).toContain("sha256sum --check");
  expect(commands).not.toMatch(INSTALL_COMMAND);
  expect(
    publish?.steps.some((step) => step.uses?.startsWith("actions/checkout"))
  ).toBe(false);
  expect(
    publish?.steps.some((step) => step.uses?.startsWith("actions/cache"))
  ).toBe(false);
  for (const job of Object.values(workflow.jobs)) {
    if (!job) {
      throw new Error("Missing workflow job");
    }
    for (const step of job.steps) {
      if (step.uses) {
        expect(step.uses).toMatch(ACTION_SHA);
      }
    }
  }
});

test("release preparation cannot publish to npm or dispatch publishing", () => {
  const root = resolve(import.meta.dirname, "../../../..");
  const text = readFileSync(
    join(root, ".github/workflows/release.yml"),
    "utf8"
  );
  const workflow = YAML.parse(text) as Workflow;
  expect(text).not.toContain("id-token:");
  expect(text).not.toContain("npm publish");
  expect(text).not.toContain("gh workflow run");
  expect(text).not.toContain("workflow_call");
  expect(workflow.jobs.release?.if).toContain("refs/heads/main");
});
