import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, expect, it } from "vitest";
import {
  DEFAULT_CONFIGURATION,
  loadConfiguration,
} from "../../src/lib/spyglass-config";

const LOAD_TIMEOUT_MS = 30_000;
const INVALID_JSON = /^foundry\.config\.json: the file is not valid JSON: /;
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

function workspace(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "spyglass-config-")));
  roots.push(root);
  write(root, "package.json", JSON.stringify({ workspaces: ["packages/*"] }));
  for (const [file, content] of Object.entries(files)) {
    write(root, file, content);
  }
  return root;
}

function write(root: string, file: string, content: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
}

it("uses the defaults when the workspace has no configuration", async () => {
  expect(await loadConfiguration(workspace({}))).toEqual(DEFAULT_CONFIGURATION);
});

it(
  "reads the default export of a configuration file, over the defaults",
  async () => {
    const root = workspace({
      ".foundry/spyglass/index.ts": `import type { Unused } from "@foundry.sh/spyglass";\nconst exclude: string[] = ["./packages/fixtures/"];\nexport default { exclude, history: { range: "6m" } } satisfies Partial<Unused>;\n`,
    });
    expect(await loadConfiguration(root)).toEqual({
      domains: [],
      exclude: ["packages/fixtures"],
      history: { ...DEFAULT_CONFIGURATION.history, range: "6m" },
      rules: [],
    });
  },
  LOAD_TIMEOUT_MS
);

it(
  "combines files that each declare their own keys, and skips helpers and declarations",
  async () => {
    const root = workspace({
      ".foundry/spyglass/_shared.ts": `export const skipped = ["packages/legacy"];\n`,
      ".foundry/spyglass/.draft.ts": "export default { exclude: [1] };\n",
      ".foundry/spyglass/exclude.ts": `import { skipped } from "./_shared";\nexport default { exclude: skipped };\n`,
      ".foundry/spyglass/history/policy.mjs":
        'export default { history: { strategy: "evenly-spaced" } };\n',
      ".foundry/spyglass/node_modules/dep/index.ts": "throw new Error();\n",
      ".foundry/spyglass/notes.md": "Not a configuration file.\n",
      ".foundry/spyglass/types.d.ts": "export type Nothing = never;\n",
    });
    expect(await loadConfiguration(root)).toEqual({
      domains: [],
      exclude: ["packages/legacy"],
      history: {
        ...DEFAULT_CONFIGURATION.history,
        strategy: "evenly-spaced",
      },
      rules: [],
    });
  },
  LOAD_TIMEOUT_MS
);

it(
  "rejects a key declared in two files",
  async () => {
    const root = workspace({
      ".foundry/spyglass/a.ts": "export default { exclude: [] };\n",
      ".foundry/spyglass/b.ts": 'export default { exclude: ["packages/x"] };\n',
    });
    await expect(loadConfiguration(root)).rejects.toThrow(
      "Configuration: exclude is declared in .foundry/spyglass/a.ts and .foundry/spyglass/b.ts. Declare it in one."
    );
  },
  LOAD_TIMEOUT_MS
);

it(
  "reads the domains a configuration file declares, as written",
  async () => {
    const domains = [
      {
        domains: [
          {
            facets: ["packages/billing", "packages/core/src/ids.ts#InvoiceId"],
            name: "billing",
          },
        ],
        name: "finances",
        reason: "Money moves through one model.",
        weight: 0.8,
      },
    ];
    const root = workspace({
      ".foundry/spyglass/_finances.ts": `export const finances = ${JSON.stringify(domains[0])};\n`,
      ".foundry/spyglass/domains.ts": `import { finances } from "./_finances";\nexport default { domains: [finances] };\n`,
      ".foundry/spyglass/index.ts":
        'export default { exclude: ["packages/x"] };\n',
    });
    expect(await loadConfiguration(root)).toEqual({
      ...DEFAULT_CONFIGURATION,
      domains,
      exclude: ["packages/x"],
    });
  },
  LOAD_TIMEOUT_MS
);

