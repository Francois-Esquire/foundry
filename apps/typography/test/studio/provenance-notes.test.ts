import { describe, expect, it } from "vitest";
import { candidateMark } from "~/studio/provenance-notes";
import type { Provenance } from "~/typeface/provenance";

const generated: Provenance = {
  createdAt: "2026-11-10T09:00:00.000Z",
  origin: "generated",
  runId: "run-1",
  strategy: "procedural",
};

describe("the mark of a candidate, in words", () => {
  const observed: Provenance = {
    basis: "observed",
    evidenceId: "e",
    origin: "reconstructed",
  };

  it("marks an observed candidate apart from a generated or inferred one", () => {
    expect(candidateMark(observed, "proposed")).toEqual({
      kind: "observed",
      text: "Observed in the evidence, not accepted",
    });
    expect(candidateMark(generated, "proposed")).toEqual({
      kind: "unconfirmed",
      text: "Generated, not accepted",
    });
    expect(
      candidateMark({ ...observed, basis: "inferred" }, "proposed")
    ).toEqual({ kind: "unconfirmed", text: "Inferred, not accepted" });
  });

  it("gives accepted work the solid mark and still says where it came from", () => {
    expect(candidateMark(observed, "accepted")).toEqual({
      kind: "edited",
      text: "Observed in the evidence, accepted",
    });
    expect(candidateMark(generated, "accepted")).toEqual({
      kind: "edited",
      text: "Generated, accepted",
    });
  });
});
