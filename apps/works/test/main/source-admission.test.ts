import { expect, it } from "vitest";
import {
  admitSource,
  SOURCE_LIMITS,
  SourceAdmissionError,
  sourceAdmissionProblem,
} from "~/main/modules/source-admission";
import { fakeClient, openFakeVault } from "../helpers/fake-api";

const limits = {
  maxBytes: 12,
  maxFileCodeUnits: 6,
  maxFiles: 3,
  maxPathCharacters: 8,
};

it("counts file length in UTF-16 code units and the total in UTF-8 bytes", () => {
  // Two code units, four UTF-8 bytes each.
  const emoji = "😀";
  expect(sourceAdmissionProblem({ a: emoji.repeat(3) }, limits)).toBeNull();
  expect(sourceAdmissionProblem({ a: emoji.repeat(4) }, limits)).toContain(
    "UTF-16 code units"
  );
  // Within the per-file unit limit, over the aggregate byte limit.
  expect(
    sourceAdmissionProblem({ a: emoji.repeat(2), b: emoji.repeat(2) }, limits)
  ).toContain("UTF-8 bytes");
  expect(sourceAdmissionProblem({ a: "abcdef", b: "abcdef" }, limits)).toBe(
    null
  );
});

it("limits file count, path length and path shape", () => {
  expect(sourceAdmissionProblem({ a: "", b: "", c: "", d: "" }, limits)).toBe(
    "Source has 4 files; the limit is 3."
  );
  expect(sourceAdmissionProblem({ abcdefghi: "" }, limits)).toContain(
    "longer than 8 characters"
  );
  for (const path of ["/abs", "../up", "a//b", "a\\b"]) {
    expect(sourceAdmissionProblem({ [path]: "" }, limits)).toContain(
      "portable relative path"
    );
  }
  expect(() => admitSource({ "../up": "" })).toThrow(SourceAdmissionError);
});

it("uses the recommended starting limits", () => {
  expect(SOURCE_LIMITS).toEqual({
    maxBytes: 16_777_216,
    maxFileCodeUnits: 4_194_304,
    maxFiles: 2048,
    maxPathCharacters: 512,
  });
});

it("applies the same admission at the save boundary", async () => {
  const client = fakeClient(await openFakeVault());
  await expect(
    client.modules.saveSource({
      expected: {
        artifactId: "a",
        contentId: "c",
        updatedAt: new Date().toISOString(),
      },
      id: "m",
      source: { "../escape.ts": "" },
    })
  ).rejects.toThrow();
  await expect(
    client.modules.saveSource({
      expected: {
        artifactId: "a",
        contentId: "c",
        updatedAt: new Date().toISOString(),
      },
      id: "m",
      source: { big: "x".repeat(SOURCE_LIMITS.maxFileCodeUnits + 1) },
    })
  ).rejects.toThrow();
});
