import { describe, expect, it } from "vitest";
import {
  cellStateOf,
  drawsWorkingOutline,
  statusMarkOf,
} from "~/explorer/character-status";

describe("character status", () => {
  it("frames work in the face solid and a candidate dotted", () => {
    expect(cellStateOf("source")).toBe("source");
    expect(cellStateOf("edited")).toBe("edited");
    expect(cellStateOf("added")).toBe("edited");
    expect(cellStateOf("candidate")).toBe("candidate");
    expect(cellStateOf("missing")).toBe("missing");
  });

  const OBSERVED = {
    basis: "observed",
    evidenceId: "photograph",
    origin: "reconstructed",
  } as const;
  const INFERRED = { ...OBSERVED, basis: "inferred" } as const;
  const GENERATED = {
    createdAt: "2026-11-10T09:00:00.000Z",
    origin: "generated",
    runId: "run",
    strategy: "procedural",
  } as const;

  it("frames an observed candidate in brackets and an inferred or generated one dotted", () => {
    expect(cellStateOf("candidate", OBSERVED)).toBe("observed");
    expect(cellStateOf("candidate", INFERRED)).toBe("candidate");
    expect(cellStateOf("candidate", GENERATED)).toBe("candidate");
    // Accepted, both are work in the face.
    expect(cellStateOf("added", OBSERVED)).toBe("edited");
    expect(cellStateOf("added", INFERRED)).toBe("edited");
  });

  it("marks an observed candidate apart from an inferred one, in kind and in words", () => {
    const observed = statusMarkOf("candidate", OBSERVED);
    const inferred = statusMarkOf("candidate", INFERRED);
    expect(observed.kind).toBe("observed");
    expect(observed.text).toContain("Observed in the evidence, not accepted");
    expect(inferred.kind).toBe("unconfirmed");
    expect(inferred.text).toContain("Inferred, not accepted");
    expect(statusMarkOf("candidate", GENERATED).text).toContain(
      "Generated, not accepted"
    );
  });

  it("says what accepted work was, beside the solid mark of work in the face", () => {
    expect(statusMarkOf("added", OBSERVED)).toEqual({
      kind: "edited",
      text: "Observed in the evidence, accepted into the face",
    });
    expect(statusMarkOf("added", GENERATED).text).toBe(
      "Generated, accepted into the face"
    );
    expect(statusMarkOf("edited", INFERRED).text).toBe(
      "In the source font, redrawn since by an accepted inferred design"
    );
    expect(statusMarkOf("edited", { origin: "manual" }).text).toBe(
      "In the source font, edited since"
    );
    expect(statusMarkOf("edited").text).toBe(
      "In the source font, edited since"
    );
  });

  it("draws the working outline for anything made after the source", () => {
    expect(drawsWorkingOutline("source")).toBe(false);
    expect(drawsWorkingOutline("missing")).toBe(false);
    expect(drawsWorkingOutline("edited")).toBe(true);
    expect(drawsWorkingOutline("added")).toBe(true);
    expect(drawsWorkingOutline("candidate")).toBe(true);
  });

  it("picks the mark that matches the status", () => {
    expect(statusMarkOf("source").kind).toBe("source");
    expect(statusMarkOf("added").kind).toBe("edited");
    expect(statusMarkOf("candidate").kind).toBe("unconfirmed");
    expect(statusMarkOf("candidate").text).toContain("not accepted");
    expect(statusMarkOf("missing").kind).toBe("missing");
  });
});
