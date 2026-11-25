import { createSandboxToolkit } from "@foundry/sandbox/tools";
import { createVirtualSandbox } from "@foundry/sandbox/virtual";
import { describe, expect, it } from "vitest";

import { runSandboxContract } from "./helpers/sandbox-contract";

runSandboxContract({
  create: () => ({ sandbox: createVirtualSandbox() }),
  label: "virtual sandbox",
});

const NO_OPTIONS = {};

describe("createVirtualSandbox", () => {
  it("starts with seeded files, resolved against the working directory", async () => {
    const sandbox = createVirtualSandbox({
      files: { "/etc/motd": "banner", "notes.md": "hello" },
    });

    await expect(sandbox.files.readFile("notes.md")).resolves.toEqual(
      new TextEncoder().encode("hello")
    );
    await expect(sandbox.files.readFile("/etc/motd")).resolves.toEqual(
      new TextEncoder().encode("banner")
    );
  });

  it("runs the simulated toolbox, not just a shell", async () => {
    const sandbox = createVirtualSandbox({
      files: { "src/a.ts": "const x = 1;\n// TODO fix\n", "src/b.txt": "no" },
    });

    const grepped = await sandbox.commands.exec([
      "grep",
      "-rn",
      "TODO",
      "/workspace/src",
    ]);
    expect(grepped.exitCode).toBe(0);
    expect(grepped.stdout).toContain("a.ts:2");

    const counted = await sandbox.commands.exec("ls /workspace/src | wc -l");
    expect(counted.exitCode).toBe(0);
    expect(counted.stdout.trim()).toBe("2");
  });

  it("keeps argv genuinely unparsed — a space is not a separator", async () => {
    const sandbox = createVirtualSandbox();

    await expect(
      sandbox.commands.exec(["printf", "%s", "one two"])
    ).resolves.toMatchObject({ stdout: "one two" });

    await expect(
      sandbox.commands.exec(["printf", "%s", "$HOME"])
    ).resolves.toMatchObject({ stdout: "$HOME" });
  });

  it("treats argv[0] as one command name, not a shell line", async () => {
    const sandbox = createVirtualSandbox();

    const joined = await sandbox.commands.exec(["echo first; echo second"]);
    expect(joined.exitCode).toBe(127);
    expect(joined.stdout).toBe("");

    const quoted = await sandbox.commands.exec(["it's"]);
    expect(quoted.exitCode).toBe(127);
    expect(quoted.stderr).toContain("it's");
  });

  it("carries environment variables into commands", async () => {
    const sandbox = createVirtualSandbox({ environment: { GREETING: "hi" } });

    await expect(
      sandbox.commands.exec("printf '%s' \"$GREETING\"")
    ).resolves.toMatchObject({ stdout: "hi" });
  });

  it("refuses an already-cancelled command", async () => {
    const sandbox = createVirtualSandbox();
    const controller = new AbortController();
    controller.abort();

    await expect(
      sandbox.commands.exec("echo hi", { signal: controller.signal })
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("keeps two sandboxes from seeing each other", async () => {
    const first = createVirtualSandbox({ files: { "only-here.txt": "a" } });
    const second = createVirtualSandbox();

    await expect(second.files.list("/workspace")).resolves.toEqual([]);
    await expect(first.files.list("/workspace")).resolves.toEqual([
      { path: "/workspace/only-here.txt", type: "file" },
    ]);
  });
});

describe("the sandbox toolkit over a virtual sandbox", () => {
  it("reads, writes, edits, globs, greps, moves, and runs a command", async () => {
    const sandbox = createVirtualSandbox({
      files: { "src/app.ts": "const x = 1;\n// TODO fix\n" },
    });
    const { tools } = createSandboxToolkit(sandbox);

    await expect(
      tools.read.execute({ file_path: "src/app.ts" }, NO_OPTIONS)
    ).resolves.toContain("1\tconst x = 1;");

    await expect(
      tools.write.execute(
        { content: "export const y = 2;", file_path: "src/new.ts" },
        NO_OPTIONS
      )
    ).resolves.toBe("Wrote 19 bytes to /workspace/src/new.ts");

    await expect(
      tools.edit.execute(
        {
          file_path: "src/new.ts",
          new_string: "const y = 3;",
          old_string: "const y = 2;",
          replace_all: false,
        },
        NO_OPTIONS
      )
    ).resolves.toContain("1 replacement");

    await expect(
      tools.glob.execute({ pattern: "**/*.ts" }, NO_OPTIONS)
    ).resolves.toBe("src/app.ts\nsrc/new.ts");

    await expect(
      tools.grep.execute(
        {
          case_insensitive: false,
          line_numbers: false,
          output_mode: "files_with_matches",
          pattern: "TODO",
        },
        NO_OPTIONS
      )
    ).resolves.toContain("app.ts");

    await expect(
      tools.cd.execute({ path: "src" }, NO_OPTIONS)
    ).resolves.toContain("Working directory is now /workspace/src");
    await expect(
      tools.read.execute({ file_path: "app.ts" }, NO_OPTIONS)
    ).resolves.toContain("const x = 1;");

    await expect(
      tools.bash.execute({ command: "pwd" }, NO_OPTIONS)
    ).resolves.toBe("/workspace/src");
  });

  it("writes through bash and reads it back through the facet", async () => {
    const sandbox = createVirtualSandbox();
    const { tools } = createSandboxToolkit(sandbox);

    await tools.bash.execute(
      { command: "mkdir -p out && echo built > out/result.txt" },
      NO_OPTIONS
    );

    await expect(
      tools.read.execute({ file_path: "out/result.txt" }, NO_OPTIONS)
    ).resolves.toContain("built");
  });
});
