import { generateHash } from "~/generate/generate-address";
import { scriptExtensionOffer } from "~/generate/script-extension/script-extension-address";
import type { FaceCoverage } from "~/library/face-coverage";
import type { Face } from "~/typeface/face";
import { faceName } from "~/typeface/face";
import { ButtonLink } from "~/ui/controls/button";
import { Notice } from "~/ui/controls/notice";
import { type Scope, scopeName } from "~/unicode/scope";
import { extensionStanding } from "./offers";

interface ScopeOffersProps {
  readonly coverage: FaceCoverage;
  readonly face: Face;
  /** How many characters of the writing system the face lacks and no candidate offers. */
  readonly missing: number;
  readonly scope: Scope;
}

/**
 * What can be done about the gaps on screen, each a link that carries the
 * face and the writing system: a script extension when one is on offer for
 * this script, stated as the defined subset it is, and generating what the
 * face lacks.
 */
export function ScopeOffers({
  coverage,
  face,
  missing,
  scope,
}: ScopeOffersProps) {
  const name = scopeName(scope);
  const label = faceName(face);
  const offer =
    scope.kind === "script"
      ? scriptExtensionOffer(scope.code, face.id)
      : undefined;
  const standing = offer
    ? extensionStanding(
        face,
        offer.characters,
        coverage.classification.classify
      )
    : undefined;
  return (
    <>
      {offer && standing && standing.kind !== "not-offered" ? (
        <Notice
          action={
            <ButtonLink href={offer.hash}>Open the script extension</ButtonLink>
          }
        >
          {standing.kind === "added"
            ? `${standing.held} of the ${offer.characters.length} characters of a defined ${name} subset are in ${label}. `
            : `A script extension is on offer for ${label}: a defined ${name} subset, added whole with the layout rules its glyphs need. `}
          {offer.statement}
        </Notice>
      ) : null}
      {missing > 0 ? (
        <p className="ty-coverage-offer">
          <span>
            {label} lacks {missing} of the characters of {name}.
          </span>
          <ButtonLink href={generateHash(face.id, scope)}>
            Generate what is missing
          </ButtonLink>
        </p>
      ) : null}
    </>
  );
}
