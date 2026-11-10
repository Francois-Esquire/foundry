/**
 * The recorded run behind a script extension: finding its outputs among the
 * recorded runs served with the app, and loading them as the sheets the
 * extension is replayed from.
 */
import type { ExtensionSheet } from "~/generation/script-extension/extend";
import type { ScriptExtensionPlan } from "~/generation/script-extension/plan";
import {
  listedCells,
  plannedSheetStrategy,
} from "~/generation/script-extension/planned-sheet";
import {
  outputLabel,
  type RecordedRun,
  recordedRunId,
} from "~/generation/strategies/recorded/manifest";
import type { GenerationStrategy } from "~/generation/strategies/strategy";
import {
  type Fetch,
  loadRecordedEntry,
  type RecordedCatalogue,
  type RecordedEntry,
} from "../recorded-catalogue";
import type { ExtensionOffering } from "./offering";

/** The outputs of the offering's recorded run: one sheet each. */
export const entriesFor = (
  catalogue: RecordedCatalogue,
  { recordedRun }: ExtensionOffering
): RecordedEntry[] =>
  catalogue.entries.filter((entry) => entry.directory === recordedRun);

/** Why the offering's run is not among the listed ones. */
export const absenceReason = (
  catalogue: RecordedCatalogue,
  { recordedRun }: ExtensionOffering
): string =>
  catalogue.problems.find((problem) => problem.startsWith(`${recordedRun}:`)) ??
  `The recorded run ${recordedRun} is not served with this app.`;

/** A sheet as loaded for replay, with the id its glyphs carry in provenance. */
export interface LoadedSheet {
  /** What tells the sheet from the run's others, for example "letters". */
  readonly label: string;
  readonly run: RecordedRun;
  readonly runId: string;
}

export const loadSheets = async (
  fetcher: Fetch,
  base: string,
  entries: readonly RecordedEntry[]
): Promise<LoadedSheet[]> => {
  const sheets: LoadedSheet[] = [];
  for (const entry of entries) {
    const run = await loadRecordedEntry(fetcher, base, entry);
    sheets.push({
      label: outputLabel(run.output),
      run,
      runId: recordedRunId(run),
    });
  }
  return sheets;
};

/** The same strategy, saying which sheet it is about to read before it reads it. */
const announced = (
  strategy: GenerationStrategy,
  announce: () => Promise<void>
): GenerationStrategy => ({
  availability: () => strategy.availability(),
  async generate(request) {
    await announce();
    return strategy.generate(request);
  },
  id: strategy.id,
  kind: strategy.kind,
  name: strategy.name,
});

/**
 * The sheets as `extendScript` takes them. The extension reports no
 * progress of its own; each sheet's strategy is the one place that is
 * reached once per sheet, so that is where a sheet is announced.
 */
export const extensionSheets = (
  sheets: readonly LoadedSheet[],
  plan: ScriptExtensionPlan,
  onSheet: (sheet: LoadedSheet) => Promise<void>
): ExtensionSheet[] =>
  sheets.map((sheet) => ({
    cells: listedCells(sheet.run),
    strategy: announced(plannedSheetStrategy(sheet.run, plan), () =>
      onSheet(sheet)
    ),
  }));
