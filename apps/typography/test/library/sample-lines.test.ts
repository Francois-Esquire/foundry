import { describe, expect, it } from "vitest";
import { sampleLines } from "~/library/sample-lines";
import { fixtureCoverage } from "./helpers/coverage";

describe("sampleLines", () => {
  it("sets real words for each script a face covers, with their direction", async () => {
    const { coverage } = await fixtureCoverage("arabic");
    const lines = sampleLines(coverage.byScope, coverage.inSource);
    const arabic = lines.find((line) => line.script === "Arab");
    expect(arabic).toMatchObject({
      direction: "rtl",
      language: "ar",
      name: "Arabic",
      words: true,
    });
    expect(lines.find((line) => line.script === "Latn")?.direction).toBe("ltr");
    expect(lines.some((line) => line.script === "Deva")).toBe(false);
  });

  it("uses only characters the Devanagari fixture has for its own words", async () => {
    const { coverage } = await fixtureCoverage("devanagari");
    const line = sampleLines(coverage.byScope, coverage.inSource).find(
      (sample) => sample.script === "Deva"
    );
    expect(line?.words).toBe(true);
    const lacking = [...(line?.text ?? "")].filter(
      (symbol) =>
        symbol !== " " && !coverage.inSource(symbol.codePointAt(0) ?? 0)
    );
    expect(lacking).toEqual([]);
  });

  it("shows a script with no words on file by the characters the face has, and says so", async () => {
    const { coverage } = await fixtureCoverage("lato");
    const coptic = sampleLines(coverage.byScope, coverage.inSource).find(
      (line) => line.script === "Copt"
    );
    expect(coptic?.words).toBe(false);
    expect(coptic?.language).toBeUndefined();
    const shown = (coptic?.text ?? "").split(" ");
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThanOrEqual(16);
    expect(
      shown.every((symbol) => coverage.inSource(symbol.codePointAt(0) ?? 0))
    ).toBe(true);
  });

  it("leaves shared groups out: they are not writing systems", async () => {
    const { coverage } = await fixtureCoverage("lato");
    const names = sampleLines(coverage.byScope, coverage.inSource).map(
      (line) => line.name
    );
    expect(names).not.toContain("Punctuation");
  });
});
