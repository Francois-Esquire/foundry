import { describe, expect, it } from "vitest";

import {
  admitModuleSource,
  MODULE_SOURCE_LIMITS,
  ModuleSourceAdmissionError,
  moduleSourceAdmissionProblem,
} from "../source";

const limits = {
  maxBytes: 12,
  maxFileCodeUnits: 6,
  maxFiles: 3,
  maxPathCharacters: 8,
};

describe("Module source admission", () => {
  it("counts file length in UTF-16 code units and the total in UTF-8 bytes", () => {
    // Two code units, four UTF-8 bytes each.
    const emoji = "😀";
    expect(
      moduleSourceAdmissionProblem({ a: emoji.repeat(3) }, limits)
    ).toBeNull();
    expect(
      moduleSourceAdmissionProblem({ a: emoji.repeat(4) }, limits)
    ).toContain("UTF-16 code units");
    // Within the per-file unit limit, over the aggregate byte limit.
    expect(
      moduleSourceAdmissionProblem(
        { a: emoji.repeat(2), b: emoji.repeat(2) },
        limits
      )
    ).toContain("UTF-8 bytes");
    expect(
      moduleSourceAdmissionProblem({ a: "abcdef", b: "abcdef" }, limits)
    ).toBeNull();
  });

  it("limits file count, path length and path shape", () => {
    expect(
      moduleSourceAdmissionProblem({ a: "", b: "", c: "", d: "" }, limits)
    ).toBe("Source has 4 files; the limit is 3.");
    expect(moduleSourceAdmissionProblem({ abcdefghi: "" }, limits)).toContain(
      "longer than 8 characters"
    );
    for (const path of ["/abs", "../up", "a//b", "a\\b"]) {
      expect(moduleSourceAdmissionProblem({ [path]: "" }, limits)).toContain(
        "portable relative path"
      );
    }
    expect(() => admitModuleSource({ "../up": "" })).toThrow(
      ModuleSourceAdmissionError
    );
  });

  it("keeps the host ceilings when given limits above them", () => {
    const above = { ...MODULE_SOURCE_LIMITS, maxPathCharacters: 10_000 };
    const path = "a".repeat(MODULE_SOURCE_LIMITS.maxPathCharacters + 1);
    expect(moduleSourceAdmissionProblem({ [path]: "" }, above)).toContain(
      `longer than ${MODULE_SOURCE_LIMITS.maxPathCharacters} characters`
    );
  });

  it("defaults to the authoring.source.* host ceilings", () => {
    expect(MODULE_SOURCE_LIMITS).toEqual({
      maxBytes: 16_777_216,
      maxFileCodeUnits: 4_194_304,
      maxFiles: 2048,
      maxPathCharacters: 512,
    });
  });
});
