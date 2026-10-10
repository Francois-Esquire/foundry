import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "bun";
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isExportDeclaration,
  isImportDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isStringLiteral,
  type Node,
  ScriptTarget,
  SyntaxKind,
} from "typescript";
import {
  LIBRARY_SCRIPT,
  NODE_SCRIPT,
  TYPES_CONFIG,
  TYPES_SOURCE,
  VALUE_EXPORTS,
} from "./helpers/package-consumer";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const FIXTURE = join(PACKAGE_ROOT, "test/lib/fixtures/semantics");
const SERVER_URL = /Atlas: (http:\/\/\S+)/;
const SERVER_TIMEOUT_MS = 20_000;
// Packing, installing, and a fixture scan take well over Bun's 5s default.
const TEST_TIMEOUT_MS = 300_000;
const COMMAND_TIMEOUT_MS = 300_000;

/**
 * Every module a source file imports or re-exports from, statically, by
 * type, or dynamically. A syntax walk rather than a text search, because the
 * bundle carries `@foundry/` in string literals that are not imports.
 */
function importedModules(source: string): string[] {
  const imports: string[] = [];
  function inspect(node: Node) {
    let specifier: Node | undefined;
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      specifier = node.moduleSpecifier;
    } else if (isImportTypeNode(node) && isLiteralTypeNode(node.argument)) {
      specifier = node.argument.literal;
    } else if (
      isCallExpression(node) &&
      node.expression.kind === SyntaxKind.ImportKeyword
    ) {
      [specifier] = node.arguments;
    }
    if (specifier && isStringLiteral(specifier)) {
      imports.push(specifier.text);
    }
    forEachChild(node, inspect);
  }
  inspect(createSourceFile("package.ts", source, ScriptTarget.Latest, true));
  return imports;
}

// Mirrors Marbles' check.
function privateImports(source: string): string[] {
  return importedModules(source).filter(
    (specifier) =>
      specifier.startsWith("@foundry/") || specifier.startsWith("~/")
  );
}

test("package import inspection checks declarations and dynamic imports, not config source strings", () => {
  expect(
    privateImports(
      'import type { T } from "@foundry/private"; type X = import("@foundry/query").X; import("~/dynamic");'
    )
  ).toEqual(["@foundry/private", "@foundry/query", "~/dynamic"]);
  expect(
    privateImports('const config = `import { step } from "@foundry/marbles";`;')
  ).toEqual([]);
});

function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      env,
      timeout: COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error) {
      process.stderr.write(String(error.stdout));
    }
    if (error && typeof error === "object" && "stderr" in error) {
      process.stderr.write(String(error.stderr));
    }
    throw error;
  }
}

/** The installed package names no private package and ships no sourcemap. */
function expectSelfContained(
  packageDirectory: string,
  manifest: { dependencies: Record<string, string> }
) {
  expect(
    Object.keys(manifest.dependencies).filter((name) =>
      name.startsWith("@foundry/")
    )
  ).toEqual([]);
  const built = readdirSync(join(packageDirectory, "dist"), {
    encoding: "utf8",
    recursive: true,
  });
  expect(built.filter((file) => file.endsWith(".map"))).toEqual([]);
  for (const file of built) {
    if (file.endsWith(".js") || file.endsWith(".d.ts")) {
      expect(
        privateImports(
          readFileSync(join(packageDirectory, "dist", file), "utf8")
        )
      ).toEqual([]);
    }
  }
}

async function readServerUrl(
  stream: ReadableStream<Uint8Array>
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
    const url = SERVER_URL.exec(text)?.[1];
    if (url) {
      reader.releaseLock();
      return url;
    }
  }
  reader.releaseLock();
  throw new Error(`Server did not print its URL:\n${text}`);
}

/** The exports map, `types` first so every resolver takes the declarations. */
const EXPORTS = {
  ".": { default: "./dist/lib/index.js", types: "./dist/lib/index.d.ts" },
};
const NEEDS_BUN = "Atlas serve needs Bun (>=1.3.14).";

// One install for every test below. The fixture is copied so no test touches
// the repository copy, and its configuration directory is loaded by the
// installed config worker.
let consumer = "";
let installed = "";
let cli = "";
let workspace = "";

