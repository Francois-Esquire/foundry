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
import { pictureTypeFor } from "../../raster/media-types";
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
  /** The photograph a completion was made for, by file name. A note. */
  readonly evidence?: { readonly file?: string };
  readonly id: string;
  readonly layout?: RecordedLayout;
  readonly outputs: readonly RecordedOutput[];
  /** What the run was made for, in its maker's words. A note. */
  readonly purpose?: string;
  /** The style reference the models were shown: a picture, and its SVG when one was kept. */
  readonly reference?: { readonly file?: string; readonly vector?: string };
  /**
   * The font the style reference was drawn from, by file name. Comparing a
   * candidate with that font's own glyph is a holdout test. Comparing it with
   * any other font is not. Its family and style are notes.
   */
  readonly sourceFont?: {
    readonly family?: string;
    readonly file?: string;
    readonly style?: string;
  };
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

type Json = Readonly<Record<string, unknown>>;

/** Every field of a shape, each one given, so none is read without a check. */
type Every<Shape> = { readonly [Key in keyof Required<Shape>]: Shape[Key] };

const demand: (condition: boolean, problem: string) => asserts condition = (
  condition,
  problem
) => {
  if (!condition) {
    throw new RecordedRunError(`The recorded-run manifest ${problem}.`);
  }
};

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isText = (value: unknown): value is string =>
  isString(value) && value !== "";

const isNumber = (value: unknown): value is number => typeof value === "number";

/** Null is the provider not stating a cost, which the format allows. */
const isCost = (value: unknown): value is number | null =>
  value === null || isNumber(value);

const isBoolean = (value: unknown): value is boolean =>
  typeof value === "boolean";

const isStrings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(isString);

const isTexts = (value: unknown): value is readonly string[] =>
  isStrings(value) && value.length > 0 && value.every(isText);

const hasColumns = (layout: unknown): layout is Json & { columns: number } =>
  isObject(layout) &&
  isNumber(layout.columns) &&
  Number.isInteger(layout.columns) &&
  layout.columns > 0;

/**
 * Reads the optional fields of one object in the manifest. A field is absent
 * or it is what the format says: anything else is refused, never guessed at.
 */
const fieldsOf =
  (holder: Json, where: string) =>
  <Value>(
    key: string,
    is: (value: unknown) => value is Value,
    what: string
  ): Value | undefined => {
    const value = holder[key];
    if (value === undefined) {
      return;
    }
    demand(
      is(value),
      `gives ${where} "${key}" as something other than ${what}`
    );
    return value;
  };

const parseLayout = (layout: unknown, where: string): RecordedLayout => {
  demand(hasColumns(layout), `gives ${where} no layout with a column count`);
  const field = fieldsOf(layout, `the layout of ${where}`);
  const checked: Every<RecordedLayout> = {
    baseline: field("baseline", isNumber, "a number"),
    columns: layout.columns,
    emShare: field("emShare", isNumber, "a number"),
    rows: field("rows", isNumber, "a number"),
  };
  return { ...layout, ...checked };
};

/** The style reference the run names, each of its files text when it is there. */
const parseReference = (reference: Json | undefined) => {
  if (!reference) {
    return;
  }
  const field = fieldsOf(reference, "the reference");
  const checked: Every<NonNullable<RecordedRunManifest["reference"]>> = {
    file: field("file", isString, "text"),
    vector: field("vector", isString, "text"),
  };
  return { ...reference, ...checked };
};

/**
 * A note is text, or it is left out. Replay reads no note, so one that is
 * not text is no reason to refuse the run.
 */
const noteOf = (value: unknown): string | undefined =>
  isText(value) ? value : undefined;

const parseSourceFont = (sourceFont: Json | undefined) => {
  if (!sourceFont) {
    return;
  }
  const field = fieldsOf(sourceFont, "the source font");
  const checked: Every<NonNullable<RecordedRunManifest["sourceFont"]>> = {
    family: noteOf(sourceFont.family),
    file: field("file", isString, "text"),
    style: noteOf(sourceFont.style),
  };
  return { ...sourceFont, ...checked };
};

