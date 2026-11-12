import { beforeAll, describe, expect, it } from "vitest";
import { scopeKey } from "~/explorer/coverage-address";
import {
  compositionRows,
  leadingScript,
  standingOf,
} from "~/library/composition";
import type { ScopeCoverage } from "~/unicode/coverage";
import { type Language, languages } from "~/unicode/languages";
import { fixtureCoverage } from "./helpers/coverage";

let all: readonly Language[];

beforeAll(async () => {
  all = await languages();
});

const rowFor = (
  covered: number,
  total: number,
  candidate = 0
): ScopeCoverage => ({
  counts: {
    added: 0,
    candidate,
    edited: 0,
    missing: total - covered - candidate,
    source: covered,
  },
  covered,
  name: "Devanagari",
  percent: (covered / total) * 100,
  scope: { code: "Deva", kind: "script" },
  total,
});

describe("standingOf", () => {
  const nothing = () => false;

  it("is missing when the face has none of the script", () => {
    expect(standingOf(rowFor(0, 164), [], nothing)).toEqual({
      kind: "missing",
    });
  });

  it("counts candidates when they are all the script has", () => {
    expect(standingOf(rowFor(0, 164, 8), [], nothing)).toEqual({
      count: 8,
      kind: "candidates",
    });
  });

  it("gives three dots only for every character of the script", () => {
    expect(standingOf(rowFor(164, 164), [], nothing)).toEqual({
      kind: "level",
      level: 3,
    });
  });

  it("gives two dots when one language of the script is complete, else one", () => {
    const hindi = all.find((language) => language.tag === "hi");
    if (!hindi) {
      throw new Error("The language data should include Hindi.");
    }
    const required = new Set(hindi.required);
    expect(
      standingOf(rowFor(100, 164), all, (codePoint) => required.has(codePoint))
    ).toEqual({ kind: "level", level: 2 });
    expect(standingOf(rowFor(100, 164), all, nothing)).toEqual({
      kind: "level",
      level: 1,
    });
  });
});

describe("compositionRows", () => {
  it("lists the six featured scripts first, even where a face has nothing", async () => {
    const { coverage } = await fixtureCoverage("lato");
    const rows = compositionRows(coverage.byScope, all, coverage.has);
    expect(rows.slice(0, 6).map((row) => row.name)).toEqual([
      "Latin",
      "Greek",
      "Cyrillic",
      "Arabic",
      "Hebrew",
      "Devanagari",
    ]);
    const devanagari = rows.find((row) => row.name === "Devanagari");
    expect(devanagari).toMatchObject({
      covered: 0,
      percent: 0,
      standing: { kind: "missing" },
      total: 164,
    });
    expect(devanagari?.counts.missing).toBe(164);
    expect(rows.find((row) => row.name === "Latin")?.standing).toEqual({
      kind: "level",
      level: 2,
    });
  });

  it("puts other scripts before the shared groups, and names each row once", async () => {
    const { coverage } = await fixtureCoverage("lato");
    const rows = compositionRows(coverage.byScope, all, coverage.has);
    const kinds = rows.slice(6).map((row) => row.scope.kind);
    expect(kinds.lastIndexOf("script")).toBeLessThan(kinds.indexOf("shared"));
    expect(new Set(rows.map((row) => scopeKey(row.scope))).size).toBe(
      rows.length
    );
  });

  it("finds every Devanagari character in the Devanagari fixture", async () => {
    const { coverage } = await fixtureCoverage("devanagari");
    const rows = compositionRows(coverage.byScope, all, coverage.has);
    expect(rows.find((row) => row.name === "Devanagari")).toMatchObject({
      covered: 164,
      standing: { kind: "level", level: 3 },
      total: 164,
    });
  });
});

describe("leadingScript", () => {
  it("picks the script a face is mostly about", async () => {
    const lato = await fixtureCoverage("lato");
    const devanagari = await fixtureCoverage("devanagari");
    expect(leadingScript(lato.coverage.byScope)).toEqual({
      code: "Latn",
      kind: "script",
    });
    expect(leadingScript(devanagari.coverage.byScope)).toEqual({
      code: "Deva",
      kind: "script",
    });
    expect(leadingScript([])).toBeUndefined();
  });
});
