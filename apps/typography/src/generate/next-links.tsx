import { exportFaceHash } from "~/export/export-address";
import { subjectAddress } from "~/proof/proof-address";
import { type Face, faceStyleName } from "~/typeface/face";
import { ButtonLink } from "~/ui/controls/button";
import { scopeName } from "~/unicode/scope";
import { nextStepsFor } from "./next-steps";

interface NextLinksProps {
  /** The characters of the candidates that are in the face now. */
  readonly accepted: readonly number[];
  readonly face: Face;
}

/**
 * The way on from accepted candidates: Proof with the new characters set as
 * its text, and Export with the face chosen and, when the characters are of
 * one writing system, a subset for it.
 */
export function NextLinks({ accepted, face }: NextLinksProps) {
  const { scope, text } = nextStepsFor(accepted);
  const name = `${face.description.familyName} ${faceStyleName(face)}`;
  return (
    <div className="ty-generate-stack">
      <div className="ty-generate-actions">
        <ButtonLink
          href={subjectAddress({ faceId: face.id, kind: "face" }, text)}
        >
          Prove {name}
        </ButtonLink>
        <ButtonLink href={exportFaceHash(face.id, scope)}>
          {scope
            ? `Plan an export of the ${scopeName(scope)} subset`
            : "Plan an export"}
        </ButtonLink>
      </div>
      <p className="ty-generate-reason">
        Proof builds {name} with every applied change and sets the accepted
        characters in it. Export opens with {name} chosen
        {scope
          ? `, keeping its ${scopeName(scope)} characters and nothing else`
          : ""}
        . Candidates still waiting stay out of both.
      </p>
    </div>
  );
}
