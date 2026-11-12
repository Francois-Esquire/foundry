/**
 * The Export place's addresses, so a choice made in another place is not
 * made again here. "#/export/face/<face>" plans that face whole,
 * "#/export/face/<face>/<writing system>" plans a subset of it for one
 * writing system, and "#/export/instances/<variable face>" plans every
 * pinned instance of a variable face. The writing system is written as
 * Coverage writes it: Latn, or shared.digits.
 */
import { scopeKey, scopeOfKey } from "~/explorer/coverage-address";
import type { FaceId } from "~/typeface/face";
import type { Scope } from "~/unicode/scope";

export type ExportAddress =
  | {
      readonly kind: "face";
      readonly faceId: FaceId;
      /** The writing system to keep. Absent to keep every character. */
      readonly scope?: Scope;
      /** A writing system the address names and Unicode does not have. */
      readonly unknownScope?: string;
    }
  | {
      readonly kind: "instances";
      /** The variable face whose pinned instances are planned. */
      readonly faceId: FaceId;
    };

/** The Export place without a plan carried in its address. */
export const EXPORT_ADDRESS = "#/export";

/** The address that plans a face, whole or as a subset for one writing system. */
export const exportFaceHash = (faceId: FaceId, scope?: Scope) =>
  [
    EXPORT_ADDRESS,
    "face",
    encodeURIComponent(faceId),
    ...(scope ? [encodeURIComponent(scopeKey(scope))] : []),
  ].join("/");

/** The address that plans every pinned instance of a variable face. */
export const exportInstancesHash = (faceId: FaceId) =>
  `${EXPORT_ADDRESS}/instances/${encodeURIComponent(faceId)}`;

/** Reads the path below "#/export". A bare path, or one that names no kind, asks for nothing. */
export const readExportPath = (
  path: readonly string[]
): ExportAddress | undefined => {
  const [kind, faceId, named] = path;
  if (faceId === undefined) {
    return;
  }
  if (kind === "instances") {
    return { faceId, kind };
  }
  if (kind !== "face") {
    return;
  }
  const scope = named === undefined ? undefined : scopeOfKey(named);
  return {
    faceId,
    kind,
    scope,
    unknownScope: named !== undefined && !scope ? named : undefined,
  };
};
