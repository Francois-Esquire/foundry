/**
 * The export path on a real font, without a screen: a draft becomes a plan,
 * the plan is resolved with the real Unicode data, and the build runner
 * builds and validates what it resolves to.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import {
  type BuildRunDependencies,
  type OutputRun,
  runBuilds,
} from "~/export/build-run";
import { type PlanDraft, planOf, startDraft } from "~/export/plan-draft";
import { characterLookups } from "~/export/unicode-lookups";
import type { FontBuilder } from "~/packaging/building";
import { nodeFontBuilder } from "~/packaging/engine/node";
import { resolveExportPlan } from "~/packaging/resolving";
import type { FaceId } from "~/typeface/face";
import { languages } from "~/unicode/languages";
import { charactersIn } from "~/unicode/scope";
import type { Workspace } from "~/workspace/workspace";
import { fixtureFile, importOne, testWorkspace } from "../helpers/workspace";

describe("exporting a Basic Latin subset of Lato", () => {
  let builder: FontBuilder;
  let workspace: Workspace;
  let faceId: FaceId;

  const resolve = async (draft: PlanDraft) => {
    const { project } = workspace.getState();
    return resolveExportPlan(
      project,
      planOf(draft, project).plan,
      characterLookups(await languages(), (id) =>
        workspace.openFace(id).characters()
      )
    );
  };

  const dependencies = (): BuildRunDependencies => {
    let issued = 0;
    return {
      builder,
      charactersOfFace: (id) => workspace.openFace(id).characters(),
      newId: () => {
        issued += 1;
        return `built-${issued}`;
      },
      now: () => "2026-11-10T09:00:00.000Z",
      reader: harfBuzzReader,
    };
  };

  const subsetDraft = (familyName: string): PlanDraft => ({
    ...startDraft(faceId),
    blocks: ["Basic Latin"],
    familyName,
    keep: "selection",
  });

  beforeAll(async () => {
    builder = await nodeFontBuilder();
    workspace = testWorkspace();
    ({ faceId } = await importOne(workspace, fixtureFile("lato")));
  });

  it("resolves an untouched plan to the original file, with nothing to build", async () => {
    const resolution = await resolve(startDraft(faceId));
    expect(resolution.problems).toEqual([]);
    expect(resolution.outputs.map((output) => output.kind)).toEqual([
      "original",
    ]);
  });

  it("blocks the subset while the family name contains the reserved name", async () => {
    for (const familyName of ["", "Lato Subset", "Plato"]) {
      const resolution = await resolve(subsetDraft(familyName));
      expect(resolution.problems.map((problem) => problem.code)).toEqual([
        "reserved-font-name",
      ]);
    }
    const renamed = await resolve(subsetDraft("Atlas Sans"));
    expect(renamed.problems).toEqual([]);
    expect(renamed.outputs.map((output) => output.fileName)).toEqual([
      "AtlasSans-Regular-subset.ttf",
    ]);
  });

  it("builds nothing from a blocked plan and says why", async () => {
    const steps: (readonly OutputRun[])[] = [];
    const outputs = await runBuilds(
      await resolve(subsetDraft("Lato Subset")),
      dependencies(),
      (step) => steps.push(step)
    );
    expect(outputs.map((output) => output.progress.status)).toEqual(["failed"]);
    const [{ progress } = { progress: undefined }] = outputs;
    expect(progress?.status === "failed" && progress.message).toContain(
      'reserves the name "Lato"'
    );
  });

  it("builds the renamed subset, and every validation check that can run passes", async () => {
    const steps: string[] = [];
    const outputs = await runBuilds(
      await resolve(subsetDraft("Atlas Sans")),
      dependencies(),
      (step) => steps.push(step.map((o) => o.progress.status).join())
    );
    expect(steps).toEqual(["waiting", "building", "validating", "built"]);
    const [{ progress } = { progress: undefined }] = outputs;
    if (progress?.status !== "built") {
      throw new Error("The subset was not built.");
    }
    const { font } = progress;
    expect(
      Object.fromEntries(
        font.report.checks.map((check) => [check.id, check.outcome])
      )
    ).toEqual({
      // Node has no browser. The end-to-end test runs this check in Chrome.
      browser: "not-run",
      coverage: "pass",
      engine: "pass",
      joining: "pass",
      reopen: "pass",
      shaping: "pass",
    });
    expect(font.samples.map((entry) => entry.sample.text)).toEqual([
      "office",
      "fi",
      "AV",
      "Waffle",
      "Letters carry the voice of a page",
    ]);

    const source = workspace.openFace(faceId);
    const selected = new Set(
      charactersIn({ kind: "block", name: "Basic Latin" })
    );
    const expected = [...source.characters()].filter((character) =>
      selected.has(character)
    );
    const derived = harfBuzzReader.open(font.bytes);
    try {
      expect([...derived.characters()]).toEqual(expected);
      expect(expected.length).toBeGreaterThanOrEqual(95);
      expect(derived.description.familyName).toBe("Atlas Sans");
      expect(derived.shape("fi").glyphs).toHaveLength(1);
    } finally {
      derived.close();
    }
  });

  it("keeps a failed build with its output and carries on", async () => {
    const failing: FontBuilder = {
      ...builder,
      build: () => Promise.reject(new Error("The font engine stopped.")),
    };
    const outputs = await runBuilds(
      await resolve(subsetDraft("Atlas Sans")),
      { ...dependencies(), builder: failing },
      () => undefined
    );
    expect(outputs.map((output) => output.progress)).toEqual([
      { message: "The font engine stopped.", status: "failed" },
    ]);
  });
});
