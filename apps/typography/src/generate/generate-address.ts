/**
 * The Generate place's addresses, so a choice made in another place is not
 * made again here. "#/generate/<face>" opens it on that face, and
 * "#/generate/<face>/<writing system>" also asks for the characters the face
 * lacks in that writing system. The script extension's own address,
 * "#/generate/script-extension", can name its face the same way. The writing
 * system is written as Coverage writes it: Latn, or shared.digits.
 */
import { scopeKey, scopeOfKey } from "~/explorer/coverage-address";
import type { FaceId } from "~/typeface/face";
import type { Scope } from "~/unicode/scope";
import {
  GENERATE_HASH,
  isScriptExtensionPath,
} from "./script-extension/script-extension-address";

export interface GenerateAddress {
  /** The face to work on. Absent when the address names none. */
  readonly faceId?: FaceId;
  /** The writing system whose missing characters are asked for. */
  readonly scope?: Scope;
  /** A writing system the address names and Unicode does not have. */
  readonly unknownScope?: string;
}

/** The address that opens Generate on a face, with what it lacks in a writing system when one is given. */
export const generateHash = (faceId: FaceId, scope?: Scope) =>
  [
    GENERATE_HASH,
    encodeURIComponent(faceId),
    ...(scope ? [encodeURIComponent(scopeKey(scope))] : []),
  ].join("/");

/** Reads the path below "#/generate". A bare path asks for nothing. */
export const readGeneratePath = (path: readonly string[]): GenerateAddress => {
  const [faceId, named] = isScriptExtensionPath(path) ? path.slice(1) : path;
  const scope = named === undefined ? undefined : scopeOfKey(named);
  return {
    faceId,
    scope,
    unknownScope: named !== undefined && !scope ? named : undefined,
  };
};
