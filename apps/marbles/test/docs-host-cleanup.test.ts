import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { claimProcess } from "~/process/instance";

const CODE_BLOCK = /```ts\n([\s\S]*?)\n```/;

it("releases the documented workspace claim when host cleanup fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-doc-host-"));
  try {
    const page = await readFile(
      resolve("../../docs/marbles/library/host-a-workspace.md"),
      "utf8"
    );
    const source = page.match(CODE_BLOCK)?.[1];
    if (source === undefined) {
      throw new Error("Hosting example missing");
    }
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText;
    const closeError = new Error("host cleanup failed");
    const run = runInNewContext(`(async () => { ${compiled} })()`, {
      AbortController,
      console: { error: vi.fn(), log: vi.fn() },
      exports: {},
      process: { once: vi.fn() },
      require(name: string) {
        if (name === "@foundry.sh/marbles/process") {
          return { claimProcess };
        }
        if (name === "@foundry.sh/marbles/workspace") {
          return {
            hostWorkspace: async (options: {
              prepare: (engine: { state: string }) => void;
            }) => {
              options.prepare({ state: root });
              return {
                close: () => Promise.reject(closeError),
                roll: () => Promise.resolve({ value: null }),
                run: () => Promise.resolve(),
              };
            },
            layout: () => ({ artifacts: root, state: root }),
          };
        }
        throw new Error(`Unexpected import: ${name}`);
      },
    });
    await expect(run).rejects.toBe(closeError);
    const next = claimProcess(root, { config: "next", host: "worker" });
    next.release();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
