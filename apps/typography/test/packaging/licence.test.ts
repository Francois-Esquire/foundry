import { describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import {
  licenceFindings,
  readLicence,
  reservedNameIn,
} from "~/packaging/licence";
import type { LicenceNotice } from "~/typeface/face";
import { type FONTS, fontBytes } from "../helpers/fixtures";
import { expectPlainSentences } from "./helpers/messages";

const noticeOf = (name: keyof typeof FONTS): LicenceNotice =>
  harfBuzzReader.open(fontBytes(name)).description.licence;

const OFL_NOTICE =
  "This Font Software is licensed under the SIL Open Font License, Version 1.1.";

const ofl = (copyright: string): LicenceNotice => ({
  copyright,
  description: OFL_NOTICE,
  embedding: 0,
});

describe("reading a licence", () => {
  it("finds the Open Font License and the name Lato reserves", () => {
    expect(readLicence(noticeOf("lato"))).toEqual({
      kind: "ofl",
      reservedNames: ["Lato"],
    });
  });

  it("finds the name Source Code Pro reserves, written in single quotes", () => {
    expect(readLicence(noticeOf("postscript"))).toEqual({
      kind: "ofl",
      reservedNames: ["Source"],
    });
  });

  it("finds the Open Font License without a reserved name in the Noto and Sofia fixtures", () => {
    for (const name of ["sofia", "devanagari", "arabic"] as const) {
      expect(readLicence(noticeOf(name))).toEqual({
        kind: "ofl",
        reservedNames: [],
      });
    }
  });

  it("recognises the Open Font License from its address alone", () => {
    expect(
      readLicence({ embedding: 0, url: "https://openfontlicense.org" }).kind
    ).toBe("ofl");
  });

  it("recognises the Apache License", () => {
    expect(
      readLicence({
        description: "Licensed under the Apache License, Version 2.0",
        embedding: 0,
        url: "http://www.apache.org/licenses/LICENSE-2.0",
      })
    ).toEqual({ kind: "apache", reservedNames: [] });
  });

  it("calls anything else unknown", () => {
    expect(readLicence({ embedding: 0 }).kind).toBe("unknown");
    expect(
      readLicence({
        copyright: "Copyright 2020 Example Type. All rights reserved.",
        description: "This font may be used on up to five computers.",
        embedding: 0,
      }).kind
    ).toBe("unknown");
  });

  it("reads reserved names however the notice writes them", () => {
    const namesIn = (copyright: string) =>
      readLicence(ofl(copyright)).reservedNames;
    expect(
      namesIn("Copyright 2010 Example, with Reserved Font Name Source.")
    ).toEqual(["Source"]);
    expect(
      namesIn(
        'Copyright (c) 2012 Example (example.com), with Reserved Font Names "Fira Sans" and "Fira Mono".'
      )
    ).toEqual(["Fira Sans", "Fira Mono"]);
    expect(
      namesIn(
        "Copyright 2015 Example with Reserved Font Names Alpha, Beta and Gamma."
      )
    ).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(
      namesIn("Copyright 2011 Example with reserved font name 'Quill'")
    ).toEqual(["Quill"]);
  });

  it("does not take the licence's own wording for a declaration", () => {
    const notice: LicenceNotice = {
      copyright: "Copyright 2019 The Example Project Authors",
      description: `${OFL_NOTICE} "Reserved Font Name" refers to any names specified as such after the copyright statement(s). No Modified Version of the Font Software may use the Reserved Font Name(s) unless explicit written permission is granted by the corresponding Copyright Holder.`,
      embedding: 0,
    };
    expect(readLicence(notice)).toEqual({ kind: "ofl", reservedNames: [] });
  });

  it("ignores a reserved name outside the Open Font License", () => {
    expect(
      readLicence({
        copyright: "Copyright 2001 Example with Reserved Font Name Solo.",
        embedding: 0,
      })
    ).toEqual({ kind: "unknown", reservedNames: [] });
  });
});

describe("a family name against the reserved names", () => {
  const lato = readLicence(noticeOf("lato"));

  it("finds the reserved name anywhere in the family name", () => {
    expect(reservedNameIn(lato, "Lato")).toBe("Lato");
    expect(reservedNameIn(lato, "Lato Derived")).toBe("Lato");
    expect(reservedNameIn(lato, "My LATO Subset")).toBe("Lato");
    expect(reservedNameIn(lato, "Newlato")).toBe("Lato");
  });

  it("is not fooled by spaces or punctuation", () => {
    const fira = readLicence(
      ofl('Copyright 2012 Example with Reserved Font Name "Fira Sans".')
    );
    expect(reservedNameIn(fira, "FiraSans Web")).toBe("Fira Sans");
    expect(reservedNameIn(fira, "Fira-Sans")).toBe("Fira Sans");
    expect(reservedNameIn(fira, "Fira Serif")).toBeUndefined();
  });

  it("accepts a name without the reserved name", () => {
    expect(reservedNameIn(lato, "Carlito")).toBeUndefined();
    expect(reservedNameIn(lato, "Atlas Sans")).toBeUndefined();
  });
});

describe("licence findings for a derived font", () => {
  const derived = { familyName: "Atlas Sans", subset: true };

  it("blocks a derived Lato that keeps the name", () => {
    const findings = licenceFindings(noticeOf("lato"), {
      familyName: "Lato Derived",
      subset: false,
    });
    expect(findings).toEqual([
      {
        code: "reserved-font-name",
        message:
          'The Open Font License reserves the name "Lato" for the original font. Choose a family name that does not contain it.',
        severity: "blocking",
      },
    ]);
  });

  it("has nothing to say once the name is gone", () => {
    expect(licenceFindings(noticeOf("lato"), derived)).toEqual([]);
  });

  it("has nothing to say about an Open Font License font without a reserved name", () => {
    expect(
      licenceFindings(noticeOf("sofia"), {
        familyName: "Sofia Sans",
        subset: true,
      })
    ).toEqual([]);
  });

  it("warns when the licence is unknown", () => {
    const findings = licenceFindings({ embedding: 0 }, derived);
    expect(findings.map((finding) => [finding.code, finding.severity])).toEqual(
      [["unknown-licence", "warning"]]
    );
    expect(findings[0]?.message).toContain("Check that you have the right");
  });

  it("warns about restricted embedding bits", () => {
    const restricted = licenceFindings(
      { description: OFL_NOTICE, embedding: 0x00_02 },
      derived
    );
    expect(restricted).toHaveLength(1);
    expect(restricted[0]?.code).toBe("restricted-embedding");
    expect(restricted[0]?.severity).toBe("warning");
    expect(restricted[0]?.message).toContain("must not be embedded or shared");
    const preview = licenceFindings(
      { description: OFL_NOTICE, embedding: 0x00_04 },
      derived
    );
    expect(preview[0]?.message).toContain("only for viewing and printing");
  });

  it("warns about subsetting only when the font is being subset", () => {
    const notice = { description: OFL_NOTICE, embedding: 0x01_00 };
    expect(
      licenceFindings(notice, derived).map((finding) => finding.code)
    ).toEqual(["no-subsetting"]);
    expect(licenceFindings(notice, { ...derived, subset: false })).toEqual([]);
  });

  it("writes messages in plain sentences", () => {
    const all = [
      ...licenceFindings(noticeOf("lato"), {
        familyName: "Lato",
        subset: true,
      }),
      ...licenceFindings({ embedding: 0x03_0e }, derived),
    ];
    expect(all.length).toBeGreaterThan(3);
    expectPlainSentences(all.map((finding) => finding.message));
  });
});
