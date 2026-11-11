/**
 * What a model returned, as the files of a recorded run: a `run.json`
 * manifest, the sheet exactly as it came back, the prompt and the reference
 * the model was shown. Kept this way, live output can be replayed later like
 * any recorded run, without calling the model again.
 */
import type { ReviewedRun } from "~/generate/session";
import type {
  RecordedOutput,
  RecordedRunManifest,
} from "~/generation/strategies/recorded/manifest";

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
export const modelOutputFiles = ({
  raw,
  record,
  sent,
  targets,
}: Pick<ReviewedRun, "raw" | "record" | "sent" | "targets">):
  | ReadonlyMap<string, Uint8Array>
  | undefined => {
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