it(
  "rejects domains declared in two files, and an invalid domain by its file and setting",
  async () => {
    const twice = workspace({
      ".foundry/spyglass/billing.ts":
        'export default { domains: [{ facets: ["packages/billing"], name: "billing" }] };\n',
      ".foundry/spyglass/payments.ts":
        'export default { domains: [{ facets: ["packages/payments"], name: "payments" }] };\n',
    });
    await expect(loadConfiguration(twice)).rejects.toThrow(
      "Configuration: domains is declared in .foundry/spyglass/billing.ts and .foundry/spyglass/payments.ts. Declare it in one."
    );
    const invalid = workspace({
      ".foundry/spyglass/domains.ts":
        'export default { domains: [{ facets: ["packages/billing/"], name: "billing" }] };\n',
    });
    await expect(loadConfiguration(invalid)).rejects.toThrow(
      'Configuration .foundry/spyglass/domains.ts: domains[0].facets[0] must have no empty, ".", or ".." segments, and no trailing "/"; got "packages/billing/".'
    );
  },
  LOAD_TIMEOUT_MS
);

it(
  "reads the rules a configuration file declares, as written, and rejects an invalid one by its file and setting",
  async () => {
    const rules = [
      { effect: "require", operator: "internalize", subject: "packages/core" },
      {
        effect: "permit",
        operator: "internalize",
        subject: "packages/lib/src/ids.ts#InvoiceId",
      },
    ];
    const root = workspace({
      ".foundry/spyglass/rules.ts": `export default { rules: ${JSON.stringify(rules)} };\n`,
    });
    expect(await loadConfiguration(root)).toEqual({
      ...DEFAULT_CONFIGURATION,
      rules,
    });
    const twice = workspace({
      ".foundry/spyglass/a.ts": "export default { rules: [] };\n",
      ".foundry/spyglass/b.ts": "export default { rules: [] };\n",
    });
    await expect(loadConfiguration(twice)).rejects.toThrow(
      "Configuration: rules is declared in .foundry/spyglass/a.ts and .foundry/spyglass/b.ts. Declare it in one."
    );
    const invalid = workspace({
      ".foundry/spyglass/rules.ts":
        'export default { rules: [{ effect: "permit", operator: "move", subject: "packages/core" }] };\n',
    });
    await expect(loadConfiguration(invalid)).rejects.toThrow(
      'Configuration .foundry/spyglass/rules.ts: rules[0].operator must be "internalize", the one operator rules can name so far; got "move".'
    );
  },
  LOAD_TIMEOUT_MS
);

it(
  "names the file and the setting for every invalid value",
  async () => {
    const cases: [string, string][] = [
      [
        'export default { history: { strategy: "weekly" } };',
        'Configuration .foundry/spyglass/index.ts: history.strategy must be monthly, evenly-spaced, or every-n-commits; got "weekly".',
      ],
      [
        'export default { history: { range: "6w" } };',
        'Configuration .foundry/spyglass/index.ts: history.range must be <n>y, <n>m, <n>d, or all; got "6w".',
      ],
      [
        "export default { history: { checkpoints: 0, every: 2.5 } };",
        "Configuration .foundry/spyglass/index.ts: history.checkpoints must be a whole number of at least 1; got 0; history.every must be a whole number of at least 1; got 2.5.",
      ],
      [
        "export default { lenses: [] };",
        "Configuration .foundry/spyglass/index.ts: unknown key lenses.",
      ],
      [
        "export default { exclude: () => [] };",
        "Configuration .foundry/spyglass/index.ts: exclude must be a list of workspace-relative directories; got a function.",
      ],
      [
        'export default { exclude: ["../outside", "/abs", ".", "packages/./x", ""] };',
        'Configuration .foundry/spyglass/index.ts: exclude[0] must be a workspace-relative directory; got "../outside"; exclude[1] must be a workspace-relative directory; got "/abs"; exclude[2] must be a workspace-relative directory; got "."; exclude[3] must be a workspace-relative directory; got "packages/./x"; exclude[4] must be a workspace-relative directory; got "".',
      ],
      [
        "export default [];",
        "Configuration .foundry/spyglass/index.ts: the default export must be an object.",
      ],
      [
        "export const exclude = [];",
        "Configuration .foundry/spyglass/index.ts: the file has no default export. Export the configuration as the default, or start a helper file's name with _.",
      ],
      [
        'export default { get exclude() { throw new Error("not now"); } };',
        "Configuration .foundry/spyglass/index.ts: checking the default export threw: not now",
      ],
      [
        'throw new Error("no network here");',
        "Configuration .foundry/spyglass/index.ts: loading the file threw: no network here",
      ],
    ];
    for (const [source, message] of cases) {
      const root = workspace({ ".foundry/spyglass/index.ts": `${source}\n` });
      await expect(loadConfiguration(root)).rejects.toThrow(message);
    }
  },
  LOAD_TIMEOUT_MS * 3
);

