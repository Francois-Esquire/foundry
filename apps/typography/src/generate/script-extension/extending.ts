/**
 * Extending a face into another script from a recorded run: finding the
 * run's sheets among a source's recorded runs, making the extension from
 * them, and holding it in the project as a run. The script extension's
 * session and the generate command call these, in this order. Nothing here
 * is remembered, and nothing enters a face: the run waits in the project,
 * whole, until it is accepted.
 */
import { keepRunOutput, type OutputMeans } from "~/generation/model-output";
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
import { findFace, type HeldRun } from "~/typeface/project";
import type { Workspace } from "~/workspace/workspace";
import { faceStanding } from "./face-standing";
import type { ExtensionOffering } from "./offering";

/** What an extension is made and held with. */
export interface ExtensionMeans extends OutputMeans {
  /** Says when each sheet's run started and ended. */
  readonly clock: () => Date;
  readonly codec: Pick<ImageCodec, "decode">;
  readonly newId: () => string;
  readonly workspace: Workspace;
}

/** The sheets of one recorded run, one for each of its outputs. There is always a first. */
export type Sheets = readonly [RecordedEntry, ...RecordedEntry[]];

/**
 * The outputs of the offering's recorded run, one sheet each. Refuses when
 * the run is not among the source's, with the reason the run could not be
 * read when there is one.
 */
export const offeredSheets = async (
  runs: RecordedRunSource,
  { recordedRun }: ExtensionOffering
): Promise<Sheets> => {
  const { entries, problems } = await listRecorded(runs);
  const [first, ...rest] = entries.filter(
    (entry) => entry.directory === recordedRun
  );
  if (!first) {
    throw new Refusal(
      problems.find((problem) => problem.startsWith(`${recordedRun}:`)) ??
        `The recorded run ${recordedRun} is not served with this app.`
    );
  }
  return [first, ...rest];
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
  sheets: Sheets,
  {
    clock,
    codec,
    newId,
    runs,
    workspace,
  }: Pick<ExtensionMeans, "clock" | "codec" | "newId" | "runs" | "workspace">,
  onSheet: (sheet: RecordedEntry) => Promise<void> = () => Promise.resolve()
): Promise<ScriptExtension> => {
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
  return extendScript({
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
};

/**
 * Holds an extension made for a face as a run of the project, and answers
 * with the run. What the model returned is kept first, because the run names
 * the artifact it is in, and the run reaches the project as one change after
 * that. So a run that is interrupted leaves nothing half done: at worst its
 * model output is kept with nothing naming it. Refuses with the project's
 * reason when the project will not hold the run.
 */
export const holdExtension = async (
  made: {
    readonly extension: ScriptExtension;
    readonly faceId: FaceId;
    readonly plan: ScriptExtensionPlan;
    /** The sheets the extension was made from. */
    readonly sheets: Sheets;
  },
  means: Pick<
    ExtensionMeans,
    "keepModelOutput" | "newId" | "runs" | "workspace"
  >
): Promise<HeldRun> => {
  const { extension, faceId, plan, sheets } = made;
  const modelOutput = await keepRunOutput({ recorded: sheets[0] }, means);
  const run: HeldRun = {
    changes: extension.changes,
    faceId,
    glyphs: extension.glyphs.length,
    modelOutput,
    // Issued after the sheets' own ids, wherever the run is made, so a
    // screen's run and a command's draw the same ids from the application.
    runId: means.newId(),
    script: plan.script,
  };
  const held = means.workspace.holdRun(run);
  if (!held.ok) {
    throw new Refusal(held.notice.message);
  }
  return run;
};
