import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import { applyReductionPlan, sha256 } from "../../src/lib/apply";
import { planRecordFile, planSite, resolveSite } from "../../src/lib/codemod";
import { applyRecord } from "../../src/lib/codemod-apply";
import { scan } from "../../src/lib/scan";
import { workspaceState } from "../../src/lib/state";
import type { InternalizeSymbolPlan } from "../../src/lib/types";
import { commitFixture } from "../helpers/commit-fixture";
import { importerFixture } from "./helpers/importer-fixture";

const roots: string[] = [];
const INDEX = "packages/a/src/index.ts";
const USER = "packages/a/src/user.ts";

async function fixture(
  user: string,
  entrypoint = 'export { make, kept } from "./model";\n',
  extraFiles: Record<string, string> = {}
) {
  const root = importerFixture({
    "src/index.ts": entrypoint,
    "src/model.ts":
      "export function make(): number { return 1; }\nexport const kept = 2;\n",
    "src/user.ts": user,
    ...extraFiles,
  });
  roots.push(root);
  const before = await analyzeSurface({ root, target: "packages/a" });
  const plan = before.plans.find(
    (candidate): candidate is InternalizeSymbolPlan =>
      candidate.operation === "internalize-symbol" &&
      candidate.subject.name === "make"
  );
  if (plan === undefined) {
    throw new Error("Missing make plan");
  }
  expect(plan.status).toBe("ready");
  return { before, plan, root };
}

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

it("previews a split import before removing the export without writing any file", async () => {
  const user =
    'import { make as build, kept } from "./index";\nexport const used = build() + kept;\n';
  const { before, plan, root } = await fixture(user);
  const result = await applyReductionPlan(plan, { before, root });
  expect(result.status).toBe("preview");
  expect(result.changedFiles).toEqual([INDEX, USER]);
  expect(result.edits?.[0]).toMatchObject({
    before: 'import { make as build, kept } from "./index";',
    file: USER,
  });
  expect(result.edits?.[0]?.after).toContain('import { kept } from "./index";');
  expect(result.edits?.[0]?.after).toContain(
    'import { make as build } from "./model";'
  );
  expect(readFileSync(join(root, USER), "utf8")).toBe(user);
});

const IMPORT_SHAPES = [
  [
    'import { make as build } from "./index.js";',
    'import { make as build } from "./model.js";',
  ],
  [
    'import type { make } from "./index";',
    'import type { make } from "./model";',
  ],
  [
    'import { type make, kept } from "./index";',
    'import { type make } from "./model";',
  ],
  [
    'import { make } from "./index";\nimport { kept } from "./model";',
    'import { kept, make } from "./model";',
  ],
  [
    'import type { make } from "./index";\nimport { kept } from "./model";',
    'import { kept, type make } from "./model";',
  ],
  [
    'import { make } from "./index";\nimport type { kept } from "./model";',
    'import { make } from "./model";',
  ],
  [
    'import type { make } from "./index";\nimport type { kept } from "./model";',
    'import type { kept, make } from "./model";',
  ],
  [
    'import kept, { make } from "./index";',
    'import kept from "./index";\nimport { make } from "./model";',
  ],
] as const;

it("preserves aliases, import styles and type semantics across split and merged imports", async () => {
  const files = Object.fromEntries(
    IMPORT_SHAPES.map(([statement], i) => [
      `src/case-${i}.ts`,
      `${statement}\nexport const used = 0;\n`,
    ])
  );
  const { before, plan, root } = await fixture(
    "export const user = 0;\n",
    'export { make, kept, kept as default } from "./model";\n',
    files
  );
  const result = await applyReductionPlan(plan, { before, root });
  expect(result.status).toBe("preview");
  for (const [i, [, expected]] of IMPORT_SHAPES.entries()) {
    const edit = result.edits?.find(
      (entry) => entry.file === `packages/a/src/case-${i}.ts`
    );
    expect(edit?.after).toContain(expected);
  }
});

it("writes importers and routes together, verifies the result, and preserves the implementation", async () => {
  const { before, plan, root } = await fixture(
    'import { make as build, kept } from "./index";\nexport const used = build() + kept;\n'
  );
  const model = readFileSync(join(root, "packages/a/src/model.ts"));
  const journal: string[] = [];
  const result = await applyReductionPlan(plan, {
    before,
    beforeWrite: async (files) => {
      journal.push(...files.map((entry) => entry.file));
    },
    root,
    write: true,
  });
  expect(result.status).toBe("applied");
  expect(result.verification?.status).toBe("pass");
  expect(journal.sort()).toEqual([INDEX, USER]);
  expect(readFileSync(join(root, USER), "utf8")).toContain(
    'import { make as build } from "./model";'
  );
  expect(readFileSync(join(root, INDEX), "utf8")).toContain(
    'export { kept } from "./model";'
  );
  expect(readFileSync(join(root, "packages/a/src/model.ts"))).toEqual(model);
});

