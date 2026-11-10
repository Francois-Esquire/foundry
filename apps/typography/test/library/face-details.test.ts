import { describe, expect, it } from "vitest";
import {
  embeddingPermission,
  formatBytes,
  licenceFacts,
  metricFacts,
  nameFacts,
} from "~/library/face-details";
import { describeFace } from "../helpers/fixtures";

const factValue = (
  facts: readonly { label: string; value: string }[],
  label: string
) => facts.find((fact) => fact.label === label)?.value;

describe("face details", () => {
  it("lists the names a font gives itself and says when one is not stated", () => {
    const facts = nameFacts(describeFace({ designer: "A. Designer" }));
    expect(factValue(facts, "PostScript name")).toBe("Specimen-Regular");
    expect(factValue(facts, "Designer")).toBe("A. Designer");
    expect(factValue(facts, "Version")).toBe("Not stated");
  });

  it("lists vertical metrics in font units", () => {
    const facts = metricFacts({
      ascender: 800,
      capHeight: 700,
      descender: -200,
      lineGap: 0,
      unitsPerEm: 1000,
    });
    expect(factValue(facts, "Descender")).toBe("-200");
    expect(factValue(facts, "Cap height")).toBe("700");
    expect(factValue(facts, "x-height")).toBe("Not stated");
  });

  it("reads the embedding bits into sentences", () => {
    expect(embeddingPermission(0)).toBe(
      "Installable: the font may be embedded and installed."
    );
    expect(embeddingPermission(0x00_02)).toContain("Restricted");
    expect(embeddingPermission(0x00_04)).toContain("Preview and print");
    expect(embeddingPermission(0x01_08)).toBe(
      "Editable: documents may embed the font and still be edited. It must not be subset."
    );
    expect(embeddingPermission(0x02_00)).toContain("Only its bitmaps");
  });

  it("shows the licence notice as written, and says what is absent", () => {
    const facts = licenceFacts({ copyright: "Copyright 2026", embedding: 0 });
    expect(factValue(facts, "Copyright")).toBe("Copyright 2026");
    expect(factValue(facts, "Licence")).toBe("Not stated");
  });

  it("formats file sizes", () => {
    expect(formatBytes(812)).toBe("812 B");
    expect(formatBytes(65_536)).toBe("64 kB");
    expect(formatBytes(1_258_291)).toBe("1.2 MB");
  });
});
