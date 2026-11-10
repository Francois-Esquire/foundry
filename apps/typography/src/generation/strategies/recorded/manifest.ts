/**
 * The recorded-run file format: a `run.json` manifest and the raw files it
 * names, in one directory. One manifest can hold several outputs made from
 * the same request, for example an image model's and a vector model's. See
 * the README in src/generation for the format in prose.
 */
import { sourceGlyph } from "~/typeface/changes";
import type { OpenFace } from "~/typeface/reading";
import { planForm } from "../../plan/plan";
import {
  type GlyphTarget,
  glyphNameFor,
  targetKeyFor,
} from "../../plan/target";
import type { SheetLayout } from "../../sheet/layout";

/** The grid a sheet was asked for. */
interface RecordedLayout {
  /** Where the baseline was asked to sit in a cell, from the top. 0.72 when absent. */
  readonly baseline?: number;
  readonly columns: number;
  /** The share of a cell's height one em was asked to take. 0.62 when absent. */
  readonly emShare?: number;
  /** How many rows the sheet has. Needed when it has more cells than targets. */
  readonly rows?: number;
}

/** One model's answer to the request. */
export interface RecordedOutput {
  /** In US dollars. Null or absent when the provider did not state it. */
  readonly costUsd?: number | null;
  /** The file name of the raw output, beside the manifest. */
  readonly file: string;
  readonly kind: "sheet-image" | "sheet-svg";
  readonly latencySeconds?: number;
  /** Overrides the manifest's layout for this output. */
  readonly layout?: RecordedLayout;
  /** The model as the provider names it. */
  readonly model: string;
  /** Tells outputs of one manifest apart. The strategy when absent. */
  readonly name?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  /** The prompt, or the name of a text file beside the manifest that holds it. */
  readonly prompt?: string;
  readonly promptFile?: string;
  /** Overrides the manifest's targets for this output: the texts drawn, in reading order. */
  readonly requested?: readonly string[];
  /** The provider's own id for the call. */
  readonly requestId?: string;
  readonly strategy: "image-model" | "vector-model";
  /**
   * True for output that no model made, such as a sheet a test rendered.
   * A synthetic output is never attributed to a model.
   */
  readonly synthetic?: boolean;
}

export interface RecordedRunManifest {
  /** When the models were called, as an ISO 8601 time. */
  readonly createdAt: string;
  readonly id: string;
  readonly layout?: RecordedLayout;
  readonly outputs: readonly RecordedOutput[];
  /** The style reference the models were shown: a picture, and its SVG when one was kept. */
  readonly reference?: { readonly file?: string; readonly vector?: string };
  /**
   * The font the style reference was drawn from, by file name. Comparing a
   * candidate with that font's own glyph is a holdout test. Comparing it with
   * any other font is not.
   */
  readonly sourceFont?: { readonly file?: string };
  /** The texts the sheet shows, in reading order, row by row. */
  readonly targets?: readonly string[];
}

/** One output of a manifest, loaded into memory with the files beside it. */
export interface RecordedRun {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly manifest: RecordedRunManifest;
  readonly output: RecordedOutput;
}

export class RecordedRunError extends Error {
  override readonly name = "RecordedRunError";
}

const NOMINAL_CELL = 1000;
const DEFAULT_BASELINE = 0.72;
const DEFAULT_EM_SHARE = 0.62;
const MEDIA_TYPES: Readonly<Record<string, string | undefined>> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTexts = (value: unknown) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((text) => typeof text === "string" && text !== "");

const hasColumns = (layout: unknown) =>
  isObject(layout) &&
  typeof layout.columns === "number" &&
  Number.isInteger(layout.columns) &&
  layout.columns > 0;

const demand = (condition: boolean, problem: string) => {
  if (!condition) {
    throw new RecordedRunError(`The recorded-run manifest ${problem}.`);
  }
};

const checkOutput = (output: unknown, manifest: Json, position: number) => {
  const where = `output ${position + 1}`;
  demand(isObject(output), `lists ${where} that is not an object`);
  const { file, kind, layout, model, requested, strategy } = output as Json;
  demand(typeof file === "string" && file !== "", `names no file for ${where}`);
  demand(
    kind === "sheet-image" || kind === "sheet-svg",
    `gives ${where} no kind (sheet-image or sheet-svg)`
  );
  demand(
    strategy === "image-model" || strategy === "vector-model",
    `gives ${where} no strategy (image-model or vector-model)`
  );
  demand(
    typeof model === "string" && model !== "",
    `names no model for ${where}`
  );
  demand(
    isTexts(requested ?? manifest.targets),
    `lists no targets for ${where}`
  );
  demand(
    hasColumns(layout ?? manifest.layout),
    `gives ${where} no layout with a column count`
  );
};

