/**
 * What a resolver finds before a build runs: problems that block it and
 * warnings worth knowing. The rules about a font's family name and its
 * source's licence are the same whichever resolver asks, so they are here.
 */
import {
  type Face,
  type FaceDescription,
  type FaceId,
  faceStyleName,
} from "~/typeface/face";
import { type LicenceFindingCode, licenceFindings } from "./licence";

export interface Finding<Code extends string> {
  readonly code: Code;
  /** Absent when the finding is about the plan or the masters as a whole. */
  readonly faceId?: FaceId;
  readonly message: string;
}

/** Problems block the build. Warnings do not. */
export interface Findings<Code extends string> {
  readonly problems: Finding<Code>[];
  readonly warnings: Finding<Code>[];
}

/** The codes every resolver can give: they are about the name and the licence. */
export type NameFindingCode =
  | LicenceFindingCode
  | "empty-family-name"
  | "family-name-kept";

/** A face as a message names it. */
export const labelOf = (face: Face) =>
  `${face.description.familyName} ${faceStyleName(face)}`;

/**
 * The family name that was asked for, trimmed. Undefined keeps the source's
 * own. A name of nothing but spaces is a problem, and keeps the source's too.
 */
export const requestedFamilyName = <Code extends string>(
  requested: string | undefined,
  /** Whose name is kept when none is asked for, as the message says it. */
  kept: string,
  findings: Findings<Code | NameFindingCode>
): string | undefined => {
  const familyName = requested?.trim();
  if (requested !== undefined && !familyName) {
    findings.problems.push({
      code: "empty-family-name",
      message: `The family name is empty. Type a name, or keep ${kept}.`,
    });
  }
  return familyName || undefined;
};

/** A font about to be made from a source, as far as its name and licence go. */
interface NamedFont {
  /** The face the findings are filed under, when they are about one face. */
  readonly faceId?: FaceId;
  /** The family name the font will carry. */
  readonly familyName: string;
  /** What a message calls the font. */
  readonly made: "derived" | "rebuilt";
  /**
   * True when the app made the source font itself. Nobody licensed it and its
   * family name is the person's own, so it has no licence to recognise and no
   * original to pass for.
   */
  readonly madeHere?: boolean;
  readonly source: Pick<FaceDescription, "familyName" | "licence">;
  /** True when characters or features are being removed. */
  readonly subset: boolean;
}

/**
 * What the source's licence means for the font, and a warning when the font
 * keeps the source's family name. A font the licence blocks is not also warned
 * about its name: the block already asks for another.
 */
export const checkName = <Code extends string>(
  font: NamedFont,
  findings: Findings<Code | NameFindingCode>
) => {
  const { faceId, familyName, madeHere = false, source } = font;
  const fromLicence = licenceFindings(source.licence, font).filter(
    (found) => !(madeHere && found.code === "unknown-licence")
  );
  for (const { code, message, severity } of fromLicence) {
    const list =
      severity === "blocking" ? findings.problems : findings.warnings;
    list.push({ code, faceId, message });
  }
  if (
    familyName === source.familyName &&
    !madeHere &&
    fromLicence.every((found) => found.severity !== "blocking")
  ) {
    findings.warnings.push({
      code: "family-name-kept",
      faceId,
      message: `The ${font.made} font keeps the family name ${familyName}, so it can pass for the original. Give it a family name of its own.`,
    });
  }
};
