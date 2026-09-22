import { sandboxToolDefinitions } from "@foundry/sandbox/tools/definitions";
import type { SandboxToolEvent } from "@foundry/sandbox/tools/guards";
import { SandboxRateLimitError } from "@foundry/sandbox/tools/guards";
import {
  createSandboxToolkit,
  createSandboxToolSchemas,
} from "@foundry/sandbox/tools/toolkit";
import { describe, expect, it } from "vitest";

import type { FakeSandboxOptions } from "./helpers/fake-sandbox";

import { createFakeSandbox } from "./helpers/fake-sandbox";

const AMBIGUOUS_EDIT_ERROR = /not unique/u;
const IDENTICAL_EDIT_ERROR = /identical/u;
const MISSING_EDIT_ERROR = /not found/u;
const GREP_OPTION_ERROR = /grep failed: grep: invalid option/u;
const RATE_LIMIT_ERROR = /Rate limit reached/u;

function toolkitOver(options: FakeSandboxOptions = {}) {
  const fake = createFakeSandbox(options);
  return Promise.resolve({
    fake,
    sandbox: fake.sandbox,
    toolkit: createSandboxToolkit(fake.sandbox),
  });
}

/** Every tool takes the same options shape; none of these calls need one. */
const NO_OPTIONS = {};

const TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "grep",
  "glob",
  "cd",
  "bash",
] as const;

