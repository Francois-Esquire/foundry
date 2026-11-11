/**
 * Real model output, end to end. Two models were shown twelve Lato glyphs and
 * asked to draw six others that Lato already has (a holdout test). This runs
 * their saved output through the pipeline, compares every glyph with the real
 * one, then accepts one, edits it by hand, and builds a font with it in.
 *
 * Nothing here calls a model. The sheets are recorded runs, and their
 * candidates say so in their provenance.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { nodeImageCodec } from "~/generation/node-image-codec";
import { type GenerationRun, runGeneration } from "~/generation/pipeline/run";
import {
  loadRecordedRuns,
  recordedTargets,
} from "~/generation/strategies/recorded/manifest";
import { recordedRunStrategy } from "~/generation/strategies/recorded/recorded-run";
import { analyseStyle } from "~/generation/style/reference";
import { nodeFontBuilder } from "~/packaging/engine/node";
import { outlineBounds } from "~/typeface/outline";
import { editablePoints, movePoints } from "~/typeface/outline-editing";
import {
  acceptCandidate,
  addSource,
  commit,
  digestOf,
  emptyProject,
  propose,
  type TypefaceProject,
  workingFaceOf,
} from "~/typeface/project";
import type { GlyphShape, OpenFace } from "~/typeface/reading";
import { fontBytes } from "./helpers/fixtures";

const RUN_DIR = path.join(
  import.meta.dirname,
  "fixtures/generation/2026-11-10-latin-holdout"
);

const loadRun = (strategy: "image-model" | "vector-model") => {
  const files = new Map<string, Uint8Array>(
    readdirSync(RUN_DIR).map((file) => [
      file,
      new Uint8Array(readFileSync(path.join(RUN_DIR, file))),
    ])
  );
  const run = loadRecordedRuns(
    readFileSync(path.join(RUN_DIR, "run.json"), "utf8"),
    files
  ).find((candidate) => candidate.output.strategy === strategy);
  if (!run) {
    throw new Error(`The holdout run has no ${strategy} output.`);
  }
  return run;
};

describe("recorded model output becomes glyphs in a font", () => {
  const lato = fontBytes("lato");
  let face: OpenFace;
  let project: TypefaceProject;
  let faceId: string;
  const runs = new Map<string, GenerationRun>();

  const generate = async (strategy: "image-model" | "vector-model") => {
    const recorded = loadRun(strategy);
    const targets = recordedTargets(recorded, face);
    const holdouts = new Map<string, GlyphShape>();
    for (const target of targets) {
      if (target.replaces?.kind === "source") {
        holdouts.set(target.key, face.glyph(target.replaces.glyphId));
      }
    }
    return await runGeneration({
      codec: nodeImageCodec,
      face,
      faceId,
      holdouts,
      strategy: recordedRunStrategy(recorded),
      style: analyseStyle(face),
      targets,
    });
  };

  beforeAll(async () => {
    face = harfBuzzReader.open(lato);
    project = addSource(
      emptyProject(),
      {
        bytes: lato,
        fileName: "Lato-Regular.ttf",
        id: await digestOf(lato),
        importedAt: "2026-11-10T00:00:00.000Z",
      },
      [face.description]
    );
    faceId = project.faces[0]?.id ?? "";
    runs.set("image", await generate("image-model"));
    runs.set("vector", await generate("vector-model"));
  });

  it.each(["image", "vector"])(
    "turns the %s model's sheet into six candidates",
    (kind) => {
      const run = runs.get(kind);
      const scores = [...(run?.evaluations.values() ?? [])].map(
        (evaluation) => ({
          key: evaluation.key,
          shape: evaluation.scores.shape,
          verdict: evaluation.verdict,
        })
      );
      console.log(
        kind,
        run?.record.model,
        JSON.stringify(scores),
        JSON.stringify(run?.record.unmade)
      );
      expect(run?.candidates).toHaveLength(6);
      expect(run?.record.recorded).toBe(true);
      for (const candidate of run?.candidates ?? []) {
        expect(candidate.provenance).toMatchObject({
          origin: "generated",
          recorded: true,
        });
        expect(outlineBounds(candidate.outline)).toBeDefined();
      }
    }
  );

  it("accepts a generated glyph, takes a hand edit, and builds a font with it", async () => {
    const run = runs.get("vector");
    const [first] = run?.candidates ?? [];
    if (!first) {
      throw new Error("no candidate");
    }
    const accepted = acceptCandidate(
      propose(project, run?.candidates ?? []),
      first.id
    );
    const working = workingFaceOf(accepted, faceId);
    const glyphRef = first.replaces;
    if (glyphRef?.kind !== "source") {
      throw new Error("the holdout candidate should redraw a source glyph");
    }
    const generated = working.overrides.get(glyphRef.glyphId);
    expect(generated?.provenance).toMatchObject({
      origin: "generated",
      recorded: true,
    });

    // Refine by hand: move one node, as a person would in the Studio.
    const outline = generated?.outline ?? first.outline;
    const [node] = editablePoints(outline);
    if (!node) {
      throw new Error("no node to move");
    }
    const edited = commit(accepted, {
      changes: [
        {
          faceId,
          glyph: glyphRef,
          kind: "outline-replaced",
          outline: movePoints(outline, [node.address], 12, 0),
        },
      ],
      label: "Refine by hand",
    });
    const refined = workingFaceOf(edited, faceId);
    expect(refined.overrides.get(glyphRef.glyphId)?.provenance).toEqual({
      origin: "manual",
    });

    const builder = await nodeFontBuilder();
    const built = await builder.build({
      added: refined.added,
      faceIndex: 0,
      familyName: "Holdout Derived",
      featureCode: refined.featureCode,
      overrides: refined.overrides,
      source: lato,
    });
    expect((await builder.validate(built.bytes)).loadable).toBe(true);
    const derived = harfBuzzReader.open(built.bytes);
    const character = first.characters[0] ?? 0;
    const before = face.glyph(face.glyphForCharacter(character) ?? 0);
    const after = derived.glyph(derived.glyphForCharacter(character) ?? 0);
    expect(after.outline).not.toEqual(before.outline);
    expect(after.advance).toBe(first.advance);
    expect(derived.shape("fi").glyphs).toHaveLength(1);
  });
});
