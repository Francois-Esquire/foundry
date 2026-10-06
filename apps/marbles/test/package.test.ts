import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

import { inspectDashboard } from "./helpers/terminal";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
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

function run(command: string, args: string[], cwd: string): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
    });
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error) {
      process.stderr.write(String(error.stdout));
    }
    throw error;
  }
}

test("the tarball installs and shares the library registry with the CLI", async () => {
  const consumer = mkdtempSync(join(tmpdir(), "marbles-package-"));
  const standalone = mkdtempSync(join(tmpdir(), "marbles-global-"));
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
        dependencies: { "@foundry/marbles": `file:${archive}`, zod: "^4.4.3" },
        name: "marbles-package-consumer",
        private: true,
        type: "module",
      })
    );
    run("bun", ["install"], consumer);
    const installed = join(consumer, "node_modules/@foundry/marbles");
    const manifest = JSON.parse(
      readFileSync(join(installed, "package.json"), "utf8")
    );
    expect(manifest.private).toBe(false);
    expect(manifest.repository.directory).toBe("apps/marbles");
    expect(readFileSync(join(installed, "CHANGELOG.md"), "utf8")).toContain(
      manifest.version
    );
    expect(readFileSync(join(installed, "LICENSE"), "utf8")).toContain("MIT");
    expect(readdirSync(installed)).not.toContain("src");
    for (const file of readdirSync(join(installed, "dist"))) {
      if (file.endsWith(".js") || file.endsWith(".d.ts")) {
        expect(
          privateImports(readFileSync(join(installed, "dist", file), "utf8"))
        ).toEqual([]);
      }
    }
    writeFileSync(
      join(consumer, "marbles.config.ts"),
      `
import { step, workflow } from "@foundry/marbles";
import { z } from "zod";
const named = z.object({ name: z.string() });
const greet = step("packed-greet").input(named).do(({ input }) => ({ greeting: \`Hello \${input.name}\` }));
export const packedWorkflow = workflow("packed-workflow").input(named).do(({ input }) => greet({}, { name: input.name }));
`
    );
    writeFileSync(
      join(consumer, "types.ts"),
      `
import { step } from "@foundry/marbles";
import { z } from "zod";
step("typed").input(z.object({ text: z.string() })).do(({ input }) => input.text.length);
// @ts-expect-error Step names must be strings.
step(123);
`
    );
    // A host builds the engine itself, from instances of the base classes
    // taken from the package's own copies, and tells it what can run.
    writeFileSync(
      join(consumer, "host.ts"),
      `
import { packedWorkflow } from "./marbles.config";
import { step } from "@foundry/marbles";
import { ArtifactManager, Engine, InMemoryArtifactStore, InMemorySessionStore, ModelManager, WorkspaceSystem, directory, git, nodeObserver } from "@foundry/marbles/lib";
const inventory = step("host-inventory").do(async ({ workspaces }) => (await workspaces.current.files()).length);
const root = ".";
const instances = {
  artifacts: new ArtifactManager({ store: new InMemoryArtifactStore() }),
  containers: () => Promise.reject(new Error("this host has no sandbox runtime")),
  models: new ModelManager(),
  sessions: new InMemorySessionStore(),
  workspaces: new WorkspaceSystem().extend(directory({ observer: nodeObserver }), git()),
};
const engine = new Engine({ ...instances, root, workspaceId: "host" });
// @ts-expect-error An engine needs every instance.
new Engine({ root, workspaceId: "host" });
engine.define(packedWorkflow);
engine.define(inventory);
// The managers answer on the engine itself, before anything runs.
const direct = (await engine.workspaces.current.files()).includes("host.ts");
await engine.start();
const greeted = await engine.run<{ greeting: string }>("packed-workflow", { name: "host" });
const files = await engine.run<number>("host-inventory", {});
const listed = engine.definitions().map((entry) => entry.name).join(",");
await engine.stop();
await engine.dispose();
console.log(greeted.greeting, files > 0 && direct ? "sees files" : "sees nothing", listed);
`
    );
    run(
      "bun",
      [
        resolve(PACKAGE_ROOT, "../../node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "esnext",
        "--module",
        "preserve",
        "--moduleResolution",
        "bundler",
        "types.ts",
        "host.ts",
      ],
      consumer
    );
    expect(run("bun", ["host.ts"], consumer)).toContain(
      "Hello host sees files packed-workflow,host-inventory"
    );
    const cli = join(consumer, "node_modules/.bin/marbles");
    for (const command of [[], ["run"]]) {
      const terminal = await inspectDashboard(cli, consumer, command);
      expect(terminal.code).toBe(0);
      expect(terminal.output).toContain("Triggers");
      expect(terminal.output).toContain("Runs");
    }
    expect(run("bun", [cli, "--help"], consumer)).toContain(
      "programmable workspace automation"
    );
    expect(run("bun", [cli, "list", "--dry-run"], consumer)).toContain(
      "[workflow] packed-workflow"
    );
    expect(
      run(
        "bun",
        [
          cli,
          "roll",
          "packed-workflow",
          "--dry-run",
          "--input",
          '{"name":"tarball"}',
        ],
        consumer
      )
    ).toContain("Hello tarball");
    expect(
      run("bun", [cli, "status", "--state", join(consumer, "state")], consumer)
    ).toBeDefined();
    writeFileSync(join(standalone, "workspace-marker.txt"), "workspace root");
    const authoring = join(standalone, ".foundry", "marbles");
    mkdirSync(authoring, { recursive: true });
    writeFileSync(
      join(authoring, "inventory.ts"),
      `
import { step } from "@foundry/marbles";
step("inventory").do(async ({ workspaces }) => ({ paths: await workspaces.current.files() }));
`
    );
    expect(run(cli, ["list", "--dry-run"], standalone)).toContain("inventory");
    const inventory = execFileSync(
      process.execPath,
      [cli, "roll", "inventory", "--dry-run"],
      {
        cwd: standalone,
        encoding: "utf8",
        env: { ...process.env, PATH: "" },
        timeout: 30_000,
      }
    );
    expect(inventory).toContain("workspace-marker.txt");
    for (const directory of [consumer, standalone]) {
      const config =
        directory === standalone
          ? join(authoring, "inventory.ts")
          : join(directory, "marbles.config.ts");
      writeFileSync(config, 'import "@foundry/marbles/prebuilt";');
      expect(run(cli, ["list", "--dry-run"], directory)).not.toContain(
        "[step]"
      );
      writeFileSync(
        config,
        'import { summarizeCodebase } from "@foundry/marbles/prebuilt"; summarizeCodebase({ name: "packed-summary" });'
      );
      expect(
        run(cli, ["list", "--dry-run"], directory)
          .split("\n")
          .filter((line) => line.startsWith("[step]"))
      ).toEqual(["[step] packed-summary"]);
      const bin = join(directory, "bin");
      mkdirSync(bin);
      const codex = join(bin, "codex");
      writeFileSync(codex, "#!/bin/sh\nexit 1\n");
      chmodSync(codex, 0o755);
      const result = execFileSync(
        process.execPath,
        [cli, "roll", "packed-summary", "--dry-run", "--harness", "codex"],
        {
          cwd: directory,
          encoding: "utf8",
          env: { ...process.env, PATH: bin },
          timeout: 10_000,
        }
      );
      expect(result).toContain("[run] packed-summary complete");
      expect(result).toContain("Summarize this codebase");
    }
  } finally {
    rmSync(standalone, { force: true, recursive: true });
    rmSync(consumer, { force: true, recursive: true });
  }
}, 180_000);
