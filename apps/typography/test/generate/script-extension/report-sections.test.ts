import { describe, expect, it } from "vitest";
import { listUnder } from "~/generate/script-extension/report-sections";

const REPORT = [
  "# Verification",
  "",
  "## Verified",
  "",
  "### Words: 1 of 1",
  "",
  "- one (ok)",
  "",
  "## Not verified",
  "",
  "- Anything not listed above.",
  "- Style. The reference tells letters apart.",
  "",
  "## Notes",
  "",
  "- A note.",
  "",
].join("\n");

describe("reading a list out of the verification report", () => {
  it("takes the items under the heading and stops at the next heading", () => {
    expect(listUnder(REPORT, "Not verified")).toEqual([
      "Anything not listed above.",
      "Style. The reference tells letters apart.",
    ]);
  });

  it("stops at a deeper heading too", () => {
    expect(listUnder(REPORT, "Verified")).toEqual([]);
  });

  it("takes the last section to the end of the report", () => {
    expect(listUnder(REPORT, "Notes")).toEqual(["A note."]);
  });

  it("gives nothing for a heading the report does not have", () => {
    expect(listUnder(REPORT, "Height model")).toEqual([]);
  });
});