it(
  "sees an edited configuration file and an edited helper on the next load",
  async () => {
    const root = workspace({
      ".foundry/spyglass/_skipped.ts":
        'export const skipped = ["packages/a"];\n',
      ".foundry/spyglass/index.ts": `import { skipped } from "./_skipped";\nexport default { exclude: skipped };\n`,
    });
    expect((await loadConfiguration(root)).exclude).toEqual(["packages/a"]);
    write(
      root,
      ".foundry/spyglass/_skipped.ts",
      'export const skipped = ["packages/b"];\n'
    );
    expect((await loadConfiguration(root)).exclude).toEqual(["packages/b"]);
    write(
      root,
      ".foundry/spyglass/index.ts",
      'export default { exclude: ["packages/c"] };\n'
    );
    expect((await loadConfiguration(root)).exclude).toEqual(["packages/c"]);
  },
  LOAD_TIMEOUT_MS
);

it("reads foundry.config.json#semantics when there is no configuration directory", async () => {
  const root = workspace({
    "foundry.config.json": JSON.stringify({
      other: { kept: true },
      semantics: { exclude: ["packages/x"], history: { every: 10 } },
    }),
  });
  expect(await loadConfiguration(root)).toEqual({
    domains: [],
    exclude: ["packages/x"],
    history: { ...DEFAULT_CONFIGURATION.history, every: 10 },
    rules: [],
  });
  expect(
    await loadConfiguration(
      workspace({ "foundry.config.json": JSON.stringify({ other: {} }) })
    )
  ).toEqual(DEFAULT_CONFIGURATION);
});

it("rejects removed and invalid settings in foundry.config.json", async () => {
  const cases: [unknown, string][] = [
    [
      { semantics: { output: ".foundry/semantics" } },
      "foundry.config.json: semantics.output is no longer read; the dataset is saved under the state directory. Remove it.",
    ],
    [
      { semantics: { roots: ["apps"] } },
      "foundry.config.json: semantics.roots is no longer read; Spyglass finds packages from the workspace declaration (pnpm-workspace.yaml or package.json#workspaces). Remove it.",
    ],
    [
      { semantics: { history: { strategy: "weekly" } } },
      'foundry.config.json: semantics.history.strategy must be monthly, evenly-spaced, or every-n-commits; got "weekly".',
    ],
    [
      { semantics: ["apps"] },
      "foundry.config.json: semantics must be an object.",
    ],
    [
      {
        semantics: {
          domains: [{ facets: ["packages/billing"], name: "billing" }],
        },
      },
      "foundry.config.json: semantics has unknown key domains.",
    ],
    [
      {
        semantics: {
          rules: [
            {
              effect: "require",
              operator: "internalize",
              subject: "packages/core",
            },
          ],
        },
      },
      "foundry.config.json: semantics has unknown key rules.",
    ],
  ];
  for (const [content, message] of cases) {
    const root = workspace({ "foundry.config.json": JSON.stringify(content) });
    await expect(loadConfiguration(root)).rejects.toThrow(message);
  }
  const broken = workspace({ "foundry.config.json": "{ semantics: " });
  await expect(loadConfiguration(broken)).rejects.toThrow(INVALID_JSON);
});

