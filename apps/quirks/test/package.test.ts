import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const PRIVATE_IMPORT =
  /(?:from\s*|import\s*\()\s*["'](@foundry\/[^"']+|~\/[^"']+)["']/;

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

test("the tarball installs and shares the library registry with the CLI", () => {
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
        expect(readFileSync(join(installed, "dist", file), "utf8")).not.toMatch(
          PRIVATE_IMPORT
        );
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
    expect(run("bun", [cli], consumer)).toContain(
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
  const directory = await workspaces.add({ path: workspace.root });
  const { files } = await directory.refresh();
  return { paths: files.map(file => file.path) };
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
  } finally {
    rmSync(standalone, { force: true, recursive: true });
    rmSync(consumer, { force: true, recursive: true });
  }
}, 180_000);