it("restores the exact bytes of every importer and route when verification fails", async () => {
  const { before, plan, root } = await fixture(
    '\uFEFFimport { make } from "./index";\r\nexport const used = make();\r\n'
  );
  const original = [INDEX, USER].map((file) => readFileSync(join(root, file)));
  const result = await applyReductionPlan(plan, {
    afterChecks: async () => [
      { check: "forced failure", detail: "rollback fixture", status: "fail" },
    ],
    before,
    beforeWrite: async () => {
      // This fixture verifies in-process rollback; it needs no durable journal.
    },
    root,
    write: true,
  });
  expect(result.status).toBe("rolled-back");
  expect([INDEX, USER].map((file) => readFileSync(join(root, file)))).toEqual(
    original
  );
});

it("keeps a renamed public binding local when it imports the declaration's own name", async () => {
  const { before, plan, root } = await fixture(
    'import { build as run } from "./index";\nexport const used = run();\n',
    'export { make as build, kept } from "./model";\n'
  );
  const result = await applyReductionPlan(plan, { before, root });
  expect(result.status).toBe("preview");
  expect(result.edits?.[0]?.after).toBe(
    'import { make as run } from "./model";'
  );
});

it("does not rewrite the same import twice when the symbol has two exposed names", async () => {
  const { before, plan, root } = await fixture(
    'import { make, build } from "./index";\nexport const used = make() + build();\n',
    'export { make, make as build, kept } from "./model";\n'
  );
  const result = await applyReductionPlan(plan, { before, root });
  expect(result.status).toBe("preview");
  expect(result.edits?.[0]?.after).toBe(
    'import { make, make as build } from "./model";'
  );
});

it("protects a dirty importer before it edits any route", async () => {
  const { before, plan, root } = await fixture(
    'import { make } from "./index";\nexport const used = make();\n'
  );
  appendFileSync(join(root, USER), "// concurrent edit\n");
  const original = readFileSync(join(root, INDEX));
  const result = await applyReductionPlan(plan, { before, root, write: true });
  expect(result.status).toBe("blocked");
  expect(result.blockers).toEqual([
    expect.objectContaining({
      detail: expect.stringContaining(USER),
      reason: "dirty-working-tree",
    }),
  ]);
  expect(readFileSync(join(root, INDEX))).toEqual(original);
});

it("rejects an importer hash that moved after readiness and writes nothing", async () => {
  const { before, plan, root } = await fixture(
    'import { make } from "./index";\nexport const used = make();\n'
  );
  const original = [INDEX, USER].map((file) => readFileSync(join(root, file)));
  const result = await applyReductionPlan(plan, {
    before,
    beforeWrite: async () => {
      throw new Error("stale importer reached the journal");
    },
    expectedHashes: new Map([
      [INDEX, sha256(original[0] ?? new Uint8Array())],
      [USER, "stale"],
    ]),
    root,
    write: true,
  });
  expect(result.status).toBe("stale");
  expect([INDEX, USER].map((file) => readFileSync(join(root, file)))).toEqual(
    original
  );
});

it("authorizes, previews, applies, and refreshes an importer rewrite through the public codemod flow", async () => {
  const { root } = await fixture(
    'import { make as build, kept } from "./index";\nexport const used = build() + kept;\n'
  );
  const packagePath = join(root, "packages/a/package.json");
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  writeFileSync(
    packagePath,
    JSON.stringify({ ...manifest, scripts: { test: "bun test" } })
  );
  mkdirSync(join(root, "packages/a/src/test"), { recursive: true });
  writeFileSync(
    join(root, "packages/a/src/test/user.test.ts"),
    'import { expect, test } from "bun:test";\nimport { used } from "../user";\ntest("internal use still works", () => { expect(used).toBe(3); });\n'
  );
  mkdirSync(join(root, ".foundry/spyglass"), { recursive: true });
  writeFileSync(
    join(root, ".foundry/spyglass/rules.ts"),
    'export default { rules: [{ effect: "permit", operator: "internalize", subject: "packages/a" }] };\n'
  );
  commitFixture(root);
  const state = mkdtempSync(join(tmpdir(), "spyglass-importer-state-"));
  roots.push(state);
  await scan.workspace(root, { history: false, state });
  const site = resolveSite("packages/a/src/model.ts#make");
  const authorized = await planSite(root, site, { state });
  expect(authorized.verdict.kind).toBe("authorized");
  const original = [INDEX, USER].map((file) => readFileSync(join(root, file)));
  const preview = await applyRecord(root, site, { state });
  expect(preview.status).toBe("preview");
  expect(preview.changedFiles).toEqual([INDEX, USER]);
  expect([INDEX, USER].map((file) => readFileSync(join(root, file)))).toEqual(
    original
  );
  const applied = await applyRecord(root, site, { state, write: true });
  expect(applied.status).toBe("applied");
  expect(applied.verification?.status).toBe("pass");
  expect(applied.scan?.status).toBe("published");
  expect(readFileSync(join(root, USER), "utf8")).toContain(
    'import { make as build } from "./model";'
  );
  const workspace = await workspaceState(root, state);
  expect(existsSync(planRecordFile(workspace, site.planId))).toBe(false);
  expect(existsSync(join(workspace.directory, "apply/journal.json"))).toBe(
    false
  );
}, 60_000);
