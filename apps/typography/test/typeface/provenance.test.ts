import { describe, expect, it } from "vitest";
import {
  designFrame,
  designMark,
  type Provenance,
} from "~/typeface/provenance";

const GENERATED: Provenance = {
  createdAt: "2026-11-10T09:00:00.000Z",
  origin: "generated",
  runId: "run-1",
  strategy: "procedural",
};
const OBSERVED: Provenance = {
  basis: "observed",
  evidenceId: "photograph",
  origin: "reconstructed",
};
const INFERRED: Provenance = { ...OBSERVED, basis: "inferred" };

describe("the mark of a design made after the source font", () => {
  it("tells observed lettering from generated and inferred work until it is accepted", () => {
    expect(designMark(OBSERVED, "proposed")).toBe("observed");
    expect(designMark(INFERRED, "proposed")).toBe("unconfirmed");
    expect(designMark(GENERATED, "proposed")).toBe("unconfirmed");
  });

  it("gives accepted work the solid mark of work in the face, whatever made it", () => {
    for (const provenance of [OBSERVED, INFERRED, GENERATED]) {
      expect(designMark(provenance, "accepted")).toBe("edited");
    }
  });

  it("treats a design that was never proposed, or was rejected, as not accepted", () => {
    expect(designMark(OBSERVED, undefined)).toBe("observed");
    expect(designMark(OBSERVED, "rejected")).toBe("observed");
    expect(designMark(INFERRED, undefined)).toBe("unconfirmed");
    expect(designMark(GENERATED, "rejected")).toBe("unconfirmed");
  });

  it("marks hand work as an edit wherever it stands", () => {
    expect(designMark({ origin: "manual" }, "proposed")).toBe("edited");
    expect(designMark({ origin: "manual" }, undefined)).toBe("edited");
  });

  it("frames a design by its mark, and gives a rejected one no frame of its own", () => {
    expect(designFrame(OBSERVED, undefined)).toBe("observed");
    expect(designFrame(OBSERVED, "proposed")).toBe("observed");
    expect(designFrame(INFERRED, "proposed")).toBe("unconfirmed");
    expect(designFrame(GENERATED, "accepted")).toBe("edited");
    for (const provenance of [OBSERVED, INFERRED, GENERATED]) {
      expect(designFrame(provenance, "rejected")).toBe("none");
    }
  });
});