it("rejects foundry.config.json#semantics beside a configuration directory", async () => {
  const root = workspace({
    ".foundry/spyglass/index.ts": "export default {};\n",
    "foundry.config.json": JSON.stringify({ semantics: { exclude: [] } }),
  });
  await expect(loadConfiguration(root)).rejects.toThrow(
    "foundry.config.json: semantics is ignored because .foundry/spyglass/ exists. Move it there, or remove it."
  );
});

it("ignores a foundry.config.json that does not parse beside a configuration directory", async () => {
  const root = workspace({
    ".foundry/spyglass/_helper.ts": "export {};\n",
    "foundry.config.json": "{ not json",
  });
  expect(await loadConfiguration(root)).toEqual(DEFAULT_CONFIGURATION);
});

it("refuses a configuration directory reached through a symbolic link", async () => {
  const target = workspace({ "spyglass/index.ts": "export default {};\n" });
  const linked = workspace({});
  mkdirSync(join(linked, ".foundry"));
  symlinkSync(join(target, "spyglass"), join(linked, ".foundry", "spyglass"));
  await expect(loadConfiguration(linked)).rejects.toThrow(
    "Configuration: .foundry/spyglass is a symbolic link; Spyglass does not follow links."
  );
  const parent = workspace({});
  symlinkSync(target, join(parent, ".foundry"));
  await expect(loadConfiguration(parent)).rejects.toThrow(
    "Configuration: .foundry is a symbolic link; Spyglass does not follow links."
  );
});

it(
  "names a configuration file that ends the process while loading",
  async () => {
    const root = workspace({
      ".foundry/spyglass/a.ts": "export default {};\n",
      ".foundry/spyglass/b.ts":
        'console.error("leaving early");\nprocess.exit(3);\nexport default {};\n',
    });
    await expect(loadConfiguration(root)).rejects.toThrow(
      "Configuration .foundry/spyglass/b.ts: the file ended the process while it was loading: leaving early"
    );
  },
  LOAD_TIMEOUT_MS
);

it(
  "kills a configuration that ignores SIGTERM and never finishes loading",
  async () => {
    const root = workspace({
      ".foundry/spyglass/index.ts":
        'process.on("SIGTERM", () => undefined);\nsetInterval(() => undefined, 1000);\nawait new Promise(() => undefined);\nexport default {};\n',
    });
    const started = Date.now();
    await expect(loadConfiguration(root, { timeoutMs: 2000 })).rejects.toThrow(
      "Configuration: .foundry/spyglass/ did not finish loading within 2 seconds."
    );
    expect(Date.now() - started).toBeLessThan(LOAD_TIMEOUT_MS / 2);
  },
  LOAD_TIMEOUT_MS
);

it("reads configuration from the former Atlas directory until it is moved", async () => {
  const root = workspace({
    ".foundry/atlas/index.ts":
      'export default { exclude: ["packages/legacy"] };',
  });
  expect((await loadConfiguration(root)).exclude).toEqual(["packages/legacy"]);
});
it("prefers Spyglass configuration without executing old Atlas configuration", async () => {
  const root = workspace({
    ".foundry/atlas/index.ts":
      'throw new Error("Old configuration must not run");',
    ".foundry/spyglass/index.ts":
      'export default { exclude: ["packages/current"] };',
  });
  expect((await loadConfiguration(root)).exclude).toEqual(["packages/current"]);
});
it("preserves symbolic-link refusals for the former configuration directory", async () => {
  const root = workspace({ "old/index.ts": "export default {};" });
  mkdirSync(join(root, ".foundry"));
  symlinkSync(join(root, "old"), join(root, ".foundry", "atlas"));
  await expect(loadConfiguration(root)).rejects.toThrow("symbolic link");
});