beforeAll(() => {
  consumer = mkdtempSync(join(tmpdir(), "atlas-package-"));
  installed = join(consumer, "node_modules/@foundry/atlas");
  cli = join(consumer, "node_modules/.bin/atlas");
  workspace = join(consumer, "workspace");
  const archive = process.env.PACKAGE_TARBALL ?? join(consumer, "package.tgz");
  if (!process.env.PACKAGE_TARBALL) {
    run(
      "bun",
      ["pm", "pack", "--ignore-scripts", "--filename", archive],
      PACKAGE_ROOT
    );
  }
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      dependencies: { "@foundry/atlas": `file:${archive}` },
      name: "atlas-package-consumer",
      private: true,
      type: "module",
    })
  );
  run("bun", ["install"], consumer);
  cpSync(FIXTURE, workspace, { recursive: true });
  mkdirSync(join(workspace, ".foundry/atlas"), { recursive: true });
  writeFileSync(
    join(workspace, ".foundry/atlas/index.ts"),
    'import type { AtlasConfig } from "@foundry/atlas";\n\nexport default { exclude: ["packages/docs-only"], rules: [{ effect: "require", operator: "internalize", subject: "packages/a" }] } satisfies AtlasConfig;\n'
  );
}, TEST_TIMEOUT_MS);

afterAll(() => {
  if (consumer) {
    rmSync(consumer, { force: true, recursive: true });
  }
});

test(
  "the tarball installs and its bin scans, reports, exports, and serves a workspace",
  async () => {
    const manifest = JSON.parse(
      readFileSync(join(installed, "package.json"), "utf8")
    );
    expect(manifest.private).toBe(false);
    expect(manifest.repository.directory).toBe("apps/atlas");
    expect(manifest.exports).toEqual(EXPORTS);
    expect(Object.keys(manifest.exports["."])).toEqual(["types", "default"]);
    expect(manifest.bin).toEqual({ atlas: "./dist/lib/atlas.js" });
    expect(readFileSync(join(installed, "CHANGELOG.md"), "utf8")).toContain(
      manifest.version
    );
    expect(readFileSync(join(installed, "LICENSE"), "utf8")).toContain("MIT");
    expect(readdirSync(installed)).not.toContain("src");
    expect(readdirSync(join(installed, "dist")).sort()).toEqual(["lib", "web"]);
    for (const file of [
      "atlas.js",
      "index.js",
      "index.d.ts",
      "semantics-worker.js",
      "config-worker.js",
    ]) {
      expect(existsSync(join(installed, "dist/lib", file))).toBe(true);
    }
    expect(existsSync(join(installed, "dist/web/index.html"))).toBe(true);
    expectSelfContained(installed, manifest);
    // One self-contained declaration file: it names no other module.
    expect(
      importedModules(
        readFileSync(join(installed, "dist/lib/index.d.ts"), "utf8")
      )
    ).toEqual([]);

    expect(run(cli, ["--help"], consumer)).toContain("atlas scan [path...]");
    const state = join(consumer, "state");
    // Started by an absolute path with no PATH: the workers must not need a
    // `bun` there. The fixture is not a Git repository, so the scan never
    // looks for git.
    const scanned = run(
      process.execPath,
      [cli, "scan", workspace, "--state", state],
      consumer,
      { ...process.env, PATH: "" }
    );
    expect(scanned).toContain("Dataset saved to ");
    const output = scanned.split("Dataset saved to ")[1]?.trim() ?? "";
    const dataset = JSON.parse(
      readFileSync(join(output, "manifest.json"), "utf8")
    );
    expect(dataset.schemaVersion).toBe(4);
    expect(dataset.coverage).toBe("complete");
    expect(
      dataset.packages
        .filter((entry: { status: string }) => entry.status === "complete")
        .map((entry: { id: string }) => entry.id)
    ).toEqual(["@s/a", "@s/b", "@s/c"]);
    expect(dataset.discovery.unitsSkipped).toContainEqual({
      name: "@s/docs-only",
      path: "packages/docs-only",
      reason: "excluded",
    });
    expect(existsSync(join(output, "internals"))).toBe(true);
    expect(existsSync(join(output, "manifests"))).toBe(false);

    // The installed bin reads the saved dataset and finds its own viewer.
    expect(
      run(cli, ["report", "@s/a", workspace, "--state", state], consumer)
    ).toContain("Target  @s/a");
    const site = join(consumer, "site");
    expect(
      run(cli, ["export", site, workspace, "--state", state], consumer)
    ).toBe(`Static viewer saved to ${site}\n`);
    expect(existsSync(join(site, "index.html"))).toBe(true);
    expect(readFileSync(join(site, "data/manifest.json"), "utf8")).toBe(
      readFileSync(join(output, "manifest.json"), "utf8")
    );

    const server = spawn(
      [cli, "serve", workspace, "--state", state, "--port", "0", "--no-open"],
      { cwd: consumer, stderr: "pipe", stdout: "pipe" }
    );
    try {
      const url = await readServerUrl(server.stdout);
      const index = await fetch(url);
      expect(index.status).toBe(200);
      expect(await index.text()).toContain("<html");
      const served = await fetch(new URL("data/manifest.json", url));
      expect(served.status).toBe(200);
      expect(await served.text()).toBe(
        readFileSync(join(output, "manifest.json"), "utf8")
      );
    } finally {
      server.kill();
      await server.exited;
    }
  },
  TEST_TIMEOUT_MS
);

