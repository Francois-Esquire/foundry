import { describe, expect, it } from "vitest";
import { faceTotals, languageCoverage } from "~/explorer/statistics";
import { languages } from "~/unicode/languages";
import { fixtureCoverage } from "../library/helpers/coverage";

describe("faceTotals", () => {
  it("counts every character of an untouched face as from the source", async () => {
    const { coverage, faceId, workspace } = await fixtureCoverage("lato");
    const totals = faceTotals(coverage.classification);
    expect(totals.covered).toBe(
      workspace.openFace(faceId).description.characterCount
    );
    expect(totals.counts).toEqual({
      added: 0,
      candidate: 0,
      edited: 0,
      missing: 0,
      source: totals.covered,
    });
  });
});

describe("languageCoverage", () => {
  it("lists the languages whose required characters are all present, by script", async () => {
    const { coverage } = await fixtureCoverage("lato");
    const supported = languageCoverage(await languages(), coverage.has);
    const latin = supported.byScript.find((group) => group.script === "Latin");
    expect(supported.byScript[0]?.script).toBe("Latin");
    expect(latin?.languages).toContain("English");
    expect(latin?.languages).toEqual(
      [...(latin?.languages ?? [])].sort((a, b) => a.localeCompare(b, "en"))
    );
    expect(
      supported.byScript.some((group) => group.script === "Devanagari")
    ).toBe(false);
    expect(supported.complete).toBe(
      supported.byScript.reduce((sum, group) => sum + group.languages.length, 0)
    );
    expect(supported.complete).toBeLessThan(supported.known);
  });

  it("finds Hindi complete in the Devanagari fixture and nothing in an empty face", async () => {
    const all = await languages();
    const { coverage } = await fixtureCoverage("devanagari");
    const devanagari = languageCoverage(all, coverage.has).byScript.find(
      (group) => group.script === "Devanagari"
    );
    expect(devanagari?.languages).toContain("Hindi");
    expect(languageCoverage(all, () => false)).toMatchObject({
      byScript: [],
      complete: 0,
    });
  });
});