/** Reads and checks a manifest. Throws `RecordedRunError` saying what is wrong. */
export const parseManifest = (json: string): RecordedRunManifest => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new RecordedRunError("The recorded-run manifest is not valid JSON.", {
      cause,
    });
  }
  demand(isObject(parsed), "is not an object");
  const manifest = parsed as Json;
  demand(typeof manifest.id === "string" && manifest.id !== "", "has no id");
  demand(
    typeof manifest.createdAt === "string" &&
      !Number.isNaN(Date.parse(manifest.createdAt)),
    "has no createdAt time"
  );
  const { outputs } = manifest;
  demand(Array.isArray(outputs) && outputs.length > 0, "lists no outputs");
  for (const [position, output] of (outputs as readonly unknown[]).entries()) {
    checkOutput(output, manifest, position);
  }
  return manifest as unknown as RecordedRunManifest;
};

/** What tells one output of a manifest from another: its name, else its strategy. */
export const outputLabel = (output: RecordedOutput) =>
  output.name ?? output.strategy;

/**
 * Loads every output of a manifest, checking that each sheet file is among
 * the files given. File names are relative to the manifest.
 */
export const loadRecordedRuns = (
  manifestJson: string,
  files: ReadonlyMap<string, Uint8Array>
): RecordedRun[] => {
  const manifest = parseManifest(manifestJson);
  return manifest.outputs.map((output) => {
    if (!files.has(output.file)) {
      throw new RecordedRunError(
        `The recorded run names ${output.file}, which is not among its files.`
      );
    }
    return { files, manifest, output };
  });
};

/** The id a replay carries in provenance: the manifest's id and the output's label. */
export const recordedRunId = ({ manifest, output }: RecordedRun) =>
  `${manifest.id}#${outputLabel(output)}`;

export const recordedMediaType = (output: RecordedOutput): string => {
  const extension = output.file.slice(output.file.lastIndexOf(".") + 1);
  return MEDIA_TYPES[extension.toLowerCase()] ?? "application/octet-stream";
};

const formName = (text: string) =>
  [...text].map((part) => glyphNameFor(part.codePointAt(0) ?? 0)).join("_");

const targetFor = (text: string, face: OpenFace): GlyphTarget => {
  const characters = [...text.normalize("NFC")];
  const [only] = characters;
  if (characters.length !== 1 || only === undefined) {
    return planForm(text, formName(text));
  }
  const character = only.codePointAt(0) ?? 0;
  const glyphId = face.glyphForCharacter(character);
  return {
    characters: [character],
    key: targetKeyFor(character),
    name: glyphNameFor(character),
    needs: [],
    replaces: glyphId === undefined ? undefined : sourceGlyph(glyphId),
    text: only,
  };
};

/**
 * The targets a recorded output drew, for a given face. A character the face
 * already has becomes a redrawing of that glyph, which is also what makes a
 * holdout comparison possible. A text of several characters is one form.
 */
export const recordedTargets = (
  { manifest, output }: RecordedRun,
  face: OpenFace
): GlyphTarget[] =>
  (output.requested ?? manifest.targets ?? []).map((text) =>
    targetFor(text, face)
  );

/** The grid the recorded sheet was asked for, as a hint for extraction. */
export const recordedLayout = (
  { manifest, output }: RecordedRun,
  targets: readonly GlyphTarget[]
): SheetLayout => {
  const layout = output.layout ?? manifest.layout;
  return {
    baseline: layout?.baseline ?? DEFAULT_BASELINE,
    cellHeight: NOMINAL_CELL,
    cells: targets.map((target) => ({ key: target.key, label: target.text })),
    cellWidth: NOMINAL_CELL,
    columns: layout?.columns ?? Math.max(1, targets.length),
    emSize: NOMINAL_CELL * (layout?.emShare ?? DEFAULT_EM_SHARE),
    rows: layout?.rows,
  };
};
