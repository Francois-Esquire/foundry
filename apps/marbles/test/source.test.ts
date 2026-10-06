import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { sourceFiles, sourceRoot } from "~/source";

const CLI = resolve("src/cli.ts");
function cli(root: string, ...args: string[]): string {
  return execFileSync("bun", [CLI, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
}

it("discovers modules in order, skips leading underscores, declarations and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-discovery-"));
  try {
    const source = join(root, ".foundry", "marbles");
    await mkdir(join(source, "nested"), { recursive: true });
    await mkdir(join(source, "_app"));
    await mkdir(join(source, "node_modules"));
    for (const name of [
      "z.ts",
      "a_.js",
      "nested/b.mts",
      "_helper.ts",
      "_app/server.ts",
      "node_modules/package.js",
      "types.d.ts",
      "types.d.mts",
      "README.md",
    ]) {
      await writeFile(join(source, name), "");
    }
    await symlink(source, join(source, "loop"));
    expect(sourceFiles(source)).toEqual(
      ["a_.js", "nested/b.mts", "z.ts"].map((file) => join(source, file))
    );
    expect(sourceRoot(source)).toBe(root);
    expect(sourceRoot(join(source, "z.ts"))).toBe(root);
    expect(sourceRoot(join(source, "nested", "b.mts"))).toBe(root);
    expect(sourceFiles(join(root, "missing"))).toBeUndefined();
    const empty = join(root, "empty");
    await mkdir(empty);
    expect(sourceFiles(empty)).toEqual([]);
    expect(sourceFiles(join(source, "z.ts"))).toEqual([join(source, "z.ts")]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it("loads the default folder, imports ignored helpers, and operates on the project root", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-folder-"));
  try {
    const source = join(root, ".foundry", "marbles");
    await mkdir(join(source, "_app"), { recursive: true });
    await mkdir(join(source, "nested"));
    await writeFile(
      join(root, "marbles.config.ts"),
      'throw new Error("legacy config must not load when the folder exists");'
    );
    await writeFile(
      join(source, "_unused.ts"),
      'throw new Error("ignored file ran");'
    );
    await writeFile(
      join(source, "_app", "server.ts"),
      'throw new Error("ignored directory ran");'
    );
    await writeFile(
      join(source, "_helper.ts"),
      'export const value = "helper imported";'
    );
    await writeFile(
      join(source, "inspect.ts"),
      `import { step } from "@foundry/marbles";
import { value } from "./_helper";
import "./nested/second";
step("inspect").do(({ workspaces }) => ({ root: workspaces.current.root, value }));`
    );
    await writeFile(
      join(source, "nested", "second.ts"),
      'import { step } from "@foundry/marbles"; step("second").do(() => "second");'
    );
    const listed = cli(root, "list", "--dry-run");
    expect(
      listed.split("\n").filter((line) => line.startsWith("[step]"))
    ).toEqual(["[step] second", "[step] inspect"]);
    const result = cli(root, "roll", "inspect", "--dry-run");
    expect(result).toContain(root);
    expect(result).toContain("helper imported");
    // The same workspace is selected when a source directory is passed from elsewhere.
    expect(
      cli(tmpdir(), "roll", "inspect", "--source", source, "--dry-run")
    ).toContain(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);

it("init creates a starter without running it and refuses to overwrite it", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-init-"));
  try {
    const file = join(root, ".foundry", "marbles", "summarize-codebase.ts");
    const initialized = cli(root, "init");
    expect(initialized).toContain(file);
    expect(initialized).not.toContain("[run]");
    const original = await readFile(file, "utf8");
    expect(original).toContain("summarizeCodebase");
    expect(cli(root, "list", "--dry-run")).toContain(
      "[step] summarize-codebase"
    );
    expect(() => cli(root, "init")).toThrow("not overwritten");
    expect(await readFile(file, "utf8")).toBe(original);
    expect(() => cli(root, "init", "unknown")).toThrow(
      "init takes one starter"
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);
