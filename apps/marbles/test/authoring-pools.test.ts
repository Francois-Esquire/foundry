import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Catalog } from "~/authoring/catalog";
import { defineConfig } from "~/authoring/config";
import { createEngine, DEFAULT_HOSTED_POOL_LIMIT } from "~/create";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});
async function source(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "marbles-pools-"));
  roots.push(root);
  const config = join(root, ".foundry/marbles");
  await mkdir(config, { recursive: true });
  for (const [file, contents] of Object.entries(files)) {
    await writeFile(join(config, file), contents);
  }
  const script = join(root, "check.ts");
  const src = join(import.meta.dirname, "../src");
  await writeFile(
    script,
    `
    import { openWorkspace } from ${JSON.stringify(join(src, "workspace/open.ts"))};
    import { createEngine } from ${JSON.stringify(join(src, "create.ts"))};
    const root = ${JSON.stringify(root)};
    const opened = await openWorkspace({ artifacts: root + "/artifacts", config: ${JSON.stringify(config)}, dry: true, state: root + "/state" }, { cwd: root, print: () => {} });
    const engine = createEngine({ catalog: opened.catalog, root, dry: true, workspaceId: "ws", print: () => {} });
    try {
      await engine.start();
      const launched = [];
      if (opened.catalog.definitions.has("review")) {
        launched.push(await engine.launch("review", {}), await engine.launch("review", {}), await engine.launch("build", {}));
      }
      const runs = engine.executions.list();
      await Promise.all(launched.map(run => run.result));
      console.log(JSON.stringify({ pools: opened.catalog.poolRecords(), runs, stats: await engine.executions.pools() }));
    } finally { await engine.dispose(); }
  `
  );
  return JSON.parse(
    execFileSync("bun", [script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  );
}

it("combines static configs and routes definitions to each file's pool", async () => {
  const opened = await source({
    "a.ts":
      'import { defineConfig, step } from "@foundry.sh/marbles"; export default defineConfig({ pools: { review: 1 }, pool: "review" }); export const review = step("review").do(() => new Promise(resolve => setTimeout(() => resolve("ok"), 40)));',
    "b.ts":
      'import { step } from "@foundry.sh/marbles"; export default { pools: { build: 2 }, pool: "build" }; export const build = step("build").do(() => "built");',
  });
  expect(opened.pools).toEqual({ build: 2, review: 1 });
  expect(
    opened.runs.filter((run: { pool: string }) => run.pool === "review")
  ).toHaveLength(2);
  expect(
    opened.runs.some(
      (run: { pool: string; status: string }) =>
        run.pool === "review" && run.status === "queued"
    )
  ).toBe(true);
  expect(opened.stats).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        limit: DEFAULT_HOSTED_POOL_LIMIT,
        name: "default",
      }),
    ])
  );
});

it.each([
  [
    {
      "a.ts": "export default { pools: { duplicate: 1 } };",
      "b.ts": "export default { pools: { duplicate: 2 } };",
    },
    /a\.ts.*b\.ts/,
  ],
  [
    { "unknown.ts": 'export default { pool: "missing" };' },
    /unknown\.ts.*unknown pool/,
  ],
  [
    { "typo.ts": "export default { poolz: {} };" },
    /typo\.ts[\s\S]*invalid Marbles config/,
  ],
] as const)(
  "rejects conflicting or invalid source config",
  async (files, message) => {
    await expect(source(files)).rejects.toThrow(message);
  }
);

it("ignores non-config defaults and accepts unbounded limits", async () => {
  const opened = await source({
    "config.ts": "export default { pools: { unlimited: Infinity } };",
    "function.ts": "export default () => 1;",
    "step.ts":
      'import { step } from "@foundry.sh/marbles"; export default step("one").do(() => 1);',
    "workflow.ts":
      'import { step, workflow } from "@foundry.sh/marbles"; const value = step().do(() => 1); export default workflow("two", () => value());',
  });
  expect(opened.pools).toEqual({ unlimited: null });
});

it("validates pool limits, blank names, and resets per-file config", () => {
  const catalog = new Catalog();
  for (const value of [0, -1, 1.5, Number.NaN]) {
    expect(() =>
      catalog.configure("bad.ts", { pools: { bad: value } })
    ).toThrow();
  }
  expect(() => catalog.configure("bad.ts", { pools: { " ": 1 } })).toThrow();
  catalog.configure(
    "good.ts",
    defineConfig({ pool: "review", pools: { review: { limit: 2 } } })
  );
  expect(catalog.poolFor("good.ts:12")).toBe("review");
  catalog.reset();
  expect(catalog.poolFor("good.ts:12")).toBeUndefined();
});

it("programmatic pools override the hosted default", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-override-"));
  roots.push(root);
  const catalog = new Catalog();
  catalog.configure("config.ts", { pools: { default: 2 } });
  const engine = createEngine({
    catalog,
    dry: true,
    pools: { default: 3 },
    print: () => undefined,
    root,
    workspaceId: "ws",
  });
  try {
    await engine.start();
    expect(await engine.executions.pools()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ limit: 3, name: "default" }),
      ])
    );
  } finally {
    await engine.dispose();
  }
});
