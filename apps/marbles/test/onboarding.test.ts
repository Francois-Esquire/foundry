import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type InputField,
  inputDefaults,
  inputProblem,
  parseInputs,
} from "~/lib/inputs";
import { createStarter } from "~/onboarding/create";
import {
  renderModule,
  type SetupDraft,
  STARTERS,
} from "~/onboarding/templates";

const draft: SetupDraft = {
  harness: "auto",
  instructions: "",
  name: "summary",
  template: "product",
};
function cli(config: string, ...args: string[]) {
  const bin = join(dirname(config), "test-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "codex"), 0o755);
  return execFileSync(
    "bun",
    [resolve("src/cli.ts"), ...args, "--dry-run", "--config", config],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      timeout: 10_000,
    }
  );
}

// Allow three CLI processes, each bounded by the helper's 10-second timeout.
it("missing, empty, and import-only configs register no implicit definitions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "marbles-config-"));
  try {
    const config = join(dir, "marbles.config.ts");
    expect(cli(config, "list")).toBe("");
    await writeFile(config, "export {};\n");
    expect(cli(config, "list")).not.toContain("[step]");
    await writeFile(config, 'import "@foundry/marbles/prebuilt";\n');
    expect(cli(config, "list")).not.toContain("[step]");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}, 35_000);

for (const starter of STARTERS) {
  // Each starter is loaded and then executed in separate CLI processes.
  it(`generates a loadable ${starter.label} config with only the selected step`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "marbles-starter-"));
    try {
      const config = join(dir, "marbles.config.ts");
      await createStarter(config, {
        ...draft,
        instructions: 'Use "quotes" and\nnewlines safely.',
        name: starter.name,
        template: starter.id,
      });
      const output = cli(config, "list");
      expect(
        output.split("\n").filter((line) => line.startsWith("[step]"))
      ).toEqual([`[step] ${starter.name}`]);
      expect(output).not.toContain("[workflow]");
      expect(output).not.toContain("[schedule]");
      expect(output).not.toContain("[monitor]");
      expect(output).not.toContain("[run]");
      const input =
        starter.id === "design"
          ? ["--input", JSON.stringify({ brief: "A search screen" })]
          : [];
      expect(cli(config, "roll", starter.name, ...input)).toContain("complete");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }, 25_000);
}

it("never overwrites a starter module, including concurrent creation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "marbles-exclusive-"));
  try {
    const path = join(dir, "marbles.config.ts");
    const attempts = await Promise.allSettled([
      createStarter(path, draft),
      createStarter(path, draft),
    ]);
    expect(
      attempts.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    const original = await readFile(path, "utf8");
    await expect(
      createStarter(path, { ...draft, name: "changed" })
    ).rejects.toThrow("not overwritten");
    expect(await readFile(path, "utf8")).toBe(original);
    await expect(
      createStarter(join(dir, "missing", "marbles.config.ts"), draft)
    ).resolves.toBe(join(dir, "missing", "marbles.config.ts"));
    expect(() => renderModule({ ...draft, name: "unsafe name" })).toThrow();
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

describe("launch input parsing", () => {
  const fields: readonly InputField[] = [
    { label: "Title", name: "title", required: true, type: "text" },
    { label: "Body", name: "body", type: "multiline" },
    {
      default: 0,
      label: "Count",
      max: 10,
      min: 0,
      name: "count",
      type: "number",
    },
    {
      default: false,
      label: "Enabled",
      name: "enabled",
      required: true,
      type: "boolean",
    },
    {
      label: "Mode",
      name: "mode",
      options: [{ label: "Fast", value: "fast" }],
      type: "select",
    },
  ];
  it("preserves defaults, false, zero, multiline strings, and omitted values", () => {
    const result = parseInputs(fields, {
      ...inputDefaults(fields),
      body: "one\ntwo",
      mode: "",
      title: "Review",
    });
    expect(result).toEqual({
      errors: {},
      input: { body: "one\ntwo", count: 0, enabled: false, title: "Review" },
    });
    expect(
      parseInputs(fields, {
        count: "5",
        enabled: false,
        mode: "fast",
        title: "Review",
      }).input.count
    ).toBe(5);
  });
  it("rejects missing, invalid, and unsupported arguments", () => {
    const result = parseInputs(fields, {
      count: "Infinity",
      enabled: "false",
      mode: "unknown",
    });
    expect(Object.keys(result.errors)).toEqual([
      "title",
      "count",
      "enabled",
      "mode",
    ]);
    expect(parseInputs(fields, { count: "11" }).errors.count).toBeDefined();
    expect(
      inputProblem([
        { label: "Unsupported", name: "x", type: "object" as never },
      ])
    ).toContain("Unsupported");
    expect(
      inputProblem([{ label: "Bad", name: "__proto__", type: "text" }])
    ).toContain("safe");
  });
});
