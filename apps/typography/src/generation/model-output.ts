/**
 * What a model returned for a run, kept as the files of a recorded run: a
 * `run.json` manifest, the sheet exactly as it came back, the prompt and the
 * reference the model was shown. Kept this way, live output can be replayed
 * later like any recorded run, without calling the model again, and a replay
 * keeps the very files it replayed. A screen's session and a command keep it
 * through the one operation here, so the same run leaves the same artifact
 * whichever of them made it.
 */
import type { GenerationRun } from "./pipeline/run";
import type { GlyphTarget } from "./plan/target";
import {
  type RecordedEntry,
  recordedFiles,
} from "./strategies/recorded/catalogue";
import type {
  RecordedOutput,
  RecordedRunManifest,
} from "./strategies/recorded/manifest";
import type { RecordedRunSource } from "./strategies/recorded/source";

/** What model output is kept with. */
export interface OutputMeans {
  /**
   * Keeps a recorded run's files, frozen, under the run's name, and answers
   * with the artifact. The same files are kept once.
   */
  readonly keepModelOutput: (
    name: string,
    files: ReadonlyMap<string, Uint8Array>
  ) => Promise<string>;
  /** Where a replayed run's files are read from. */
  readonly runs: RecordedRunSource;
}

const MANIFEST_FILE = "run.json";
const PROMPT_FILE = "prompt.txt";
const REFERENCE_FILE = "reference.svg";
const MILLISECONDS = 1000;

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const encode = (text: string) => new TextEncoder().encode(text);

/**
 * The files of a live run's model output. Nothing when no model made the
 * run's glyphs: a procedural run has no output to keep.
 */
const liveOutputFiles = (
  {
    artefacts: { raw, sent },
    record,
  }: Pick<GenerationRun, "artefacts" | "record">,
  targets: readonly GlyphTarget[]
): ReadonlyMap<string, Uint8Array> | undefined => {
  const { kind: strategy } = record.strategy;
  if (
    raw.kind === "outlines" ||
    !(strategy === "image-model" || strategy === "vector-model")
  ) {
    return;
  }
  const sheet =
    raw.kind === "sheet-svg"
      ? { bytes: encode(raw.svg), file: "sheet.svg" }
      : {
          bytes: raw.image.bytes,
          file: `sheet.${EXTENSIONS[raw.image.mediaType] ?? "png"}`,
        };
  const { layout } = raw;
  const output: RecordedOutput = {
    costUsd: record.costUsd ?? null,
    file: sheet.file,
    kind: raw.kind,
    latencySeconds:
      record.modelLatencyMs === undefined
        ? undefined
        : record.modelLatencyMs / MILLISECONDS,
    model: record.model ?? strategy,
    parameters: sent?.parameters,
    promptFile: sent ? PROMPT_FILE : undefined,
    strategy,
  };
  const texts = new Map(targets.map((target) => [target.key, target.text]));
  const manifest: RecordedRunManifest = {
    createdAt: record.createdAt,
    id: record.runId,
    layout: {
      baseline: layout.baseline,
      columns: layout.columns,
      emShare: layout.emSize / layout.cellHeight,
      rows: layout.rows,
    },
    outputs: [output],
    reference: sent?.referenceSheet ? { vector: REFERENCE_FILE } : undefined,
    targets: layout.cells.map((cell) => texts.get(cell.key) ?? cell.label),
  };
  const files = new Map<string, Uint8Array>([
    [MANIFEST_FILE, encode(JSON.stringify(manifest, null, 2))],
    [sheet.file, sheet.bytes],
  ]);
  if (sent) {
    files.set(PROMPT_FILE, encode(sent.prompt));
  }
  if (sent?.referenceSheet) {
    files.set(REFERENCE_FILE, encode(sent.referenceSheet));
  }
  return files;
};

/** A run that replayed a recorded run, named by the output it replayed. */
interface Replayed {
  readonly recorded: RecordedEntry;
}

/** A run made now, with the targets it was asked for. */
interface Live {
  readonly run: Pick<GenerationRun, "artefacts" | "record">;
  readonly targets: readonly GlyphTarget[];
}

/**
 * Keeps what a model returned for a run and answers with its artifact. A
 * replay keeps the recorded run it replayed, every file its manifest names.
 * A live run keeps what came back. Nothing is kept, and nothing answered,
 * when no model made the run's glyphs.
 */
export async function keepRunOutput(
  made: Replayed,
  means: OutputMeans
): Promise<string>;
export async function keepRunOutput(
  made: Live | Replayed,
  means: OutputMeans
): Promise<string | undefined>;
export async function keepRunOutput(
  made: Live | Replayed,
  { keepModelOutput, runs }: OutputMeans
): Promise<string | undefined> {
  if ("recorded" in made) {
    return keepModelOutput(
      made.recorded.directory,
      await recordedFiles(runs, made.recorded)
    );
  }
  const files = liveOutputFiles(made.run, made.targets);
  return files && keepModelOutput(made.run.record.runId, files);
}