const parseEvidence = (evidence: unknown) =>
  isObject(evidence) ? { ...evidence, file: noteOf(evidence.file) } : undefined;

const parseOutput = (
  output: unknown,
  manifest: Json,
  position: number
): RecordedOutput => {
  const where = `output ${position + 1}`;
  demand(isObject(output), `lists ${where} that is not an object`);
  const { file, kind, layout, model, strategy } = output;
  demand(isText(file), `names no file for ${where}`);
  demand(
    kind === "sheet-image" || kind === "sheet-svg",
    `gives ${where} no kind (sheet-image or sheet-svg)`
  );
  demand(
    strategy === "image-model" || strategy === "vector-model",
    `gives ${where} no strategy (image-model or vector-model)`
  );
  demand(isText(model), `names no model for ${where}`);
  demand(
    isTexts(output.requested ?? manifest.targets),
    `lists no targets for ${where}`
  );
  demand(
    hasColumns(layout ?? manifest.layout),
    `gives ${where} no layout with a column count`
  );
  const field = fieldsOf(output, where);
  const checked: Every<RecordedOutput> = {
    costUsd: field("costUsd", isCost, "a number or null"),
    file,
    kind,
    latencySeconds: field("latencySeconds", isNumber, "a number"),
    layout: layout === undefined ? undefined : parseLayout(layout, where),
    model,
    name: field("name", isString, "text"),
    parameters: field("parameters", isObject, "an object"),
    prompt: field("prompt", isString, "text"),
    promptFile: field("promptFile", isString, "text"),
    requested: field("requested", isTexts, "a list of texts"),
    requestId: field("requestId", isString, "text"),
    strategy,
    synthetic: field("synthetic", isBoolean, "true or false"),
  };
  return { ...output, ...checked };
};

/**
 * Reads and checks a manifest: every field the format names is what the
 * format says, and the fields it does not name are kept as the notes they
 * are. Throws `RecordedRunError` saying what is wrong.
 */
export const parseManifest = (json: string): RecordedRunManifest => {
  let manifest: unknown;
  try {
    manifest = JSON.parse(json);
  } catch (cause) {
    throw new RecordedRunError("The recorded-run manifest is not valid JSON.", {
      cause,
    });
  }
  demand(isObject(manifest), "is not an object");
  const { createdAt, id, layout, outputs } = manifest;
  demand(isText(id), "has no id");
  demand(
    isString(createdAt) && !Number.isNaN(Date.parse(createdAt)),
    "has no createdAt time"
  );
  demand(Array.isArray(outputs) && outputs.length > 0, "lists no outputs");
  // The outputs first, so a run with no usable layout or targets is refused
  // in the words of the output that needed them.
  const parsed = outputs.map((output: unknown, position) =>
    parseOutput(output, manifest, position)
  );
  const field = fieldsOf(manifest, "the run");
  const checked: Every<RecordedRunManifest> = {
    createdAt,
    evidence: parseEvidence(manifest.evidence),
    id,
    layout: layout === undefined ? undefined : parseLayout(layout, "the run"),
    outputs: parsed,
    purpose: noteOf(manifest.purpose),
    reference: parseReference(field("reference", isObject, "an object")),
    sourceFont: parseSourceFont(field("sourceFont", isObject, "an object")),
    targets: field("targets", isStrings, "a list of texts"),
  };
  return { ...manifest, ...checked };
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
export const recordedRunId = ({
  manifest,
  output,
}: Pick<RecordedRun, "manifest" | "output">) =>
  `${manifest.id}#${outputLabel(output)}`;

export const recordedMediaType = (output: RecordedOutput): string =>
  pictureTypeFor(output.file);

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