describe("createSandboxToolkit", () => {
  it("exposes exactly the defined tools, and names them the same", async () => {
    const { toolkit } = await toolkitOver();
    expect(Object.keys(toolkit.tools)).toEqual([...TOOL_NAMES]);
    expect(Object.keys(toolkit.tools).sort()).toEqual(
      Object.keys(sandboxToolDefinitions).sort()
    );
  });

  it("reads a file back with line numbers, and pages with offset/limit", async () => {
    const { toolkit } = await toolkitOver({
      files: { "notes.txt": "alpha\nbeta\ngamma" },
    });

    await expect(
      toolkit.tools.read.execute({ file_path: "notes.txt" }, NO_OPTIONS)
    ).resolves.toBe("     1\talpha\n     2\tbeta\n     3\tgamma");

    await expect(
      toolkit.tools.read.execute(
        { file_path: "notes.txt", limit: 1, offset: 2 },
        NO_OPTIONS
      )
    ).resolves.toBe("     2\tbeta");
  });

  it("writes a file and reads its own bytes back", async () => {
    const { toolkit } = await toolkitOver();

    await expect(
      toolkit.tools.write.execute(
        { content: "export const x = 1;", file_path: "out/app.ts" },
        NO_OPTIONS
      )
    ).resolves.toBe("Wrote 19 bytes to /workspace/out/app.ts");

    await expect(
      toolkit.tools.read.execute({ file_path: "out/app.ts" }, NO_OPTIONS)
    ).resolves.toContain("export const x = 1;");
  });

  it("edits a unique match, and refuses an ambiguous one until replace_all", async () => {
    const { toolkit } = await toolkitOver({
      files: { "a.ts": "let x = 1;\nlet x = 2;" },
    });

    await expect(
      toolkit.tools.edit.execute(
        { file_path: "a.ts", new_string: "const x", old_string: "let x" },
        NO_OPTIONS
      )
    ).rejects.toThrow(AMBIGUOUS_EDIT_ERROR);

    await expect(
      toolkit.tools.edit.execute(
        {
          file_path: "a.ts",
          new_string: "const x",
          old_string: "let x",
          replace_all: true,
        },
        NO_OPTIONS
      )
    ).resolves.toBe("Edited /workspace/a.ts (2 replacements).");

    await expect(
      toolkit.tools.read.execute({ file_path: "a.ts" }, NO_OPTIONS)
    ).resolves.toContain("const x = 1;");
  });

  it("refuses an edit whose old_string is absent, or identical to the new one", async () => {
    const { toolkit } = await toolkitOver({ files: { "a.ts": "value" } });

    await expect(
      toolkit.tools.edit.execute(
        { file_path: "a.ts", new_string: "same", old_string: "same" },
        NO_OPTIONS
      )
    ).rejects.toThrow(IDENTICAL_EDIT_ERROR);

    await expect(
      toolkit.tools.edit.execute(
        { file_path: "a.ts", new_string: "x", old_string: "absent" },
        NO_OPTIONS
      )
    ).rejects.toThrow(MISSING_EDIT_ERROR);
  });

  it("globs through the filesystem facet, reporting workdir-relative paths", async () => {
    const { toolkit } = await toolkitOver({
      files: {
        "README.md": "readme",
        "src/a.ts": "a",
        "src/nested/b.ts": "b",
        "src/nested/c.txt": "c",
      },
    });

    await expect(
      toolkit.tools.glob.execute({ pattern: "**/*.ts" }, NO_OPTIONS)
    ).resolves.toBe("src/a.ts\nsrc/nested/b.ts");

    // `*` does not cross a separator, so only the top-level file matches.
    await expect(
      toolkit.tools.glob.execute({ path: "src", pattern: "*.ts" }, NO_OPTIONS)
    ).resolves.toBe("src/a.ts");

    await expect(
      toolkit.tools.glob.execute({ pattern: "**/*.rs" }, NO_OPTIONS)
    ).resolves.toBe("No files found.");
  });

  it("runs grep as a specialized exec, not a filesystem primitive", async () => {
    const { fake, toolkit } = await toolkitOver({
      commands: [
        {
          command: ["grep", "-r", "-n", "-e", "TODO", "/workspace"],
          stdout: "/workspace/a.ts:3:// TODO\n",
        },
      ],
    });

    await expect(
      toolkit.tools.grep.execute(
        {
          case_insensitive: false,
          line_numbers: true,
          output_mode: "content",
          pattern: "TODO",
        },
        NO_OPTIONS
      )
    ).resolves.toBe("/workspace/a.ts:3:// TODO");

    expect(fake.commandCalls.map(({ command }) => command)).toEqual([
      ["grep", "-r", "-n", "-e", "TODO", "/workspace"],
    ]);
  });

  it("reports grep's no-match exit as a result, and a real failure as an error", async () => {
    const { toolkit } = await toolkitOver({
      commands: [
        {
          command: ["grep", "-r", "-e", "absent", "/workspace"],
          exitCode: 1,
        },
        {
          command: ["grep", "-r", "-e", "broken", "/workspace"],
          exitCode: 2,
          stderr: "grep: invalid option",
        },
      ],
    });
    const base = {
      case_insensitive: false,
      line_numbers: false,
      output_mode: "content",
    } as const;

    await expect(
      toolkit.tools.grep.execute({ ...base, pattern: "absent" }, NO_OPTIONS)
    ).resolves.toBe("No matches found.");

    await expect(
      toolkit.tools.grep.execute({ ...base, pattern: "broken" }, NO_OPTIONS)
    ).rejects.toThrow(GREP_OPTION_ERROR);
  });

  it("runs bash through the command facet and flattens the result", async () => {
    const { toolkit } = await toolkitOver({
      commands: [
        {
          command: "echo hi",
          exitCode: 3,
          stderr: "a warning\n",
          stdout: "hi\n",
        },
      ],
    });

    await expect(
      toolkit.tools.bash.execute({ command: "echo hi" }, NO_OPTIONS)
    ).resolves.toBe("hi\n[stderr]\na warning\n[exit code 3]");
  });

  it("resolves relative paths against the working directory", async () => {
    const { toolkit } = await toolkitOver({
      files: { "deep/dir/file.txt": "found" },
    });

    await expect(
      toolkit.tools.read.execute(
        { file_path: "./deep/dir/file.txt" },
        NO_OPTIONS
      )
    ).resolves.toContain("found");

    await expect(
      toolkit.tools.read.execute(
        { file_path: "/workspace/deep/dir/file.txt" },
        NO_OPTIONS
      )
    ).resolves.toContain("found");
  });

  it("rejects a path that escapes the sandbox", async () => {
    const { toolkit } = await toolkitOver();
    await expect(
      toolkit.tools.read.execute({ file_path: "../outside" }, NO_OPTIONS)
    ).rejects.toMatchObject({ code: "invalid-contract" });
  });
});

