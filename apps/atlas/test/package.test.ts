import { expect, test } from "bun:test";
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
import { join, resolve } from "node:path";
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

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const FIXTURE = join(PACKAGE_ROOT, "test/lib/fixtures/semantics");
const SERVER_URL = /Atlas: (http:\/\/\S+)/;
const SERVER_TIMEOUT_MS = 20_000;
// Packing, installing, and a fixture scan take well over Bun's 5s default.
const TEST_TIMEOUT_MS = 300_000;
const COMMAND_TIMEOUT_MS = 300_000;

// Mirrors Marbles' check. A syntax walk rather than a text search, because
// the bundle carries `@foundry/` in string literals that are not imports.
function privateImports(source: string): string[] {
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
    if (
      specifier &&
      isStringLiteral(specifier) &&
      (specifier.text.startsWith("@foundry/") ||
        specifier.text.startsWith("~/"))
    ) {
      imports.push(specifier.text);
    }
    forEachChild(node, inspect);
  }
  inspect(createSourceFile("package.ts", source, ScriptTarget.Latest, true));
  return imports;
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
  installed: string,
  manifest: { dependencies: Record<string, string> }
) {
  expect(
    Object.keys(manifest.dependencies).filter((name) =>
      name.startsWith("@foundry/")
    )
  ).toEqual([]);
  const built = readdirSync(join(installed, "dist"), {
    encoding: "utf8",
    recursive: true,
  });
  expect(built.filter((file) => file.endsWith(".map"))).toEqual([]);
  for (const file of built) {
    if (file.endsWith(".js") || file.endsWith(".d.ts")) {
      expect(
        privateImports(readFileSync(join(installed, "dist", file), "utf8"))
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

test(
  "the tarball installs and its bin scans and serves a workspace",
  async () => {
    const consumer = mkdtempSync(join(tmpdir(), "atlas-package-"));
    try {
      const archive =
        process.env.PACKAGE_TARBALL ?? join(consumer, "package.tgz");
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

      const installed = join(consumer, "node_modules/@foundry/atlas");
      const manifest = JSON.parse(
        readFileSync(join(installed, "package.json"), "utf8")
      );
      expect(manifest.private).toBe(false);
      expect(manifest.repository.directory).toBe("apps/atlas");
      expect(readFileSync(join(installed, "CHANGELOG.md"), "utf8")).toContain(
        manifest.version
      );
      expect(readFileSync(join(installed, "LICENSE"), "utf8")).toContain("MIT");
      expect(readdirSync(installed)).not.toContain("src");
      expect(existsSync(join(installed, "dist/cli/atlas.js"))).toBe(true);
      expect(existsSync(join(installed, "dist/cli/semantics-worker.js"))).toBe(
        true
      );
      expect(existsSync(join(installed, "dist/cli/config-worker.js"))).toBe(
        true
      );
      expect(existsSync(join(installed, "dist/web/index.html"))).toBe(true);
      expectSelfContained(installed, manifest);

      const cli = join(consumer, "node_modules/.bin/atlas");
      expect(run(cli, ["--help"], consumer)).toContain("atlas scan [path...]");

      // The fixture is copied so the scan never touches the repository copy.
      const workspace = join(consumer, "workspace");
      cpSync(FIXTURE, workspace, { recursive: true });
      // Its configuration directory is loaded by the installed config worker.
      mkdirSync(join(workspace, ".foundry/atlas"), { recursive: true });
      writeFileSync(
        join(workspace, ".foundry/atlas/index.ts"),
        'import type { AtlasConfig } from "@foundry/atlas";\n\nexport default { exclude: ["packages/docs-only"] } satisfies AtlasConfig;\n'
      );
      const state = join(consumer, "state");
      // Started by an absolute path with no PATH: the workers must not need
      // a `bun` there. The fixture is not a Git repository, so the scan
      // never looks for git.
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

      const serve = [
        cli,
        "serve",
        workspace,
        "--state",
        state,
        "--port",
        "0",
        "--no-open",
      ];
      const server = spawn(serve, {
        cwd: consumer,
        stderr: "pipe",
        stdout: "pipe",
      });
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

      // The CLI reports the resolved path; macOS temporary directories are
      // reached through a symlink.
      const viewer = join(realpathSync(installed), "dist/web");
      rmSync(viewer, { force: true, recursive: true });
      const unserved = spawnSync(serve, {
        cwd: consumer,
        stderr: "pipe",
        stdout: "pipe",
        timeout: SERVER_TIMEOUT_MS,
      });
      const missingViewer = `Atlas: The viewer's files are missing from ${viewer}. Reinstall the package, or build it first when running from source.\n`;
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
    } finally {
      rmSync(consumer, { force: true, recursive: true });
    }
  },
  TEST_TIMEOUT_MS
);
