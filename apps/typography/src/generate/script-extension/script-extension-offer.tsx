import type { Face } from "~/typeface/face";
import { ButtonLink } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { scopeStatement } from "./scope";
import { SCRIPT_EXTENSION_HASH } from "./script-extension-address";
import {
  useFaceStanding,
  useScriptExtensionSession,
} from "./use-script-extension";

interface ScriptExtensionOfferProps {
  readonly face: Face;
}

/**
 * The line in the Generate place that says a script extension is on offer
 * for the face, with its scope, and leads to it. Absent for a face the
 * extension is not offered for.
 */
export function ScriptExtensionOffer({ face }: ScriptExtensionOfferProps) {
  const session = useScriptExtensionSession();
  const standing = useFaceStanding(session, face);
  const { plan } = session.offering;
  const name = face.description.fullName;
  if (standing.kind === "not-offered") {
    return null;
  }
  return (
    <Notice
      action={
        <ButtonLink href={SCRIPT_EXTENSION_HASH}>
          Open the script extension
        </ButtonLink>
      }
    >
      {standing.kind === "in-face"
        ? `The ${plan.script} subset is in ${name} as one revision. ${scopeStatement(plan)}`
        : `A script extension is on offer for ${name}: a ${plan.script} subset, added whole with the layout rules its glyphs need. ${scopeStatement(plan)}`}
    </Notice>
  );
}
