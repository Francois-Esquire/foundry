import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  cpSync,
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
    workspace("spyglass", { version: "0.3.0" }),
    workspace("library", { private: true }),
  ]);
  expect(
    packages.map(({ manifest }) => [manifest.name, manifest.version])
  ).toEqual([
    ["marbles", "0.0.1"],
    ["spyglass", "0.3.0"],
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

test("group packing makes every archive available to consumers and records only selected packages", () => {
  const root = mkdtempSync(join(tmpdir(), "release-group-pack-"));
  const consumer =
    "bun -e 'const fs = require(\"node:fs\"); const archives = JSON.parse(process.env.PACKAGE_TARBALLS); if (Object.keys(archives).length !== 2 || !Object.values(archives).every((path) => fs.existsSync(path))) process.exit(1);'";
  const packages = [
    workspace("first", { scripts: { "test:package": consumer } }),
    workspace("second", { scripts: { "test:package": consumer } }),
  ];
  try {
    for (const pkg of packages) {
      mkdirSync(join(root, pkg.directory), { recursive: true });
      writeFileSync(
        join(root, pkg.directory, "package.json"),
        JSON.stringify(pkg.manifest)
      );
    }
    const digests = packRelease(root, packages);
    const artifacts = JSON.parse(
      readFileSync(join(root, ".cache/release/packages.json"), "utf8")
    );
    expect(artifacts).toMatchObject(
      packages.map(({ directory, manifest }, index) => ({
        archive: `packages/00${index}/${manifest.name}-0.1.0.tgz`,
        directory,
        name: manifest.name,
        sha256: digests[index],
        version: manifest.version,
        zip: `packages/00${index}/${manifest.name}-0.1.0.zip`,
      }))
    );
    const workflow = YAML.parse(
      readFileSync(
        resolve(
          import.meta.dirname,
          "../../../../.github/workflows/publish.yml"
        ),
        "utf8"
      )
    ) as Workflow;
    const verification = workflow.jobs.publish?.steps
      .find(({ run }) => run?.includes("node <<'NODE'"))
      ?.run?.split("node <<'NODE'\n")[1]
      ?.split("\nNODE")[0];
    if (!verification) {
      throw new Error("Missing artifact verifier");
    }
    cpSync(join(root, ".cache/release"), join(root, "artifact"), {
      recursive: true,
    });
    const verify = (expected: unknown) =>
      execFileSync("node", ["-"], {
        cwd: root,
        env: {
          ...process.env,
          EXPECTED_PACKAGES: JSON.stringify(expected),
          PACKAGE_VERSION: "0.1.0",
        },
        input: verification,
        stdio: "pipe",
      });
    const identities = packages.map(({ manifest }) => ({
      name: manifest.name,
      version: manifest.version,
    }));
    expect(() => verify(identities)).not.toThrow();
    expect(() => verify([identities[0]])).toThrow();
    writeFileSync(join(root, "artifact", artifacts[1].archive), "tampered");
    expect(() => verify(identities)).toThrow();
    expect(() => packRelease(root, packages)).toThrow("Remove .cache/release");
    rmSync(join(root, ".cache"), { recursive: true });
    const [, second] = packages;
    if (!second) {
      throw new Error("Missing fixture");
    }
    second.manifest.scripts = {
      "test:package":
        'bun -e \'require("node:fs").appendFileSync(JSON.parse(process.env.PACKAGE_TARBALLS).first, "tampered")\'',
    };
    writeFileSync(
      join(root, second.directory, "package.json"),
      JSON.stringify(second.manifest)
    );
    expect(() => packRelease(root, packages)).toThrow(
      "Consumer check modified the tarball or ZIP for first"
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("packing refuses a dependency range that excludes a package released alongside it", () => {
  const root = mkdtempSync(join(tmpdir(), "release-ranges-"));
  // bun.lock can keep a bumped workspace's previous version, and Bun packs
  // `workspace:` ranges from it.
  const packages = [
    workspace("first", { scripts: { "test:package": "true" } }),
    workspace("second", {
      dependencies: { first: "0.0.9" },
      scripts: { "test:package": "true" },
    }),
  ];
  try {
    for (const pkg of packages) {
      mkdirSync(join(root, pkg.directory), { recursive: true });
      writeFileSync(
        join(root, pkg.directory, "package.json"),
        JSON.stringify(pkg.manifest)
      );
    }
    expect(() => packRelease(root, packages)).toThrow(
      "second requires first@0.0.9, not the released 0.1.0"
    );
    rmSync(join(root, ".cache"), { recursive: true });
    const [, second] = packages;
    if (!second) {
      throw new Error("Missing fixture");
    }
    second.manifest.dependencies = { first: "^0.1.0" };
    writeFileSync(
      join(root, second.directory, "package.json"),
      JSON.stringify(second.manifest)
    );
    expect(packRelease(root, packages)).toHaveLength(2);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

interface Workflow {
  concurrency?: { group: string; "cancel-in-progress": string };
  jobs: Record<
    string,
    | {
        environment?: string | { name: string; url?: string };
        if?: string;
        needs?: string[];
        permissions?: Record<string, string>;
        strategy?: { matrix?: { include?: string } };
        steps: {
          env?: Record<string, string>;
          if?: string;
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
const ALPHA_OR_CHANNEL = /alpha|dist_tag|DIST_TAG/;
const actionExpression = (value: string): string => `\${{ ${value} }}`;

test("PR and main CI share one job, main keeps its tested archives, and Pages deploys separately", () => {
  const root = resolve(import.meta.dirname, "../../../..");
  const ci = YAML.parse(
    readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")
  ) as Workflow;
  expect(Object.keys(ci.on).sort()).toEqual([
    "pull_request",
    "push",
    "workflow_dispatch",
  ]);
  expect(ci.on.push).toEqual({ branches: ["main"] });
  expect(ci.permissions).toEqual({ contents: "read" });
  // A newer push must never cancel the build a release of main depends on.
  expect(ci.concurrency?.["cancel-in-progress"]).toBe(
    actionExpression("github.event_name == 'pull_request'")
  );
  expect(ci.concurrency?.group).toContain("github.sha");
  expect(Object.keys(ci.jobs)).toEqual(["verify"]);
  const { verify } = ci.jobs;
  expect(verify?.permissions).toBeUndefined();
  const commands = verify?.steps.flatMap(({ run }) => (run ? [run] : []));
  expect(commands).toContain("bun run validate");
  for (const command of ["check", "lint:deps", "typecheck", "dead-code"]) {
    expect(commands).not.toContain(`bun run ${command}`);
  }
  expect(commands).toContain("bun run build");
  expect(commands).toContain(
    "bun run test --affected --concurrency=1 --continue=always"
  );
  expect(commands).toContain("bun run release:pack");
  expect(
    verify?.steps.find(
      ({ run }) => run === "bun run test --concurrency=1 --continue=always"
    )?.if
  ).toBe("github.event_name != 'pull_request'");
  const upload = verify?.steps.find(({ uses }) =>
    uses?.startsWith("actions/upload-artifact@")
  );
  expect(upload?.if).toBe(
    "github.event_name == 'push' || github.event_name == 'workflow_dispatch'"
  );
  expect(
    verify?.steps.find(
      ({ run }) => run === "git merge-base --is-ancestor HEAD origin/main"
    )?.if
  ).toBe("github.event_name == 'workflow_dispatch'");
  expect(upload?.with).toMatchObject({
    "if-no-files-found": "error",
    "include-hidden-files": true,
    name: "release-packages",
  });
  expect(String(upload?.with?.path)).toContain(".cache/release/packages.json");
  const steps = verify?.steps ?? [];
  expect(steps.indexOf(upload as (typeof steps)[number])).toBeGreaterThan(
    steps.findIndex(({ run }) => run === "bun run release:pack")
  );
  expect(commands).toContain("bun run docs:check");
  expect(commands).toContain("bun run docs:build");
  expect(commands).not.toContain("bun run docs:typecheck");
  expect(
    commands?.filter((command) => command === "bun install --frozen-lockfile")
  ).toHaveLength(1);
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

test("main-branch publication keeps its isolated tested artifact and approval gate", () => {
  const root = resolve(import.meta.dirname, "../../../..");
  const workflow = YAML.parse(
    readFileSync(join(root, ".github/workflows/publish.yml"), "utf8")
  ) as Workflow;
  const { resolve: resolver, verify, publish } = workflow.jobs;
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(resolver?.if).toContain("refs/heads/main");
  expect(verify?.needs).toEqual(["resolve"]);
  expect(publish?.needs).toEqual(["resolve", "verify"]);
  expect(publish?.environment).toBe("npm");
  expect(publish?.if).toBe("vars.NPM_PUBLISH_ENABLED == 'true'");
  expect(publish?.permissions).toEqual({
    contents: "read",
    "id-token": "write",
  });
  expect(verify?.permissions?.["id-token"]).toBeUndefined();
  const verifyCommands =
    verify?.steps.map(({ run }) => run ?? "").join("\n") ?? "";
  expect(verifyCommands).toContain(" fetch ");
  expect(verifyCommands).not.toContain("release:pack");
  expect(verifyCommands).not.toContain("bun run build");
  expect(resolver?.permissions?.["id-token"]).toBeUndefined();
  const commands =
    publish?.steps.map((step) => step.run ?? "").join("\n") ?? "";
  expect(commands).toContain(
    'npm publish "artifact/$archive" --ignore-scripts --access public --tag latest '
  );
  // Product maturity is not an npm channel: every release becomes latest.
  expect(JSON.stringify(workflow)).not.toMatch(ALPHA_OR_CHANNEL);
  expect(commands).toContain("EXPECTED_PACKAGES");
  expect(commands).toContain("Artifact digest changed");
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

test("release publication starts only after assets pass and retains the separate OIDC workflow", () => {
  const root = resolve(import.meta.dirname, "../../../..");
  const text = readFileSync(
    join(root, ".github/workflows/release.yml"),
    "utf8"
  );
  const workflow = YAML.parse(text) as Workflow;
  expect(text).not.toContain("id-token:");
  expect(text).not.toContain("npm publish");
  expect(text).not.toContain("workflow_call");
  expect(workflow.jobs.release?.if).toContain("refs/heads/main");
  // Releases are cut only after main's CI build passes, never from a PR run.
  expect(workflow.on.workflow_run).toEqual({
    branches: ["main"],
    types: ["completed"],
    workflows: ["CI"],
  });
  expect(workflow.jobs.release?.if).toContain(
    "github.event.workflow_run.event == 'push'"
  );
  expect(workflow.jobs.release?.if).toContain(
    "github.event.workflow_run.conclusion == 'success'"
  );
  expect(
    workflow.jobs.release?.steps.find(({ run }) =>
      run?.includes("release:prepare")
    )?.if
  ).toBe("steps.current.outputs.current == 'true'");
  const dispatch = workflow.jobs.publish;
  expect(dispatch?.needs).toEqual(["release", "assets"]);
  expect(dispatch?.if).toBe(
    "needs.release.outputs.assets != '' && needs.release.outputs.assets != '[]'"
  );
  expect(dispatch?.permissions).toEqual({ actions: "write", contents: "read" });
  expect(dispatch?.strategy?.matrix?.include).toBe(
    actionExpression("fromJSON(needs.release.outputs.assets)")
  );
  expect(dispatch?.steps).toHaveLength(1);
  const step = dispatch?.steps[0];
  expect(step?.env).toEqual({
    GH_REPO: actionExpression("github.repository"),
    GH_TOKEN: actionExpression("github.token"),
    RELEASE_PACKAGE: actionExpression("matrix.package"),
    RELEASE_VERSION: actionExpression("matrix.version"),
  });
  expect(step?.run).toBe(
    'gh workflow run publish.yml --ref main -f "package=$RELEASE_PACKAGE" -f "version=$RELEASE_VERSION"'
  );
  expect(
    Object.values(workflow.jobs).filter(
      (job) => job?.permissions?.actions === "write"
    )
  ).toEqual([dispatch]);
});
