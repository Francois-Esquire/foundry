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
    privateImports('const config = `import { step } from "@foundry/quirks";`;')
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
  const consumer = mkdtempSync(join(tmpdir(), "quirks-package-"));
  const standalone = mkdtempSync(join(tmpdir(), "quirks-global-"));
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
        dependencies: { "@foundry/quirks": `file:${archive}` },
        name: "quirks-package-consumer",
        private: true,
        type: "module",
      })
    );
    run("bun", ["install"], consumer);
    const installed = join(consumer, "node_modules/@foundry/quirks");
    const manifest = JSON.parse(
      readFileSync(join(installed, "package.json"), "utf8")
    );
    expect(manifest.private).toBe(false);
    expect(manifest.repository.directory).toBe("apps/quirks");
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
      join(consumer, "quirks.config.ts"),
      `
import { step, workflow } from "@foundry/quirks";
const greet = step("packed-greet", async (_context, name: string) => ({ greeting: "Hello " + name }));
workflow<string, { greeting: string }>("packed-workflow", (graph) => {
  graph.step("greet", greet, ({ input }) => input).output(({ greet }) => greet);
});
`
    );
    writeFileSync(
      join(consumer, "types.ts"),
      `
import { step } from "@foundry/quirks";
step("typed", async (_context, input: string) => input.length);
// @ts-expect-error Step names must be strings.
step(123, async () => true);
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
      ],
      consumer
    );
    const cli = join(consumer, "node_modules/.bin/quirks");
    for (const command of [[], ["run"]]) {
      const terminal = await inspectDashboard(cli, consumer, command);
      expect(terminal.code).toBe(0);
      expect(terminal.output).toContain("Triggers");
      expect(terminal.output).toContain("Runs");
    }
    expect(run("bun", [cli, "--help"], consumer)).toContain(
      "programmable local behaviors"
    );
    expect(run("bun", [cli, "list", "--dry"], consumer)).toContain(
      "[workflow] packed-workflow"
    );
    expect(
      run(
        "bun",
        [cli, "once", "packed-workflow", "--dry", "--input", '"tarball"'],
        consumer
      )
    ).toContain("Hello tarball");
    expect(
      run("bun", [cli, "status", "--state", join(consumer, "state")], consumer)
    ).toBeDefined();
    writeFileSync(
      join(standalone, "quirks.config.ts"),
      `
import { step } from "@foundry/quirks";
step("inventory", async ({ workspaces, workspace }) => {
  const directory = await workspaces.load({ path: workspace.root });
  const { entries } = await directory.refresh();
  return { paths: entries.filter(entry => entry.type === "file").map(file => file.path) };
});
`
    );
    expect(run(cli, ["list", "--dry"], standalone)).toContain("inventory");
    const inventory = execFileSync(
      process.execPath,
      [cli, "once", "inventory", "--dry"],
      {
        cwd: standalone,
        encoding: "utf8",
        env: { ...process.env, PATH: "" },
        timeout: 30_000,
      }
    );
    expect(inventory).toContain("quirks.config.ts");
    for (const directory of [consumer, standalone]) {
      const config = join(directory, "quirks.config.ts");
      writeFileSync(config, 'import "@foundry/quirks/prebuilt";');
      expect(run(cli, ["list", "--dry"], directory)).not.toContain("[step]");
      writeFileSync(
        config,
        'import { summarizeCodebase } from "@foundry/quirks/prebuilt"; summarizeCodebase({ name: "packed-summary" });'
      );
      expect(
        run(cli, ["list", "--dry"], directory)
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
        [cli, "once", "packed-summary", "--dry", "--harness", "codex"],
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
