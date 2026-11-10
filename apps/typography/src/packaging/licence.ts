/**
 * Reads what a font says about its own licence and decides what that means
 * for an export. Exporting the untouched source file is always allowed; these
 * findings are about derived fonts.
 */
import type { LicenceNotice } from "~/typeface/face";

type LicenceKind = "ofl" | "apache" | "unknown";

export interface LicenceReading {
  readonly kind: LicenceKind;
  /** Names the copyright holder reserved. A derived font must not use them. */
  readonly reservedNames: readonly string[];
}

/** What is about to be exported, as far as the licence cares. */
export interface Derivation {
  /** The family name the derived font will carry. */
  readonly familyName: string;
  /** True when characters or features are being removed. */
  readonly subset: boolean;
}

export type LicenceFindingCode =
  | "reserved-font-name"
  | "unknown-licence"
  | "restricted-embedding"
  | "no-subsetting";

export interface LicenceFinding {
  readonly code: LicenceFindingCode;
  readonly message: string;
  /** A blocking finding stops the export until it is resolved. */
  readonly severity: "blocking" | "warning";
}

const OFL =
  /SIL Open Font License|scripts\.sil\.org\/OFL|openfontlicense\.org/i;
const APACHE = /Apache License|apache\.org\/licenses/i;

/**
 * The declaration follows the copyright statement: with Reserved Font Name
 * "Lato". The licence text itself also says "Reserved Font Name", but never
 * after "with", so a font that embeds the whole licence declares nothing.
 */
const RESERVED = /with Reserved Font Names?\s*:?\s*([^.;()]+)/gi;
const QUOTED = /["'“‘]([^"'”’]+)["'”’]/g;
const NAME_SEPARATOR = /\s*,\s*|\s+and\s+|\s*&\s*/i;

/** OS/2 fsType bits. */
const EMBEDDING = {
  bitmapOnly: 0x02_00,
  editable: 0x00_08,
  noSubsetting: 0x01_00,
  previewAndPrint: 0x00_04,
  restricted: 0x00_02,
} as const;

const namesIn = (declaration: string): string[] => {
  const quoted = [...declaration.matchAll(QUOTED)].map((match) => match[1]);
  const names = quoted.length > 0 ? quoted : declaration.split(NAME_SEPARATOR);
  return names
    .map((name) => name?.trim() ?? "")
    .filter((name) => name.length > 0);
};

const reservedNamesIn = (text: string): string[] => {
  const found = new Map<string, string>();
  for (const match of text.matchAll(RESERVED)) {
    for (const name of namesIn(match[1] ?? "")) {
      found.set(name.toLowerCase(), name);
    }
  }
  return [...found.values()];
};

export const readLicence = (notice: LicenceNotice): LicenceReading => {
  const text = [notice.copyright, notice.description, notice.url]
    .filter((part) => part !== undefined)
    .join("\n");
  if (OFL.test(text)) {
    return { kind: "ofl", reservedNames: reservedNamesIn(text) };
  }
  return { kind: APACHE.test(text) ? "apache" : "unknown", reservedNames: [] };
};

/** Compares names the way a reader would: ignoring case, spaces and punctuation. */
const comparable = (name: string) =>
  name.toLowerCase().replaceAll(/[^\p{L}\p{N}]/gu, "");

/** The reserved name a family name contains, if any. */
export const reservedNameIn = (
  reading: LicenceReading,
  familyName: string
): string | undefined =>
  reading.reservedNames.find((reserved) => {
    const needle = comparable(reserved);
    return needle.length > 0 && comparable(familyName).includes(needle);
  });

const embeddingFindings = (
  embedding: number,
  subset: boolean
): LicenceFinding[] => {
  const findings: LicenceFinding[] = [];
  const has = (bit: number) => Math.trunc(embedding / bit) % 2 === 1;
  const limits = [
    has(EMBEDDING.restricted) && "it must not be embedded or shared",
    has(EMBEDDING.previewAndPrint) &&
      "it may be embedded only for viewing and printing",
    has(EMBEDDING.editable) && "it may be embedded only in editable documents",
    has(EMBEDDING.bitmapOnly) && "only its bitmaps may be embedded",
  ].filter((limit) => limit !== false);
  if (limits.length > 0) {
    findings.push({
      code: "restricted-embedding",
      message: `The source font restricts embedding: ${limits.join(", and ")}. Check with the rights holder before sharing a derived font.`,
      severity: "warning",
    });
  }
  if (subset && has(EMBEDDING.noSubsetting)) {
    findings.push({
      code: "no-subsetting",
      message:
        "The source font asks not to be subset. Export every character, or check with the rights holder first.",
      severity: "warning",
    });
  }
  return findings;
};

/** What the source font's licence means for one derived font. */
export const licenceFindings = (
  notice: LicenceNotice,
  derivation: Derivation
): LicenceFinding[] => {
  const reading = readLicence(notice);
  const findings: LicenceFinding[] = [];
  const reserved = reservedNameIn(reading, derivation.familyName);
  if (reserved) {
    findings.push({
      code: "reserved-font-name",
      message: `The Open Font License reserves the name "${reserved}" for the original font. Choose a family name that does not contain it.`,
      severity: "blocking",
    });
  }
  if (reading.kind === "unknown") {
    findings.push({
      code: "unknown-licence",
      message:
        "The source font does not name a licence this app recognises. Check that you have the right to modify and share it before you use the derived font.",
      severity: "warning",
    });
  }
  return [
    ...findings,
    ...embeddingFindings(notice.embedding, derivation.subset),
  ];
};
