import { describe, expect, it } from "vitest";

import { atmosphereStrength } from "../../src/web/atmosphere";

describe("overview atmosphere", () => {
  it("stays rich at overview and fades continuously before file detail", () => {
    expect(atmosphereStrength(0.65)).toBe(1);
    expect(atmosphereStrength(0.8)).toBe(1);
    expect(atmosphereStrength(1.8)).toBeCloseTo(0.5);
    expect(atmosphereStrength(2.8)).toBe(0);
    expect(atmosphereStrength(12)).toBe(0);
  });
});
