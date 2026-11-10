import type { ReactNode } from "react";
import type { Face } from "~/typeface/face";
import { isScriptExtensionPath } from "./script-extension-address";
import { ScriptExtensionOffer } from "./script-extension-offer";
import { ScriptExtensionPlace } from "./script-extension-place";

interface ScriptExtensionRouteProps {
  /** The Generate place itself, shown when the address does not name the extension. */
  readonly children: ReactNode;
  readonly face: Face;
  /** The address segments below "#/generate". */
  readonly path: readonly string[];
}

/**
 * Where the script extension joins the Generate place: its own screen at
 * "#/generate/script-extension", and otherwise the line that offers it,
 * above the place.
 */
export function ScriptExtensionRoute({
  children,
  face,
  path,
}: ScriptExtensionRouteProps) {
  return isScriptExtensionPath(path) ? (
    <ScriptExtensionPlace face={face} key={face.id} />
  ) : (
    <>
      <ScriptExtensionOffer face={face} />
      {children}
    </>
  );
}
