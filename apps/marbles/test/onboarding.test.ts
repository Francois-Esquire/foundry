import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type InputField,
  inputDefaults,
  inputProblem,
  parseInputs,
} from "~/lib/inputs";
import { createStarter } from "~/workspace/create";
import { renderModule, type SetupDraft, STARTER } from "~/workspace/templates";
import { type TestHome, testHome } from "./helpers/home";

const draft: SetupDraft = {
  instructions: "",
  name: "summary",
  template: STARTER.id,
};
let home: TestHome | undefined;

afterEach(() => {
  home = undefined;
});

function currentHome(): TestHome {
  home ??= testHome();
  return home;
}

function cli(config: string, ...args: string[]) {
  return execFileSync(
    "bun",
    [resolve("src/cli.ts"), ...args, "--source", config],
    {
      encoding: "utf8",
      env: currentHome().env,
      timeout: 15_000,
    }
  );
}

function runStarter(
  dir: string,
  config: string,
  name: string,
  input: unknown
): string {
  const { artifacts, state } = currentHome().layout;
  const hostModule = resolve("src/workspace/host.ts");
  const echoProviders = resolve("test/helpers/echo-providers.ts");
  return execFileSync(
    "bun",
    [
      "--no-env-file",
      "-e",
      `import ${JSON.stringify(echoProviders)};
import { hostWorkspace } from ${JSON.stringify(hostModule)};
const host = await hostWorkspace({
  artifacts: ${JSON.stringify(artifacts)},
  directory: ${JSON.stringify(dir)},
  print: () => undefined,
  source: ${JSON.stringify(config)},
  state: ${JSON.stringify(state)},
});
try {
  const result = await host.roll(${JSON.stringify(name)}, ${JSON.stringify(input)});
  console.log(result.lines.join("\\n"));
} finally {
  await host.close();
}`,
    ],
    {
      encoding: "utf8",
      env: currentHome().env,
      timeout: 20_000,
    }
  ).trim();
}

it("missing, empty, and import-only configs register no implicit definitions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "marbles-config-"));
  try {
    const config = join(dir, "marbles.config.ts");
    expect(cli(config, "list")).toBe("");
    await writeFile(config, "export {};\n");
    expect(cli(config, "list")).not.toContain("[step]");
    await writeFile(config, 'import "@foundry.sh/marbles";\n');
    expect(cli(config, "list")).not.toContain("[step]");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}, 35_000);

it("generates a loadable starter config with only its step", async () => {
  const dir = await mkdtemp(join(tmpdir(), "marbles-starter-"));
  try {
    const config = join(dir, "marbles.config.ts");
    await createStarter(config, {
      ...draft,
      instructions: 'Use "quotes" and\nnewlines safely.',
      name: STARTER.name,
    });
    const output = cli(config, "list");
    expect(
      output.split("\n").filter((line) => line.startsWith("[step]"))
    ).toEqual([`[step] ${STARTER.name}`]);
    expect(output).not.toContain("[workflow]");
    expect(output).not.toContain("[schedule]");
    expect(output).not.toContain("[monitor]");
    expect(output).not.toContain("[run]");
    expect(runStarter(dir, config, STARTER.name, undefined)).toContain(
      "complete"
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}, 25_000);

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
    for (const keyword of [
      "delete",
      "class",
      "default",
      "return",
      "import",
      "export",
    ]) {
      const rendered = renderModule({ ...draft, name: keyword });
      expect(rendered).toContain(`export const ${keyword}Step =`);
      expect(rendered).toContain(`name: ${JSON.stringify(keyword)},`);
    }
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
