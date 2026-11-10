import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEVANAGARI_SUBSET } from "~/generation/script-extension/devanagari-subset";
import type { ExtensionSheet } from "~/generation/script-extension/extend";
import {
  listedCells,
  plannedSheetStrategy,
} from "~/generation/script-extension/planned-sheet";
import {
  loadRecordedRuns,
  type RecordedRun,
} from "~/generation/strategies/recorded/manifest";
import type { Outline } from "~/typeface/outline";

/** Real model output: a sheet of letters and a sheet of syllables. */
export const SUBSET_RUN_DIR = path.join(
  import.meta.dirname,
  "../../../fixtures/generation/2026-11-10-devanagari-subset"
);

export const subsetRunFiles = (): Map<string, Uint8Array> =>
  new Map(
    readdirSync(SUBSET_RUN_DIR).map((file) => [
      file,
      new Uint8Array(readFileSync(path.join(SUBSET_RUN_DIR, file))),
    ])
  );

export const subsetManifest = () =>
  readFileSync(path.join(SUBSET_RUN_DIR, "run.json"), "utf8");

export const loadSubsetRuns = (): RecordedRun[] =>
  loadRecordedRuns(subsetManifest(), subsetRunFiles());

export const sheetsOf = (runs: readonly RecordedRun[]): ExtensionSheet[] =>
  runs.map((run) => ({
    cells: listedCells(run),
    strategy: plannedSheetStrategy(run, DEVANAGARI_SUBSET),
  }));

/** An upright rectangle, as one contour. */
export const rectangle = (
  left: number,
  bottom: number,
  right: number,
  top: number
): Outline["contours"][number] => ({
  segments: [
    { kind: "line", to: { x: right, y: bottom } },
    { kind: "line", to: { x: right, y: top } },
    { kind: "line", to: { x: left, y: top } },
  ],
  start: { x: left, y: bottom },
});
