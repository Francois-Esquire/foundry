/**
 * Replays a recorded run against a source font, in Node, without calling any
 * model: extraction, normalisation, evaluation and refinement. Writes, for
 * each output in the run, a JSON report and an SVG contact sheet that shows
 * every candidate over the glyph it is compared with.
 *
 *   bun scripts/generation/run-recorded.ts <run directory> <font file>
 *     [--out <directory>]       where to write. A temporary directory by default.
 *     [--output <label>]        one output of the run, by name or strategy.
 *     [--compare <font file>]   compare with this font's glyphs where the
 *                               source font has none. A check of letter
 *                               identity only, never of style.
 *     [--zone <bottom>,<top>]   the two lines every glyph stands between, in
 *                               font units, for scripts the Latin height
 *                               model has no lines for.
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { isCorrectable } from "~/generation/evaluation/evaluation";
import { nodeImageCodec } from "~/generation/node-image-codec";
import {
  type HeightModel,
  latinHeightModel,
  uniformHeightModel,
} from "~/generation/normalise/height-model";
import { type GenerationRun, runGeneration } from "~/generation/pipeline/run";
import type { GlyphTarget } from "~/generation/plan/target";
import {
  loadRecordedRuns,
  outputLabel,
  type RecordedRun,
  recordedTargets,
} from "~/generation/strategies/recorded/manifest";
import { recordedRunStrategy } from "~/generation/strategies/recorded/recorded-run";
import {
  analyseStyle,
  type StyleReference,
} from "~/generation/style/reference";
import {
  outlineBounds,
  outlinePoints,
  transformOutline,
} from "~/typeface/outline";
import type { GlyphShape, OpenFace } from "~/typeface/reading";
import { type ContactEntry, contactSheet } from "./contact-sheet";

interface Comparison {
  readonly glyph: GlyphShape;
  readonly with: string;
}

const openFont = (file: string): OpenFace =>
  harfBuzzReader.open(new Uint8Array(readFileSync(file)));

const readDirectory = (directory: string): Map<string, Uint8Array> =>
  new Map(
    readdirSync(directory)
      .filter((name) => statSync(path.join(directory, name)).isFile())
      .map((name) => [
        name,
        new Uint8Array(readFileSync(path.join(directory, name))),
      ])
  );

/** A glyph from another font, scaled to the source font's units per em. */
const fromOtherFont = (
  other: OpenFace,
  target: GlyphTarget,
  unitsPerEm: number
): GlyphShape | undefined => {
  const { glyphs } = other.shape(target.text);
  const [only] = glyphs;
  if (glyphs.length !== 1 || !only) {
    return;
  }
  const glyph = other.glyph(only.glyphId);
  const scale = unitsPerEm / other.description.metrics.unitsPerEm;
  return {
    advance: glyph.advance * scale,
    outline: transformOutline(glyph.outline, {
      dx: 0,
      dy: 0,
      xx: scale,
      xy: 0,
      yx: 0,
      yy: scale,
    }),
  };
};

/**
 * What each target is compared with. When the run was made from the given
 * font, the font's own glyph: a holdout test. Else the comparison font's
 * glyph, for letter identity. Else nothing: a font the run was not made from
 * is no measure of it.
 */
const comparisonsFor = (
  targets: readonly GlyphTarget[],
  face: OpenFace,
  other: OpenFace | undefined,
  isSource: boolean
): Map<string, Comparison> => {
  const comparisons = new Map<string, Comparison>();
  for (const target of targets) {
    if (isSource && target.replaces?.kind === "source") {
      comparisons.set(target.key, {
        glyph: face.glyph(target.replaces.glyphId),
        with: `${face.description.fullName}, the source font (holdout)`,
      });
      continue;
    }
    const glyph =
      other &&
      fromOtherFont(other, target, face.description.metrics.unitsPerEm);
    if (glyph && other) {
      comparisons.set(target.key, {
        glyph,
        with: `${other.description.fullName}, for letter identity only`,
      });
    }
  }
  return comparisons;
};

const heightModelFor = (
  zone: string | undefined,
  style: StyleReference
): HeightModel => {
  if (!zone) {
    return latinHeightModel(style);
  }
  const [bottom, top] = zone.split(",").map(Number);
  if (bottom === undefined || top === undefined || !(top > bottom)) {
    throw new Error("--zone takes two numbers, bottom then top: --zone 0,1244");
  }
  return uniformHeightModel({ bottom, name: "glyph in the given zone", top });
};

