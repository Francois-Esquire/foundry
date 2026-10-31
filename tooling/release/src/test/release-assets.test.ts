import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { YAML } from "bun";

const ROOT = resolve(import.meta.dirname, "../../../..");

interface Workflow {
  jobs: Record<
    string,
    | {
        if?: string;
        needs?: string[];
        permissions?: Record<string, string>;
        steps?: {
          run?: string;
          uses?: string;
          with?: Record<string, string>;
          "working-directory"?: string;
        }[];
        uses?: string;
      }
    | undefined
  >;
  on: Record<string, unknown>;
}

test("release assets are CI's tested archives of the released commit, attached without rebuilding", () => {
  const text = readFileSync(
    resolve(ROOT, ".github/workflows/release-assets.yml"),
    "utf8"
  );
  const workflow = YAML.parse(text) as Workflow;
  expect(Object.keys(workflow.on).sort()).toEqual([
    "workflow_call",
    "workflow_dispatch",
  ]);
  expect(workflow.on.workflow_dispatch).toMatchObject({
    inputs: { version: { type: "string" } },
  });
  expect(workflow.jobs.resolve?.if).toContain("refs/heads/main");
  expect(workflow.jobs.assets?.needs).toEqual(["resolve"]);
  expect(workflow.jobs.assets?.permissions).toEqual({
    actions: "read",
    contents: "write",
  });
  expect(text).not.toContain("npm publish");
  expect(text).not.toContain("release:prepare");
  expect(text).not.toContain("id-token");
  for (const rebuild of ["bun run build", "release:pack", "release-source"]) {
    expect(text).not.toContain(rebuild);
  }
  const steps = workflow.jobs.assets?.steps ?? [];
  expect(
    steps.filter(({ uses }) => uses?.startsWith("actions/checkout@"))
  ).toHaveLength(1);
  expect(steps.find(({ run }) => run?.includes(" collect "))?.run).toBe(
    'bun tooling/release/src/cli.ts collect --sha "$RELEASE_SHA" --packages "$PACKAGES"'
  );
  // Archives already attached to a release are confirmed, never replaced.
  expect(text).not.toContain("--clobber");
  expect(text).toContain('gh release upload "$tag" "$file"');
  expect(text).toContain('cmp "$tarball"');

  const release = YAML.parse(
    readFileSync(resolve(ROOT, ".github/workflows/release.yml"), "utf8")
  ) as Workflow;
  expect(release.jobs.assets).toMatchObject({
    needs: ["release"],
    permissions: { actions: "read", contents: "write" },
    uses: "./.github/workflows/release-assets.yml",
  });
});
