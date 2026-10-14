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
          with?: Record<string, string>;
          "working-directory"?: string;
        }[];
        uses?: string;
      }
    | undefined
  >;
  on: Record<string, unknown>;
}

test("Package assets can be backfilled independently of versioning and npm publication", () => {
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
  expect(workflow.jobs.assets?.permissions).toEqual({ contents: "write" });
  expect(text).not.toContain("npm publish");
  expect(text).not.toContain("release:prepare");
  expect(text).not.toContain("id-token");
  expect(text).not.toContain("scripts/release-assets");
  const steps = workflow.jobs.assets?.steps ?? [];
  expect(
    steps.find((step) => step.with?.path === "release-source")?.with?.ref
  ).toContain("needs.resolve.outputs.sha");
  const packaging = steps.find((step) => step.run?.includes("release:pack"));
  expect(packaging?.run).toContain("--root release-source");
  expect(text).toContain("released.files = current.files;");
  expect(text).toContain('gh release upload "$tag" "$tarball" "$zip"');

  const release = YAML.parse(
    readFileSync(resolve(ROOT, ".github/workflows/release.yml"), "utf8")
  ) as Workflow;
  expect(release.jobs.assets).toMatchObject({
    needs: ["release"],
    uses: "./.github/workflows/release-assets.yml",
  });
});