const reportOf = (
  recorded: RecordedRun,
  run: GenerationRun,
  targets: readonly GlyphTarget[],
  comparisons: ReadonlyMap<string, Comparison>,
  style: StyleReference
) => ({
  candidates: run.candidates.map((candidate) => {
    const evaluation = run.evaluations.get(candidate.id);
    const key = evaluation?.key ?? "";
    return {
      advance: candidate.advance,
      bounds: outlineBounds(candidate.outline),
      characters: candidate.characters,
      comparedWith: comparisons.get(key)?.with,
      contours: candidate.outline.contours.length,
      corrections: run.artefacts.corrections.get(key) ?? [],
      defects: (evaluation?.defects ?? []).map((defect) => ({
        ...defect,
        correctable: isCorrectable(defect),
      })),
      id: candidate.id,
      madeBy: evaluation?.madeBy,
      name: candidate.name,
      points: outlinePoints(candidate.outline).length,
      provenance: candidate.provenance,
      scores: evaluation?.scores,
      styleChecks: evaluation?.styleChecks,
      text: targets.find((target) => target.key === key)?.text,
      verdict: evaluation?.verdict,
    };
  }),
  extraction: run.artefacts.extraction && {
    report: run.artefacts.extraction.report,
    rotation: run.artefacts.extraction.rotation,
    rows: run.artefacts.extraction.rows,
    size: run.artefacts.extraction.size,
    sources: run.artefacts.extraction.glyphs.map((glyph) => ({
      key: glyph.key,
      source: glyph.source,
    })),
  },
  fit: run.artefacts.fit,
  output: recorded.output,
  record: run.record,
  rejected: run.rejected,
  run: recorded.manifest.id,
  style,
});

interface Setup {
  /** A second font to compare with where the source font has no glyph. */
  readonly comparison?: OpenFace;
  /** The file name of the font given, to tell whether the run was made from it. */
  readonly fontName: string;
  readonly outDirectory: string;
  readonly source: OpenFace;
  readonly zone?: string;
}

const replay = async (
  recorded: RecordedRun,
  { comparison: other, fontName, outDirectory, source: face, zone }: Setup
) => {
  const style = analyseStyle(face);
  const targets = recordedTargets(recorded, face);
  const isSource = recorded.manifest.sourceFont?.file === fontName;
  const comparisons = comparisonsFor(targets, face, other, isSource);
  const run = await runGeneration({
    clock: () => new Date(),
    codec: nodeImageCodec,
    face,
    faceId: face.description.postScriptName,
    heightModel: heightModelFor(zone, style),
    holdouts: new Map(
      [...comparisons].map(([key, comparison]) => [key, comparison.glyph])
    ),
    newId: () => crypto.randomUUID(),
    strategy: recordedRunStrategy(recorded),
    style,
    targets,
  });
  const entries: ContactEntry[] = run.candidates.map((candidate) => {
    const evaluation = run.evaluations.get(candidate.id);
    const comparison = comparisons.get(evaluation?.key ?? "");
    return {
      candidate,
      comparedWith: comparison?.with,
      evaluation,
      reference: comparison?.glyph,
      text:
        targets.find((target) => target.key === evaluation?.key)?.text ?? "",
    };
  });
  const label = outputLabel(recorded.output);
  const title = `${recorded.manifest.id} (${label}): recorded output of ${recorded.output.model}, replayed against ${face.description.fullName}. Blue is the candidate.`;
  const reportFile = path.join(outDirectory, `${label}.report.json`);
  const sheetFile = path.join(outDirectory, `${label}.contact.svg`);
  writeFileSync(
    reportFile,
    JSON.stringify(
      reportOf(recorded, run, targets, comparisons, style),
      null,
      2
    )
  );
  writeFileSync(sheetFile, contactSheet(title, entries, style));
  const summary = entries.map(
    ({ evaluation, text }) =>
      `${text} ${evaluation?.verdict} ${evaluation?.scores.shape?.toFixed(3) ?? "n/a"}`
  );
  const holdouts = entries.filter((entry) =>
    entry.comparedWith?.includes("(holdout)")
  ).length;
  const compared = entries.filter((entry) => entry.reference).length;
  const basis = `${holdouts} compared with the source font as a holdout, ${compared - holdouts} with the comparison font for letter identity, ${entries.length - compared} not compared`;
  process.stdout.write(
    `${label}: ${run.candidates.length} candidate(s), ${run.record.unmade.length} unmade; ${basis}.\n  ${summary.join("\n  ")}\n  ${reportFile}\n  ${sheetFile}\n`
  );
};

const USAGE =
  "Usage: bun scripts/generation/run-recorded.ts <run directory> <font file> [--out <directory>] [--output <label>] [--compare <font file>] [--zone <bottom>,<top>]";

const main = async () => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      compare: { type: "string" },
      out: { type: "string" },
      output: { type: "string" },
      zone: { type: "string" },
    },
  });
  const [runDirectory, fontFile] = positionals;
  if (!(runDirectory && fontFile)) {
    throw new Error(USAGE);
  }
  const files = readDirectory(runDirectory);
  const manifest = files.get("run.json");
  if (!manifest) {
    throw new Error(`${runDirectory} has no run.json.`);
  }
  const chosen = loadRecordedRuns(
    new TextDecoder().decode(manifest),
    files
  ).filter(
    ({ output }) =>
      !values.output ||
      output.name === values.output ||
      output.strategy === values.output
  );
  const setup: Setup = {
    comparison: values.compare ? openFont(values.compare) : undefined,
    fontName: path.basename(fontFile),
    outDirectory:
      values.out ??
      path.join(tmpdir(), "typography-recorded", path.basename(runDirectory)),
    source: openFont(fontFile),
    zone: values.zone,
  };
  mkdirSync(setup.outDirectory, { recursive: true });
  for (const recorded of chosen) {
    await replay(recorded, setup);
  }
};

await main();
