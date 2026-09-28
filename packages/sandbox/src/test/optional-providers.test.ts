import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import ts from "typescript";
import { expect, it } from "vitest";

const execute = promisify(execFile);

// This consumer check runs a separate runtime and a full TypeScript compilation.
it("loads portable entries and container contracts with only core, lib, and Zod installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-optional-providers-"));
  try {
    await cp(join(import.meta.dirname, ".."), join(root, "src"), {
      filter: (source) => source !== import.meta.dirname,
      recursive: true,
    });
    await mkdir(join(root, "node_modules"));
    const require = createRequire(import.meta.url);
    await mkdir(join(root, "node_modules/@foundry"));
    await symlink(
      dirname(dirname(require.resolve("@foundry/core/storage"))),
      join(root, "node_modules/@foundry/core"),
      "dir"
    );
    await symlink(
      dirname(dirname(require.resolve("@foundry/lib/paths"))),
      join(root, "node_modules/@foundry/lib"),
      "dir"
    );
    await symlink(
      dirname(require.resolve("zod/package.json")),
      join(root, "node_modules/zod"),
      "dir"
    );
    await execute(
      "bun",
      [
        "--no-install",
        "--eval",
        `import assert from "node:assert/strict";
import { sandboxFromAdapter } from "./src/sandbox.ts";
import { createSandboxToolkit } from "./src/tools/toolkit.ts";
import { createContainers } from "./src/container/containers.ts";
import "./src/testing.ts";
for (const peer of ["just-bash", "microsandbox"]) {
  assert.throws(() => Bun.resolveSync(peer, process.cwd()));
}
assert.equal(typeof sandboxFromAdapter, "function");
assert.equal(typeof createSandboxToolkit, "function");
assert.equal(typeof createContainers, "function");`,
      ],
      { cwd: root, timeout: 10_000 }
    );

    const program = ts.createProgram(
      [join(root, "src/sandbox.ts"), join(root, "src/tools/toolkit.ts")],
      {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
        strict: true,
        target: ts.ScriptTarget.ESNext,
        types: [],
      }
    );
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
        )
    ).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);
