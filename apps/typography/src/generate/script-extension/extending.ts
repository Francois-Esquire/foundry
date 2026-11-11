/**
 * Extending a face into another script from a recorded run: finding the
 * run's sheets among a source's recorded runs, and making the extension
 * from them. The script extension's session and the generate command call
 * these, in this order. Nothing here is remembered, and nothing is added to
 * the project: the extension waits, whole, until it is added.
 */
import type { ImageCodec } from "~/generation/raster/image-codec";
import {
  extendScript,
  type ScriptExtension,
} from "~/generation/script-extension/extend";
import type { ScriptExtensionPlan } from "~/generation/script-extension/plan";
import {
  listedCells,
  plannedSheetStrategy,
} from "~/generation/script-extension/planned-sheet";
import {
  listRecorded,
  loadRecorded,
  type RecordedEntry,
} from "~/generation/strategies/recorded/catalogue";
import type { RecordedRun } from "~/generation/strategies/recorded/manifest";
import type { RecordedRunSource } from "~/generation/strategies/recorded/source";
import type { GenerationStrategy } from "~/generation/strategies/strategy";
import { Refusal } from "~/lib/refusal";
import type { FaceId } from "~/typeface/face";
import { findFace } from "~/typeface/project";
import type { Workspace } from "~/workspace/workspace";
import { faceStanding } from "./face-standing";
import type { ExtensionOffering } from "./offering";

/** What an extension is made with. */
export interface ExtensionMeans {
  /** Says when each sheet's run started and ended. */
  readonly clock: () => Date;
  readonly codec: Pick<ImageCodec, "decode">;
  readonly newId: () => string;
  /** The recorded runs the offering's run is found among. */
  readonly runs: RecordedRunSource;
  readonly workspace: Workspace;
}

/** A script extension made for a face, waiting to be added to it whole. */
export interface ExtensionRun {
  readonly extension: ScriptExtension;
  /**
   * Names the run while it waits. It is issued here, after the sheets' own
   * ids, so a run made on a screen and one made by a command draw the same
   * ids from the application.
   */
  readonly id: string;
}

/**
 * The outputs of the offering's recorded run, one sheet each. Never empty:
 * refuses when the run is not among the source's, with the reason the run
 * could not be read when there is one.
 */
export const offeredSheets = async (
  runs: RecordedRunSource,
  { recordedRun }: ExtensionOffering
): Promise<RecordedEntry[]> => {
  const { entries, problems } = await listRecorded(runs);
  const sheets = entries.filter((entry) => entry.directory === recordedRun);
  if (sheets.length === 0) {
    throw new Refusal(
      problems.find((problem) => problem.startsWith(`${recordedRun}:`)) ??
        `The recorded run ${recordedRun} is not served with this app.`
    );
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
 * Makes the plan's glyphs for a face from the recorded sheets, with their
 * spacing, anchors and layout rules settled. `onSheet` is told which sheet
 * is about to be read, once the sheets are all fetched. Refuses when the
 * extension is not offered for the face, with the face's own reason.
 */
export const extendFace = async (
  faceId: FaceId,
  plan: ScriptExtensionPlan,
  sheets: readonly RecordedEntry[],
  { clock, codec, newId, runs, workspace }: ExtensionMeans,
  onSheet: (sheet: RecordedEntry) => Promise<void> = () => Promise.resolve()
): Promise<ExtensionRun> => {
  const face = workspace.openFace(faceId);
  const standing = faceStanding({
    face: findFace(workspace.getState().project, faceId),
    inSource: (character) => face.glyphForCharacter(character) !== undefined,
    plan,
    working: workspace.workingFace(faceId),
  });
  if (standing.kind === "not-offered") {
    throw new Refusal(standing.reason);
  }
  const loaded: { entry: RecordedEntry; run: RecordedRun }[] = [];
  for (const entry of sheets) {
    loaded.push({ entry, run: await loadRecorded(runs, entry) });
  }
  // The extension reports no progress of its own. Each sheet's strategy is
  // the one place that is reached once per sheet, so a sheet is announced there.
  const extension = await extendScript({
    clock,
    codec,
    face,
    faceId,
    newId,
    plan,
    sheets: loaded.map(({ entry, run }) => ({
      cells: listedCells(run),
      strategy: announced(plannedSheetStrategy(run, plan), () =>
        onSheet(entry)
      ),
    })),
  });
  return { extension, id: newId() };
};
