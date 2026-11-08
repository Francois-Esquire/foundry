import { execFileSync } from "node:child_process";
import {
  cpSync,
  globSync,
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
        name?: string;
        needs?: string[];
        permissions?: Record<string, string>;
        strategy?: { matrix?: Record<string, unknown> };
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

// One runner: a package's `test` is one Vitest run, on Bun where the
// package's code needs it, and no script reaches for `bun test`.
const VITEST_RUN =
  /^(vitest|bun \.\.\/\.\.\/node_modules\/vitest\/vitest\.mjs) run(?: --project unit)?$/;
const BUN_TEST = /\bbun test\b/;

test("every workspace tests with one Vitest run", () => {
  const root = resolve(import.meta.dirname, "../../../..");
  const { workspaces } = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8")
  ) as { workspaces: string[] };
  const manifests = workspaces.flatMap((pattern) =>
    globSync(`${pattern}/package.json`, { cwd: root })
  );
  expect(manifests.length).toBeGreaterThan(10);
  for (const manifest of manifests) {
    const { scripts = {} } = JSON.parse(
      readFileSync(join(root, manifest), "utf8")
    ) as { scripts?: Partial<Record<string, string>> };
    for (const [name, command = ""] of Object.entries(scripts)) {
      expect(BUN_TEST.test(command), `${manifest} ${name}`).toBe(false);
    }
    if (scripts.test !== undefined) {
      expect(scripts.test, manifest).toMatch(VITEST_RUN);
    }
  }
});

test("CI runs parallel jobs behind one Verify check, main keeps its tested archives, and Pages deploys separately", () => {
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
  expect(ci.concurrency?.group).toBe(
    `${actionExpression("github.workflow")}-${actionExpression(
      "github.event_name == 'pull_request' && github.ref || github.event_name == 'push' && github.sha || github.run_id"
    )}`
  );
  const job = (id: string) => {
    const found = ci.jobs[id];
    if (!found) {
      throw new Error(`Missing CI job ${id}`);
    }
    return found;
  };
  const commandsOf = (id: string) =>
    job(id).steps.flatMap(({ run }) => (run ? [run] : []));
  const work = ["docs", "release", "test", "test-spyglass", "validate"];
  expect(Object.keys(ci.jobs).sort()).toEqual([...work, "verify"].sort());
  for (const id of Object.keys(ci.jobs)) {
    expect(job(id).permissions).toBeUndefined();
    for (const command of ["check", "lint:deps", "typecheck", "dead-code"]) {
      expect(commandsOf(id)).not.toContain(`bun run ${command}`);
    }
    expect(commandsOf(id)).not.toContain("bun run docs:typecheck");
  }

  // Branch protection requires Verify. It runs even when a job fails, and
  // fails then, because a skipped required check would let the merge through.
  const verify = job("verify");
  expect(verify.name).toBe("Verify");
  expect(verify.if).toBe("always()");
  expect([...(verify.needs ?? [])].sort()).toEqual(work);
  expect(commandsOf("verify").join("\n")).toContain(
    'all(.[]; .result == "success")'
  );

  const setup = YAML.parse(
    readFileSync(join(root, ".github/actions/setup/action.yml"), "utf8")
  ) as {
    inputs: { "turbo-cache"?: { default?: string } };
    runs: { steps: { run?: string }[] };
  };
  expect(setup.inputs["turbo-cache"]?.default).toBe("");
  expect(
    setup.runs.steps.filter(
      ({ run }) => run === "bun install --frozen-lockfile"
    )
  ).toHaveLength(1);
  for (const id of work) {
    expect(
      job(id).steps.filter(({ uses }) => uses === "./.github/actions/setup")
    ).toHaveLength(1);
    expect(commandsOf(id).some((command) => command.includes("install"))).toBe(
      false
    );
  }

  expect(commandsOf("validate")).toContain("bun run validate");

  // Each package's tests run in exactly one test job: affected on a pull
  // request, all of them on main and manual runs.
  const testSteps = {
    test: [
      "bun run test --affected --filter=!@foundry.sh/spyglass --concurrency=2 --continue=always",
      "bun run test --filter=!@foundry.sh/spyglass --concurrency=2 --continue=always",
    ],
    "test-spyglass": [
      "bun run turbo run test --affected --filter=@foundry.sh/spyglass -- --shard=$SHARD/3",
      "bun run turbo run test --filter=@foundry.sh/spyglass -- --shard=$SHARD/3",
    ],
  };
  for (const [id, [affected, all]] of Object.entries(testSteps)) {
    const { steps } = job(id);
    expect(steps.find(({ run }) => run === affected)?.if).toBe(
      "github.event_name == 'pull_request'"
    );
    expect(steps.find(({ run }) => run === all)?.if).toBe(
      "github.event_name != 'pull_request'"
    );
  }
  // Spyglass's shards together run its whole `test` task, one Vitest run,
  // each shard with a Turbo cache of its own.
  const spyglass = job("test-spyglass");
  expect(spyglass.strategy?.matrix).toEqual({ shard: [1, 2, 3] });
  for (const { run, env } of spyglass.steps) {
    if (run?.includes("--shard")) {
      expect(env?.SHARD).toBe(actionExpression("matrix.shard"));
    }
  }
  for (const action of [
    "./.github/actions/setup",
    "./.github/actions/save-turbo-cache",
  ]) {
    expect(
      spyglass.steps.find(({ uses }) => uses === action)?.with?.["turbo-cache"]
    ).toBe(`test-spyglass-${actionExpression("matrix.shard")}`);
  }

  // The archives a release attaches are built from source alone: the
  // release job restores no Turbo cache and builds before it packs.
  const release = job("release");
  const releaseCommands = commandsOf("release");
  expect(
    release.steps.some(
      ({ uses, with: inputs }) =>
        uses?.startsWith("actions/cache") || inputs?.["turbo-cache"]
    )
  ).toBe(false);
  expect(releaseCommands.indexOf("bun run build")).toBeGreaterThanOrEqual(0);
  expect(releaseCommands.indexOf("bun run build")).toBeLessThan(
    releaseCommands.indexOf("bun run release:pack")
  );
  expect(releaseCommands).toContain("bun run --cwd tooling/release test");
  const upload = release.steps.find(({ uses }) =>
    uses?.startsWith("actions/upload-artifact@")
  );
  expect(upload?.if).toBe(
    "github.event_name == 'push' || github.event_name == 'workflow_dispatch'"
  );
  expect(
    release.steps.find(
      ({ run }) => run === "git merge-base --is-ancestor HEAD origin/main"
    )?.if
  ).toBe("github.event_name == 'workflow_dispatch'");
  expect(upload?.with).toMatchObject({
    "if-no-files-found": "error",
    "include-hidden-files": true,
    name: "release-packages",
  });
  expect(String(upload?.with?.path)).toContain(".cache/release/packages.json");
  expect(
    release.steps.indexOf(upload as (typeof release.steps)[number])
  ).toBeGreaterThan(
    release.steps.findIndex(({ run }) => run === "bun run release:pack")
  );

  expect(commandsOf("docs")).toContain("bun run docs:check");
  expect(commandsOf("docs")).toContain("bun run docs:build");
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