describe("createSandboxToolkit — cd", () => {
  const tree = {
    "src/deep/file.txt": "found",
    "src/other.txt": "other",
    "top.txt": "top",
  };

  it("moves where later relative paths resolve", async () => {
    const { toolkit } = await toolkitOver({ files: tree });
    expect(toolkit.workingDirectory).toBe("/workspace");

    await expect(
      toolkit.tools.read.execute({ file_path: "file.txt" }, NO_OPTIONS)
    ).rejects.toThrow();

    await expect(
      toolkit.tools.cd.execute({ path: "src/deep" }, NO_OPTIONS)
    ).resolves.toContain("Working directory is now /workspace/src/deep");
    expect(toolkit.workingDirectory).toBe("/workspace/src/deep");

    await expect(
      toolkit.tools.read.execute({ file_path: "file.txt" }, NO_OPTIONS)
    ).resolves.toContain("found");
  });

  it("walks back up with `..`, which every other tool refuses outright", async () => {
    const { toolkit } = await toolkitOver({ files: tree });

    await toolkit.tools.cd.execute({ path: "src/deep" }, NO_OPTIONS);
    await toolkit.tools.cd.execute({ path: ".." }, NO_OPTIONS);
    expect(toolkit.workingDirectory).toBe("/workspace/src");

    await expect(
      toolkit.tools.read.execute({ file_path: "other.txt" }, NO_OPTIONS)
    ).resolves.toContain("other");

    // The traversal `cd` collapses is still refused on an ordinary path.
    await expect(
      toolkit.tools.read.execute({ file_path: "../top.txt" }, NO_OPTIONS)
    ).rejects.toMatchObject({ code: "invalid-contract" });
  });

  it("takes an absolute directory, and refuses missing paths", async () => {
    const { toolkit } = await toolkitOver({ files: tree });

    await expect(
      toolkit.tools.cd.execute({ path: "/workspace/src" }, NO_OPTIONS)
    ).resolves.toBe("Working directory is now /workspace/src (2 entries).");

    await expect(
      toolkit.tools.cd.execute({ path: "/workspace/nowhere" }, NO_OPTIONS)
    ).rejects.toMatchObject({ code: "invalid-contract" });
    expect(toolkit.workingDirectory).toBe("/workspace/src");

    await expect(
      toolkit.tools.cd.execute({ path: "/workspace/src/a.ts" }, NO_OPTIONS)
    ).rejects.toMatchObject({ code: "invalid-contract" });
  });

  it("moves the directory bash runs in", async () => {
    const { fake, toolkit } = await toolkitOver({
      commands: [{ command: "pwd", stdout: "" }],
      files: tree,
    });

    await toolkit.tools.cd.execute({ path: "src" }, NO_OPTIONS);
    await toolkit.tools.bash.execute({ command: "pwd" }, NO_OPTIONS);

    expect(fake.commandCalls.at(-1)?.options).toMatchObject({
      cwd: "/workspace/src",
    });
  });

  it("records the directory it landed in, not the argument it was given", async () => {
    const events: SandboxToolEvent[] = [];
    const { sandbox } = await toolkitOver({ files: tree });
    const toolkit = createSandboxToolkit(sandbox, {
      audit: { record: (event) => events.push(event) },
    });

    await toolkit.tools.cd.execute({ path: "src/deep" }, NO_OPTIONS);

    expect(events.at(-1)).toMatchObject({
      outcome: "allowed",
      path: "/workspace/src/deep",
      tool: "cd",
    });
  });
});

