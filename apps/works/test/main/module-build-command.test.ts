import { once } from "node:events";
import type { Writable } from "node:stream";
import { ProcessController } from "@foundry/sandbox/process-controller";
import { expect, it } from "vitest";
import { runBuildCommand } from "~/main/modules/builds/runtime";

const LOG_CHARACTERS = 32_768;

async function write(stream: Writable, text: string, chunkCharacters: number) {
  for (let start = 0; start < text.length; start += chunkCharacters) {
    if (!stream.write(text.slice(start, start + chunkCharacters))) {
      await once(stream, "drain");
    }
  }
}

function spawning(stdout: string, stderr: string, exitCode = 0) {
  const argvs: (readonly string[])[] = [];
  return {
    argvs,
    processes: {
      spawn(argv: string | readonly string[]) {
        argvs.push(typeof argv === "string" ? [argv] : argv);
        const child = new ProcessController(() => Promise.resolve());
        (async () => {
          await Promise.all([
            write(child.stdout, stdout, 64 * 1024),
            write(child.stderr, stderr, 64 * 1024),
          ]);
          child.complete(exitCode);
        })().catch((error: unknown) => child.fail(error as Error));
        return Promise.resolve(child);
      },
    },
  };
}

it("returns the exit code and both outputs joined as before", async () => {
  const fake = spawning("installed\n", "warning\n", 3);
  await expect(
    runBuildCommand(fake.processes, ["bun", "install"], {
      cwd: "/workspace",
      signal: new AbortController().signal,
    })
  ).resolves.toEqual({ exitCode: 3, log: "installed\n\nwarning\n" });
  expect(fake.argvs).toEqual([["bun", "install"]]);
});

it("keeps only the tail of long output, multi-byte text included", async () => {
  const stdout = `${"x".repeat(4 * 1024 * 1024)}${"é€😀".repeat(20_000)}`;
  const stderr = "done";
  const fake = spawning(stdout, stderr);
  const { log } = await runBuildCommand(fake.processes, ["bun", "run"], {
    cwd: "/workspace",
    signal: new AbortController().signal,
  });
  expect(log).toBe(`${stdout}\n${stderr}`.slice(-LOG_CHARACTERS));
});
