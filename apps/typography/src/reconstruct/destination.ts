/**
 * Where recovered letters go: a new face made for this reconstruction, or an
 * editable face already in the project. Either way they arrive as candidates.
 */
import type { BlankFontRequest } from "~/packaging/building";
import type { FaceId, FaceMetrics } from "~/typeface/face";
import { type RecoveryMetrics, STANDARD_METRICS } from "./core";

export type Destination =
  | { readonly kind: "new"; readonly familyName: string }
  | { readonly kind: "existing"; readonly faceId: FaceId | undefined };

/** The shares of the em a face's lines usually take, for a face that does not declare them. */
const CAP_HEIGHT = 0.7;
const X_HEIGHT = 0.5;

/** The font units a face's own lines sit at, which recovered letters are scaled to. */
export const metricsOf = (metrics: FaceMetrics): RecoveryMetrics => ({
  ascender: metrics.ascender,
  capHeight: metrics.capHeight ?? Math.round(metrics.unitsPerEm * CAP_HEIGHT),
  descender: metrics.descender,
  unitsPerEm: metrics.unitsPerEm,
  xHeight: metrics.xHeight ?? Math.round(metrics.unitsPerEm * X_HEIGHT),
});

/** The empty font a new face is made from. The same name always makes the same file. */
export const blankFontFor = (familyName: string): BlankFontRequest => ({
  familyName: familyName.trim(),
  metrics: { ...STANDARD_METRICS, lineGap: 0 },
  styleName: "Regular",
});

export const blankFileName = (familyName: string) =>
  `${familyName.trim().replaceAll(/[^\p{L}\p{N}]+/gu, "")}-Regular.ttf`;

const EXTENSION = /\.[^.]+$/;
const SEPARATORS = /[-_.\s]+/;

/** A family name suggested from a file name: storefront-needed-things.jpg gives Storefront Needed Things. */
export const familyNameFrom = (fileName: string): string => {
  const words = fileName
    .replace(EXTENSION, "")
    .split(SEPARATORS)
    .filter((word) => word !== "")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`);
  return words.length > 0 ? words.join(" ") : "Reconstruction";
};
