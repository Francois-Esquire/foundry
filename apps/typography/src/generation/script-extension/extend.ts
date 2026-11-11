/**
 * Extends a face into a planned part of another script. Each sheet goes
 * through the generation pipeline with the script's height model and the
 * syllable-separating Compose stage; the candidates that come out are then
 * settled into the script's spacing and turned into ordinary changes.
 */
import type { Change } from "~/typeface/changes";
import type { FaceId } from "~/typeface/face";
import { type Outline, outlineBounds } from "~/typeface/outline";
import type { Provenance } from "~/typeface/provenance";
import type { OpenFace } from "~/typeface/reading";
import type { Evaluation } from "../evaluation/evaluation";
import { type GenerationRun, runGeneration } from "../pipeline/run";
import type { ImageCodec } from "../raster/image-codec";
import type { GenerationStrategy } from "../strategies/strategy";
import { median } from "../style/measure";
import { analyseStyle, type StyleReference } from "../style/reference";
import { composeSyllables } from "./compose-syllables";
import { featureCodeFor } from "./features";
import { headlineThicknessOf, snapToHeadline } from "./glyph-lines";
import {
  type HeadlineLines,
  headlineHeightModel,
  headlineLines,
} from "./headline-lines";
import {
  ExtensionPlanError,
  nameCollisions,
  plannedSyllables,
  type ScriptExtensionPlan,
  targetsForCells,
} from "./plan";
import { type DrawnGlyph, type SettledGlyph, settleGlyphs } from "./settle";

/** One sheet of glyphs: what draws it, and the text each of its cells shows. */
export interface ExtensionSheet {
  readonly cells: readonly string[];
  readonly strategy: GenerationStrategy;
}

export interface ExtensionRequest {
  /** Says when each sheet's run started and ended. */
  readonly clock: () => Date;
  /** Decodes a sheet that arrives as a picture. */
  readonly codec?: Pick<ImageCodec, "decode">;
  readonly face: OpenFace;
  readonly faceId: FaceId;
  /** Makes run and candidate ids. */
  readonly newId: () => string;
  readonly plan: ScriptExtensionPlan;
  readonly sheets: readonly ExtensionSheet[];
}

export interface ExtensionGlyph extends SettledGlyph {
  /** The verdict and defects the pipeline's evaluation gave the candidate. */
  readonly evaluation?: Evaluation;
  /** The added glyph's key in the face: the id of the candidate it came from. */
  readonly key: string;
  /** How the glyph was made, in words: its sheet cell, or the syllable it was separated from. */
  readonly madeBy: string;
  readonly provenance: Provenance;
}

/** How the new letters' strokes compare with the source face's. */
interface WeightMatch {
  /** The middle thickness of the new letters' headlines. */
  readonly headline?: number;
  /** The thickness of the source face's level strokes. */
  readonly levelStroke: number;
  /**
   * The middle thickness of the headlines of glyphs cut from syllables. A
   * second sheet can come back at another weight than the first.
   */
  readonly separatedHeadline?: number;
  /** The middle thickness of the new letters' upright stems. */
  readonly stem?: number;
  /** The thickness of the source face's upright stems. */
  readonly uprightStroke: number;
}

export interface ScriptExtension {
  /** Added glyphs, then one set of layout rules. Ready for `commit`. */
  readonly changes: readonly Change[];
  readonly glyphs: readonly ExtensionGlyph[];
  readonly lines: HeadlineLines;
  /** Planned glyphs that were not made, each with the reason. */
  readonly missing: readonly {
    readonly name: string;
    readonly reason: string;
  }[];
  readonly notes: readonly string[];
  readonly plan: ScriptExtensionPlan;
  readonly runs: readonly GenerationRun[];
  readonly style: StyleReference;
  readonly weight: WeightMatch;
}

const sourceGlyphNames = (face: OpenFace): Set<string> =>
  new Set(
    Array.from({ length: face.description.glyphCount }, (_, glyphId) =>
      face.glyphName(glyphId)
    )
  );

const syllableCount = (plan: ScriptExtensionPlan, sheet: ExtensionSheet) => {
  const syllables = new Set(plannedSyllables(plan));
  return sheet.cells.filter((cell) => syllables.has(cell)).length;
};

const STEM_CHECK = "stem thickness";

const weightOf = (
  glyphs: readonly ExtensionGlyph[],
  lines: HeadlineLines,
  style: StyleReference
): WeightMatch => {
  const letters = glyphs.filter((glyph) => glyph.planned.rule.kind === "base");
  const headlineOf = (measured: readonly ExtensionGlyph[]) =>
    median(
      measured.flatMap(
        (glyph) => headlineThicknessOf(glyph.outline, lines) ?? []
      )
    );
  return {
    headline: headlineOf(letters),
    levelStroke: style.stems.horizontal,
    separatedHeadline: headlineOf(
      glyphs.filter((glyph) => glyph.planned.shownIn !== undefined)
    ),
    stem: median(
      letters.flatMap(
        (glyph) =>
          glyph.evaluation?.styleChecks.find(
            (check) => check.name === STEM_CHECK
          )?.measured ?? []
      )
    ),
    uprightStroke: style.stems.vertical,
  };
};

