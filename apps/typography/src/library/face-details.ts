/** A face's metadata as labelled facts, ready for a title block or a table. */
import type {
  FaceDescription,
  FaceMetrics,
  LicenceNotice,
  OutlineFormat,
} from "~/typeface/face";

export interface Fact {
  readonly label: string;
  readonly value: string;
}

const NOT_STATED = "Not stated";

const OUTLINE_FORMATS: Readonly<Record<OutlineFormat, string>> = {
  cff: "PostScript (CFF), cubic curves",
  cff2: "PostScript (CFF2), cubic curves",
  none: "No outlines",
  truetype: "TrueType, quadratic curves",
};

export const outlineFormatLabel = (format: OutlineFormat) =>
  OUTLINE_FORMATS[format];

export const nameFacts = (description: FaceDescription): Fact[] => [
  { label: "Family", value: description.familyName },
  { label: "Style", value: description.styleName },
  { label: "Full name", value: description.fullName },
  { label: "PostScript name", value: description.postScriptName },
  { label: "Version", value: description.version ?? NOT_STATED },
  { label: "Designer", value: description.designer ?? NOT_STATED },
];

const units = (value: number | undefined) =>
  value === undefined ? NOT_STATED : String(value);

/** Vertical metrics from the top of the line down, in font units. */
export const metricFacts = (metrics: FaceMetrics): Fact[] => [
  { label: "Units per em", value: String(metrics.unitsPerEm) },
  { label: "Ascender", value: String(metrics.ascender) },
  { label: "Cap height", value: units(metrics.capHeight) },
  { label: "x-height", value: units(metrics.xHeight) },
  { label: "Descender", value: String(metrics.descender) },
  { label: "Line gap", value: String(metrics.lineGap) },
];

/** OS/2 fsType bits. */
const EMBEDDING = {
  bitmapOnly: 0x02_00,
  editable: 0x00_08,
  noSubsetting: 0x01_00,
  previewAndPrint: 0x00_04,
  restricted: 0x00_02,
} as const;

/** Reads one flag out of the bit field. */
const hasFlag = (embedding: number, flag: number) =>
  Math.floor(embedding / flag) % 2 === 1;

const embeddingLevel = (embedding: number) => {
  if (hasFlag(embedding, EMBEDDING.restricted)) {
    return "Restricted: the font must not be embedded, changed or shared without the owner's permission.";
  }
  if (hasFlag(embedding, EMBEDDING.previewAndPrint)) {
    return "Preview and print: documents may embed the font for reading and printing only.";
  }
  if (hasFlag(embedding, EMBEDDING.editable)) {
    return "Editable: documents may embed the font and still be edited.";
  }
  return "Installable: the font may be embedded and installed.";
};

/** What the font's embedding bits allow, in sentences. */
export const embeddingPermission = (embedding: number): string =>
  [
    embeddingLevel(embedding),
    hasFlag(embedding, EMBEDDING.noSubsetting) && "It must not be subset.",
    hasFlag(embedding, EMBEDDING.bitmapOnly) &&
      "Only its bitmaps may be embedded, not its outlines.",
  ]
    .filter((sentence) => typeof sentence === "string")
    .join(" ");

/** The licence notice as the font states it. Nothing is added or guessed. */
export const licenceFacts = (licence: LicenceNotice): Fact[] => [
  { label: "Copyright", value: licence.copyright ?? NOT_STATED },
  { label: "Licence", value: licence.description ?? NOT_STATED },
  { label: "Licence address", value: licence.url ?? NOT_STATED },
  { label: "Embedding", value: embeddingPermission(licence.embedding) },
];

const KILOBYTE = 1024;

/** A file size for a list: 812 B, 64 kB, 1.2 MB. */
export const formatBytes = (bytes: number): string => {
  if (bytes < KILOBYTE) {
    return `${bytes} B`;
  }
  const kilobytes = bytes / KILOBYTE;
  return kilobytes < KILOBYTE
    ? `${Math.round(kilobytes)} kB`
    : `${(kilobytes / KILOBYTE).toFixed(1)} MB`;
};