describe("createSandboxToolkit — guards", () => {
  it("clips a result past the character ceiling and says it did", async () => {
    const { sandbox } = await toolkitOver({
      files: { "big.txt": "x".repeat(500) },
    });
    const events: SandboxToolEvent[] = [];
    const toolkit = createSandboxToolkit(sandbox, {
      audit: { record: (event) => events.push(event) },
      limits: { maxOutputChars: 40 },
    });
    const output = await toolkit.tools.read.execute(
      { file_path: "big.txt" },
      NO_OPTIONS
    );
    expect(String(output)).toHaveLength(40);
    expect(events.at(-1)).toMatchObject({
      outcome: "allowed",
      tool: "read",
      truncated: true,
    });
  });

  it("refuses past the per-minute rate, and lets the window roll", async () => {
    let clock = 1000;
    const { sandbox } = await toolkitOver({ files: { "a.txt": "a" } });
    const toolkit = createSandboxToolkit(sandbox, {
      limits: { maxCallsPerMinute: 2 },
      now: () => clock,
    });
    const read = () =>
      toolkit.tools.read.execute({ file_path: "a.txt" }, NO_OPTIONS);

    await read();
    await read();
    await expect(read()).rejects.toThrow(RATE_LIMIT_ERROR);

    clock += 61_000;
    await expect(read()).resolves.toContain("a");
  });

  it("records one event per call, on every exit path", async () => {
    const events: SandboxToolEvent[] = [];
    const { sandbox } = await toolkitOver({ files: { "a.txt": "a" } });
    const toolkit = createSandboxToolkit(sandbox, {
      audit: { record: (event) => events.push(event) },
    });

    await toolkit.tools.read.execute({ file_path: "a.txt" }, NO_OPTIONS);
    await expect(
      toolkit.tools.read.execute({ file_path: "../escape" }, NO_OPTIONS)
    ).rejects.toThrow();
    await expect(
      toolkit.tools.edit.execute(
        { file_path: "a.txt", new_string: "same", old_string: "same" },
        NO_OPTIONS
      )
    ).rejects.toThrow(IDENTICAL_EDIT_ERROR);

    expect(events).toHaveLength(3);
    // The allowed call records where it landed; a refusal records no path, so
    // a denial never says where it would have gone.
    expect(events[0]).toMatchObject({
      outcome: "allowed",
      path: "/workspace/a.txt",
      tool: "read",
    });
    expect(events[1]).toMatchObject({ outcome: "refused", tool: "read" });
    expect(events[1]?.path).toBeUndefined();
    // An ordinary tool error is a failure, not a refusal by the environment.
    expect(events[2]).toMatchObject({ outcome: "failed", tool: "edit" });
  });

  it("records the rate refusal itself, so the trail shows why nothing ran", async () => {
    const events: SandboxToolEvent[] = [];
    const { sandbox } = await toolkitOver({ files: { "a.txt": "a" } });
    const toolkit = createSandboxToolkit(sandbox, {
      audit: { record: (event) => events.push(event) },
      limits: { maxCallsPerMinute: 1 },
    });

    await toolkit.tools.read.execute({ file_path: "a.txt" }, NO_OPTIONS);
    await expect(
      toolkit.tools.read.execute({ file_path: "a.txt" }, NO_OPTIONS)
    ).rejects.toThrow(SandboxRateLimitError);

    expect(events.at(-1)).toMatchObject({ outcome: "refused", reason: "rate" });
  });

  it("applies to every tool, not just the ones a caller remembered", async () => {
    const events: SandboxToolEvent[] = [];
    const { sandbox } = await toolkitOver({ files: { "a.txt": "a" } });
    const toolkit = createSandboxToolkit(sandbox, {
      audit: { record: (event) => events.push(event) },
    });

    for (const name of TOOL_NAMES) {
      await toolkit.tools[name]
        .execute(inputFor(name), NO_OPTIONS)
        .catch(() => undefined);
    }
    expect(events.map((event) => event.tool)).toEqual([...TOOL_NAMES]);
  });
});

/** A minimally valid input per tool, for coverage sweeps. */
function inputFor(name: (typeof TOOL_NAMES)[number]): Record<string, unknown> {
  const base = {
    case_insensitive: false,
    line_numbers: false,
    output_mode: "content",
  };
  if (name === "write") {
    return { content: "x", file_path: "w.txt" };
  }
  if (name === "edit") {
    return { file_path: "a.txt", new_string: "b", old_string: "a" };
  }
  if (name === "grep") {
    return { ...base, pattern: "a" };
  }
  if (name === "glob") {
    return { pattern: "**/*" };
  }
  if (name === "bash") {
    return { command: "true" };
  }
  return { file_path: "a.txt" };
}

describe("createSandboxToolSchemas", () => {
  it("publishes the same six tools with no implementation to intercept", () => {
    const schemas = createSandboxToolSchemas();

    expect(Object.keys(schemas.tools)).toEqual(
      Object.keys(sandboxToolDefinitions)
    );
    for (const schema of Object.values(schemas.tools)) {
      expect(schema).not.toHaveProperty("execute");
    }
  });

  it("is indistinguishable from the executing toolkit in what a model sees", async () => {
    const { toolkit } = await toolkitOver();
    const schemas = createSandboxToolSchemas();

    for (const name of TOOL_NAMES) {
      expect(toolkit.tools[name].description).toBe(
        schemas.tools[name].description
      );
      expect(toolkit.tools[name].inputSchema).toBe(
        schemas.tools[name].inputSchema
      );
    }
    expect(schemas.instructions).toBe(toolkit.instructions);
  });

  it("names the working directory it was told about", () => {
    expect(
      createSandboxToolSchemas({ workingDirectory: "/srv" }).instructions
    ).toContain("`/srv`");
  });

  it("calls the working directory fixed unless `cd` is mounted", async () => {
    const { sandbox } = await toolkitOver();

    expect(
      createSandboxToolkit(sandbox, { tools: ["read", "grep"] }).instructions
    ).toContain("the working directory `/workspace` unless");

    expect(
      createSandboxToolkit(sandbox, { tools: ["read", "cd"] }).instructions
    ).toContain("starts at `/workspace` and `cd` moves");
  });
});