const extentNotes = (
  glyphs: readonly ExtensionGlyph[],
  style: StyleReference
): string[] =>
  glyphs.flatMap((glyph) => {
    const bounds = outlineBounds(glyph.outline);
    const { bottom, top } = style.extent;
    if (!bounds || (bounds.yMin >= bottom && bounds.yMax <= top)) {
      return [];
    }
    return [
      `${glyph.planned.name} runs from ${Math.round(bounds.yMin)} to ${Math.round(bounds.yMax)}, outside the face's lowest and highest lines (${Math.round(bottom)} and ${Math.round(top)}). It can be clipped where a line is set tight.`,
    ];
  });

interface Made {
  readonly drawn: DrawnGlyph;
  readonly evaluation?: Evaluation;
  readonly key: string;
  readonly provenance: Provenance;
}

export const extendScript = async (
  request: ExtensionRequest
): Promise<ScriptExtension> => {
  const { face, faceId, plan } = request;
  const collisions = nameCollisions(plan, sourceGlyphNames(face));
  if (collisions.length > 0) {
    throw new ExtensionPlanError(
      `The source font already has glyphs named ${collisions.join(", ")}. Give the plan's glyphs other names.`
    );
  }
  const style = analyseStyle(face);
  const lines = headlineLines(style);
  const heightModel = headlineHeightModel(plan, lines);
  const made = new Map<string, Made>();
  const attachments = new Map<string, number>();
  const runs: GenerationRun[] = [];
  // Sheets of whole letters first: a syllable is cut against a base that has to exist.
  const sheets = request.sheets.toSorted(
    (a, b) => syllableCount(plan, a) - syllableCount(plan, b)
  );
  for (const sheet of sheets) {
    const known = new Map<string, Outline>(
      [...made].map(([name, glyph]) => [
        name,
        snapToHeadline(glyph.drawn.outline, lines),
      ])
    );
    const run = await runGeneration({
      clock: request.clock,
      codec: request.codec,
      composer: composeSyllables({
        lines,
        made: known,
        onSeparated: (piece) => {
          if (piece.attachment !== undefined) {
            attachments.set(piece.name, piece.attachment);
          }
        },
        plan,
        style,
      }),
      face,
      faceId,
      heightModel,
      newId: request.newId,
      strategy: sheet.strategy,
      style,
      targets: targetsForCells(plan, sheet.cells),
    });
    runs.push(run);
    for (const candidate of run.candidates) {
      if (plan.glyphs.some((glyph) => glyph.name === candidate.name)) {
        made.set(candidate.name, {
          drawn: {
            attachment: attachments.get(candidate.name),
            outline: candidate.outline,
          },
          evaluation: run.evaluations.get(candidate.id),
          key: candidate.id,
          provenance: candidate.provenance,
        });
      }
    }
  }
  const settlement = settleGlyphs(
    plan,
    lines,
    new Map([...made].map(([name, glyph]) => [name, glyph.drawn]))
  );
  const glyphs = settlement.glyphs.flatMap((glyph): ExtensionGlyph[] => {
    const source = made.get(glyph.planned.name);
    return source
      ? [
          {
            ...glyph,
            evaluation: source.evaluation,
            key: source.key,
            madeBy: source.evaluation?.madeBy ?? "",
            provenance: source.provenance,
          },
        ]
      : [];
  });
  const features = featureCodeFor(plan, glyphs);
  const runNotes = runs.flatMap((run) => [
    ...run.record.notes,
    ...run.record.unmade.map(({ key, reason }) => `${key}: ${reason}`),
  ]);
  const changes: Change[] = [
    ...glyphs.map(
      (glyph): Change => ({
        faceId,
        glyph: {
          advance: glyph.advance,
          characters: glyph.planned.characters,
          key: glyph.key,
          name: glyph.planned.name,
          outline: glyph.outline,
          provenance: glyph.provenance,
        },
        kind: "glyph-added",
      })
    ),
    {
      code: features.code,
      description: `${plan.script} subset: layout rules for ${glyphs.length} generated glyphs`,
      faceId,
      kind: "features-added",
    },
  ];
  return {
    changes,
    glyphs,
    lines,
    missing: plan.glyphs
      .filter((planned) => !made.has(planned.name))
      .map((planned) => ({
        name: planned.name,
        reason:
          runNotes.find((note) => note.includes(planned.name)) ??
          "No sheet drew it.",
      })),
    notes: [
      ...runNotes,
      ...settlement.notes,
      ...features.omitted,
      ...extentNotes(glyphs, style),
    ],
    plan,
    runs,
    style,
    weight: weightOf(glyphs, lines, style),
  };
};