test(
  "the installed library scans, reads back, and serves a workspace",
  () => {
    writeFileSync(join(consumer, "library.js"), LIBRARY_SCRIPT);
    const state = join(consumer, "library-state");
    // Under the running Bun with no PATH, as the bin is started above.
    const result = JSON.parse(
      run(
        process.execPath,
        ["library.js", workspace, state, join(consumer, "empty-state")],
        consumer,
        { ...process.env, PATH: "" }
      )
    );
    expect(result.exports).toEqual(VALUE_EXPORTS);
    expect(result.full).toMatchObject({
      internals: "@s/a",
      packages: ["@s/a:complete", "@s/b:complete", "@s/c:complete"],
      report: "@s/a",
      schemaVersion: 4,
      workspacePackages: 3,
    });
    // A workspace-level scan saves over the full one, so the full scan's
    // accessors refuse to read the replacement.
    expect(result.level).toEqual({
      internals: false,
      keys: ["manifest", "output"],
    });
    expect(result.replaced).toBe(true);
    expect(result.package).toEqual([
      "locality",
      "primitives",
      "responsibilities",
      "review",
      "rewiring",
      "topology",
    ]);
    expect(result.served.index).toBe(200);
    expect(result.served.manifest).toBe(
      readFileSync(join(result.full.output, "manifest.json"), "utf8")
    );
    expect(result.missing.notFound).toBe(true);
    expect(result.missing.message).toStartWith("No dataset found for ");
  },
  TEST_TIMEOUT_MS
);

test(
  "a TypeScript consumer typechecks against the installed declarations",
  () => {
    writeFileSync(join(consumer, "types.ts"), TYPES_SOURCE);
    writeFileSync(
      join(consumer, "tsconfig.json"),
      JSON.stringify(TYPES_CONFIG)
    );
    // The consumer's own TypeScript, installed as Atlas's dependency.
    run(
      "bun",
      [
        join(consumer, "node_modules/typescript/bin/tsc"),
        "--project",
        "tsconfig.json",
      ],
      consumer
    );
  },
  TEST_TIMEOUT_MS
);

// Under Node, `scan` starts its workers with `bun` from the PATH, so the
// running Bun's directory leads it; `serve` needs Bun itself and says so
// before anything else.
test(
  "Node imports the installed library and scans with bun on the PATH",
  () => {
    const result = JSON.parse(
      run("node", ["--input-type=module", "--eval", NODE_SCRIPT], consumer, {
        ...process.env,
        ATLAS_STATE: join(consumer, "node-state"),
        ATLAS_WORKSPACE: workspace,
        PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
      })
    );
    expect(result).toEqual({
      errors: ["DatasetNotFoundError", "DatasetReplacedError"],
      exports: VALUE_EXPORTS,
      scanned: "complete",
      serve: NEEDS_BUN,
    });
  },
  TEST_TIMEOUT_MS
);

// Last: it deletes the installed viewer.
test(
  "the installed bin names the missing viewer before it scans or serves",
  () => {
    const state = join(consumer, "state");
    // The CLI reports the resolved path; macOS temporary directories are
    // reached through a symlink.
    const viewer = join(realpathSync(installed), "dist/web");
    rmSync(viewer, { force: true, recursive: true });
    const missingViewer = `Atlas: The viewer's files are missing from ${viewer}. Reinstall the package, or build it first when running from source.\n`;
    const unserved = spawnSync(
      [cli, "serve", workspace, "--state", state, "--port", "0", "--no-open"],
      {
        cwd: consumer,
        stderr: "pipe",
        stdout: "pipe",
        timeout: SERVER_TIMEOUT_MS,
      }
    );
    expect(unserved.exitCode).toBe(1);
    expect(unserved.stderr.toString()).toBe(missingViewer);
    // The default command checks for the viewer before it scans.
    const unscanned = spawnSync(
      [cli, workspace, "--state", join(consumer, "fresh-state"), "--no-open"],
      {
        cwd: consumer,
        stderr: "pipe",
        stdout: "pipe",
        timeout: SERVER_TIMEOUT_MS,
      }
    );
    expect(unscanned.exitCode).toBe(1);
    expect(unscanned.stderr.toString()).toBe(missingViewer);
    expect(unscanned.stdout.toString()).not.toContain("saved to");
  },
  TEST_TIMEOUT_MS
);
