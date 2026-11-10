/**
 * Builds the derived fonts of a resolved plan one at a time and validates
 * each, reporting every step as it happens. A failure in one output is kept
 * with that output and does not stop the others.
 */
import type { BuildRequest, FontBuilder } from "~/packaging/building";
import { exportFonts } from "~/packaging/exporting";
import type { ExportOutput, ExportResolution } from "~/packaging/resolving";
import {
  type DerivedFontReport,
  validateDerivedFont,
} from "~/packaging/validation";
import type { FaceId } from "~/typeface/face";
import type { FontReader } from "~/typeface/reading";
import { type KeptScriptSample, shapingSamples } from "./shaping-samples";

export type DerivedOutput = Extract<ExportOutput, { kind: "derived" }>;

/** A derived font that was built in this session, with what it was built from. */
export interface BuiltFont {
  readonly builtAt: string;
  readonly bytes: Uint8Array;
  readonly faceId: FaceId;
  readonly fileName: string;
  readonly id: string;
  /** Notes from the engine, such as outlines it had to convert. */
  readonly notes: readonly string[];
  readonly report: DerivedFontReport;
  readonly request: BuildRequest;
  /**
   * The project's head revision when the build was asked for, undefined when
   * no revision was applied. A project whose head is another revision has
   * changed since the font was built.
   */
  readonly revisionId: string | undefined;
  /** The texts the shaping checks ran on. */
  readonly samples: readonly KeptScriptSample[];
}

type OutputProgress =
  | { readonly status: "waiting" }
  | { readonly status: "building" }
  | { readonly status: "validating" }
  | { readonly status: "built"; readonly font: BuiltFont }
  /** The message names the problem as the engine reported it. */
  | { readonly status: "failed"; readonly message: string };

export interface OutputRun {
  readonly faceId: FaceId;
  readonly fileName: string;
  readonly progress: OutputProgress;
}

export interface BuildRunDependencies {
  /** Rejects when the browser will not load the font. Left out, that check is not run. */
  readonly browserCheck?: (font: Uint8Array) => Promise<unknown>;
  readonly builder: FontBuilder;
  /** The characters a face's source font maps. */
  readonly charactersOfFace: (faceId: FaceId) => Iterable<number>;
  readonly newId: () => string;
  /** The current time as an ISO 8601 string. */
  readonly now: () => string;
  readonly reader: FontReader;
}

export const derivedOutputs = (resolution: ExportResolution): DerivedOutput[] =>
  resolution.outputs.filter((output) => output.kind === "derived");

/** The characters a build request keeps: its subset, or everything the face has. */
export const keptCharacters = (
  request: BuildRequest,
  sourceCharacters: Iterable<number>
): number[] => [
  ...new Set(
    request.subset?.characters ?? [
      ...sourceCharacters,
      ...request.added.flatMap((glyph) => glyph.characters),
    ]
  ),
];

const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const buildOne = async (
  output: DerivedOutput,
  resolution: ExportResolution,
  dependencies: BuildRunDependencies,
  revisionId: string | undefined,
  report: (progress: OutputProgress) => void
): Promise<void> => {
  const { browserCheck, builder, charactersOfFace, newId, now, reader } =
    dependencies;
  report({ status: "building" });
  // One output at a time through the packaging entry point, which refuses a
  // plan that still has problems.
  const [exported] = await exportFonts(builder, {
    ...resolution,
    outputs: [output],
  });
  if (!exported) {
    throw new Error("The font engine returned no file.");
  }
  report({ status: "validating" });
  const samples = shapingSamples(
    keptCharacters(output.request, charactersOfFace(output.faceId))
  );
  const validation = await validateDerivedFont({
    browserCheck,
    builder,
    derived: exported.bytes,
    reader,
    request: output.request,
    samples: samples.map((entry) => entry.sample),
  });
  report({
    font: {
      builtAt: now(),
      bytes: exported.bytes,
      faceId: output.faceId,
      fileName: exported.fileName,
      id: newId(),
      notes: exported.notes,
      report: validation,
      request: output.request,
      revisionId,
      samples,
    },
    status: "built",
  });
};

/**
 * Runs every derived output of a resolution. `revisionId` is the head
 * revision of the project the resolution was made from, kept with each font.
 * `onChange` gets the whole list again after each step, so a screen can show
 * exactly where the run stands.
 */
export const runBuilds = async (
  resolution: ExportResolution,
  dependencies: BuildRunDependencies,
  revisionId: string | undefined,
  onChange: (outputs: readonly OutputRun[]) => void
): Promise<readonly OutputRun[]> => {
  let outputs: readonly OutputRun[] = derivedOutputs(resolution).map(
    (output) => ({
      faceId: output.faceId,
      fileName: output.fileName,
      progress: { status: "waiting" },
    })
  );
  onChange(outputs);
  for (const [index, output] of derivedOutputs(resolution).entries()) {
    const report = (progress: OutputProgress) => {
      outputs = outputs.map((existing, position) =>
        position === index ? { ...existing, progress } : existing
      );
      onChange(outputs);
    };
    try {
      await buildOne(output, resolution, dependencies, revisionId, report);
    } catch (error) {
      report({ message: reasonOf(error), status: "failed" });
    }
  }
  return outputs;
};
