/**
 * Replays a recorded sheet for a script extension plan. The recorded-run
 * strategy names a sheet's cells after the characters they show. A plan
 * names its glyphs itself, and separates some of them from syllables, so the
 * cells are keyed here by the plan and a glyph that will be separated from a
 * syllable on the sheet is not reported as missing from it.
 */
import type { GlyphTarget } from "../plan/target";
import type { SheetCell } from "../sheet/layout";
import type { RecordedRun } from "../strategies/recorded/manifest";
import { recordedRunStrategy } from "../strategies/recorded/recorded-run";
import type { GenerationStrategy } from "../strategies/strategy";
import { cellKeyFor, type ScriptExtensionPlan } from "./plan";

/** The texts a recorded sheet lists, in reading order. */
export const listedCells = ({ manifest, output }: RecordedRun) =>
  output.requested ?? manifest.targets ?? [];

const UNPLANNED = "unplanned:";

/**
 * The listed cells, keyed by the plan. The sheet's layout keeps its row
 * count, so cells past the listed ones are found and set aside as extra.
 */
const plannedCells = (
  run: RecordedRun,
  plan: ScriptExtensionPlan
): SheetCell[] =>
  listedCells(run).map((text, index) => ({
    key: cellKeyFor(plan, text) ?? `${UNPLANNED}${index + 1}`,
    label: text,
  }));

/** A target is drawn when its own cell is on the sheet, or a syllable it is separated from is. */
const isDrawn = (target: GlyphTarget, cells: ReadonlySet<string>) =>
  cells.has(target.key) || target.needs.some((key) => cells.has(key));

export const plannedSheetStrategy = (
  run: RecordedRun,
  plan: ScriptExtensionPlan
): GenerationStrategy => {
  const recorded = recordedRunStrategy(run);
  const cells = plannedCells(run, plan);
  const keys = new Set(cells.map((cell) => cell.key));
  return {
    availability: () => recorded.availability(),
    async generate(request) {
      const output = await recorded.generate(request);
      if (output.raw.kind === "outlines") {
        return output;
      }
      return {
        ...output,
        raw: { ...output.raw, layout: { ...output.raw.layout, cells } },
        unmade: request.targets
          .filter((target) => !isDrawn(target, keys))
          .map((target) => ({
            key: target.key,
            reason: "The recorded sheet has no cell for this glyph.",
          })),
      };
    },
    id: recorded.id,
    kind: recorded.kind,
    name: recorded.name,
  };
};
