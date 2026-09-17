import { describe, expect, test } from "vitest";

import { generateReadableNameWithSeed } from "../readable-name";

const READABLE_NAME_PATTERN = /^[A-Z][a-z]+ [A-Z][a-z]+$/;

describe("generateReadableName", () => {
  test("creates a deterministic, two-word title-cased label through its test seam", () => {
    const first = generateReadableNameWithSeed("workspace-identity");

    expect(generateReadableNameWithSeed("workspace-identity")).toBe(first);
    expect(first).toMatch(READABLE_NAME_PATTERN);
  });
});
