/** Carries out a resolved export plan: one file per output. */
import { BuildError, type FontBuilder } from "./building";
import type { ExportOutput, ExportResolution } from "./resolving";

export interface ExportedFont {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  /** Notes from the engine. Empty for an original, which is not built. */
  readonly notes: readonly string[];
  readonly output: ExportOutput;
}

/**
 * Builds every derived font and passes originals through untouched. Refuses
 * a resolution that still has problems, so a blocked export cannot be built
 * by accident.
 */
export const exportFonts = async (
  builder: FontBuilder,
  resolution: ExportResolution
): Promise<ExportedFont[]> => {
  const [problem] = resolution.problems;
  if (problem) {
    throw new BuildError(problem.message);
  }
  const exported: ExportedFont[] = [];
  for (const output of resolution.outputs) {
    if (output.kind === "original") {
      exported.push({
        bytes: output.bytes,
        fileName: output.fileName,
        notes: [],
        output,
      });
    } else {
      // One build at a time: the engine is single-threaded, and this keeps the order stable.
      const built = await builder.build(output.request);
      exported.push({
        bytes: built.bytes,
        fileName: output.fileName,
        notes: built.notes,
        output,
      });
    }
  }
  return exported;
};
