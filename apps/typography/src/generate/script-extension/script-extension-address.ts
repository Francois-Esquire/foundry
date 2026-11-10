/**
 * The script extension's place in the address bar, and what another place
 * needs to offer it: "#/generate/script-extension", which can end in the
 * face it is for.
 */
import type { FaceId } from "~/typeface/face";
import { DEVANAGARI_OFFERING } from "./offering";
import { plannedCharacters, scopeStatement } from "./scope";

const SEGMENT = "script-extension";

export const GENERATE_HASH = "#/generate";

export const SCRIPT_EXTENSION_HASH = `${GENERATE_HASH}/${SEGMENT}`;

/** True when the path below "#/generate" names the script extension. */
export const isScriptExtensionPath = (path: readonly string[]) =>
  path[0] === SEGMENT;

/** The extension as another place may offer it, in the plan's own figures and words. */
export interface ScriptExtensionOffer {
  /** The characters the plan maps. A face that has one in its source font is not offered it. */
  readonly characters: readonly number[];
  /** The extension's address for the face. */
  readonly hash: string;
  /** The scope in one statement: a defined subset, never the script. */
  readonly statement: string;
}

/**
 * The extension on offer for a script, addressed to a face. Undefined for a
 * script no plan is offered for. Whether a face can take it is the
 * extension's own place to say.
 */
export const scriptExtensionOffer = (
  script: string,
  faceId: FaceId
): ScriptExtensionOffer | undefined => {
  const { plan } = DEVANAGARI_OFFERING;
  return plan.iso15924 === script
    ? {
        characters: plannedCharacters(plan),
        hash: `${SCRIPT_EXTENSION_HASH}/${encodeURIComponent(faceId)}`,
        statement: scopeStatement(plan),
      }
    : undefined;
};
