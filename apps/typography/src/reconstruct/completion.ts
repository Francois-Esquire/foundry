import type {
  RecordedCatalogue,
  RecordedEntry,
} from "~/generation/strategies/recorded/catalogue";
import type {
  Availability,
  StrategyKind,
} from "~/generation/strategies/strategy";

export const ORDER: readonly StrategyKind[] = [
  "procedural",
  "recorded-run",
  "vector-model",
  "image-model",
];

export const SUMMARIES: Readonly<Record<StrategyKind, string>> = {
  "image-model":
    "Sends a sheet of the observed letters to an image model on fal and traces the picture it returns. A paid call, made with your key.",
  procedural:
    "Builds letters by rule from the observed ones, on this machine. It can put an accent on a letter it has. It cannot draw a letter the photograph does not show.",
  "recorded-run":
    "Replays real model output that was saved for a photograph. No model is called, and every letter is labelled as recorded.",
  "vector-model":
    "Puts a sheet of the observed letters on fal's storage, asking for it to be removed after an hour, and asks a vector model on fal to follow it. The model answers in SVG. A paid call, made with your key.",
};

/**
 * The runs of a catalogue that were made to complete a reconstruction: the
 * ones that say which photograph the model was shown. Runs made from a font
 * belong to the Generate place.
 */
export const photographRuns = (
  catalogue: RecordedCatalogue
): RecordedCatalogue => ({
  entries: catalogue.entries.filter(
    (entry) => entry.evidenceFile !== undefined
  ),
  problems: catalogue.problems,
});

/** How an entry reads in a list: the run and the model that made it. */
export const recordedLabel = ({ directory, output }: RecordedEntry) =>
  `${directory}: ${output.synthetic ? "synthetic sheet, no model" : output.model}`;

/**
 * Whether a recorded run answers for a photograph. A run was made by showing
 * a model one photograph, so it completes that photograph's lettering and no
 * other's. Photographs are told apart by file name: the run records no digest.
 */
export const recordedAvailability = (
  entry: RecordedEntry | undefined,
  evidenceFileName: string
): Availability => {
  if (!entry) {
    return {
      available: false,
      reason: "No recorded run was made for a photograph.",
    };
  }
  return entry.evidenceFile === evidenceFileName
    ? { available: true }
    : {
        available: false,
        reason: `This run was recorded for ${entry.evidenceFile}, not for ${evidenceFileName}. Its letters follow that photograph's lettering.`,
      };
};
