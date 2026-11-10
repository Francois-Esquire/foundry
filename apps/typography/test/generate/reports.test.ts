import { describe, expect, it } from "vitest";
import { estimateCost, formatCost, formatUsd } from "~/generate/cost";
import {
  defectLines,
  formatMeasure,
  formatScore,
  hasAgreement,
} from "~/generate/evaluation-report";
import { provenanceFacts } from "~/generate/provenance-facts";
import type { Evaluation } from "~/generation/evaluation/evaluation";
import type { RunRecord } from "~/generation/pipeline/run";

const evaluation = (overrides: Partial<Evaluation> = {}): Evaluation => ({
  defects: [],
  key: "u+0061",
  madeBy: "Traced.",
  scores: { geometry: 1, style: 1 },
  styleChecks: [],
  verdict: "pass",
  weaknesses: [],
  ...overrides,
});

const record = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  createdAt: "2026-11-10T05:08:03Z",
  finishedAt: "2026-11-10T09:00:01Z",
  notes: [],
  producedBy: "vector-model",
  recorded: true,
  runId: "run#vector-model",
  stages: [],
  startedAt: "2026-11-10T09:00:00Z",
  strategy: { id: "recorded-run:run", kind: "recorded-run", name: "Recorded" },
  unmade: [],
  ...overrides,
});

const factValue = (facts: ReturnType<typeof provenanceFacts>, label: string) =>
  facts.find((fact) => fact.label === label)?.value;

describe("the cost of a model run", () => {
  it("estimates targets by the listed rate", () => {
    const estimate = estimateCost("ideogram/vector/text-to-vector", 6);
    expect(estimate?.usd).toBeCloseTo(0.06);
    expect(estimate?.rate.usdPerUnit).toBe(0.01);
    expect(formatUsd(estimate?.usd ?? 0)).toBe("$0.06");
  });

  it("says what the image model's listing leaves open", () => {
    expect(
      estimateCost("openai/gpt-image-2.6/flare/edit", 1)?.rate.note
    ).toContain("units");
  });

  it("makes no estimate for a model with no listed price", () => {
    expect(estimateCost("someone/else", 3)).toBeUndefined();
  });

  it("never prints an unknown charge as a number", () => {
    expect(formatCost(undefined)).toBe("Not reported by the provider");
    expect(formatCost(0)).toBe("$0.00");
  });
});

describe("the defects of a candidate", () => {
  const spacing = {
    correction: "respace",
    detail: "The left sidebearing is too wide.",
    kind: "spacing",
  } as const;
  const heights = {
    correction: "refit-heights",
    detail: "The top is too high.",
    kind: "heights",
  } as const;
  const shape = { detail: "The shape agrees by 0.62.", kind: "shape" } as const;

  it("marks a defect corrected when its correction was applied and nothing of its kind is left", () => {
    const lines = defectLines(
      evaluation({ defects: [spacing, heights, shape] }),
      evaluation({ defects: [{ ...heights, detail: "Still high." }, shape] }),
      ["refit-heights", "respace"]
    );
    expect(lines).toEqual([
      { detail: spacing.detail, fix: "respaced", state: "corrected" },
      { detail: "Still high.", state: "remaining" },
      { detail: shape.detail, state: "remaining" },
    ]);
  });

  it("calls nothing corrected that refinement did not touch", () => {
    expect(
      defectLines(evaluation({ defects: [spacing] }), evaluation(), [])
    ).toEqual([]);
    expect(
      defectLines(undefined, evaluation({ defects: [shape] }), [])
    ).toEqual([{ detail: shape.detail, state: "remaining" }]);
  });

  it("formats scores and measures in the unit of their check", () => {
    expect(formatScore(0.9149)).toBe("0.91");
    expect(formatMeasure(1433.4, 40)).toBe("1433");
    expect(formatMeasure(-0.2, 40)).toBe("0");
    expect(formatMeasure(4, 40)).toBe("4");
    expect(formatMeasure(0.3123, 0.13)).toBe("0.31");
  });

  it("has an agreement only under a holdout test", () => {
    expect(hasAgreement(evaluation())).toBe(false);
    expect(
      hasAgreement(
        evaluation({ scores: { geometry: 1, shape: 0.9, style: 1 } })
      )
    ).toBe(true);
  });
});

describe("the provenance printed beside a candidate", () => {
  it("calls replayed output a recorded run and prints no charge nobody stated", () => {
    const facts = provenanceFacts(
      {
        createdAt: "2026-11-10T05:08:03Z",
        model: "ideogram/vector/text-to-vector",
        origin: "generated",
        recorded: true,
        runId: "run#vector-model",
        strategy: "vector-model",
      },
      record()
    );
    expect(factValue(facts, "Source")).toBe(
      "Recorded run, replayed. Not live model output"
    );
    expect(factValue(facts, "Strategy")).toBe("Vector model");
    expect(factValue(facts, "Model")).toBe("ideogram/vector/text-to-vector");
    expect(factValue(facts, "Cost")).toBe("Not reported by the provider");
    expect(facts.map((fact) => fact.label)).toContain("Model called");
  });

  it("prints a stated charge, and none for a glyph built by rule", () => {
    const live = {
      createdAt: "2026-11-10T09:00:00Z",
      origin: "generated",
      runId: "run-1",
    } as const;
    expect(
      factValue(
        provenanceFacts(
          { ...live, model: "some/model", strategy: "image-model" },
          record({ costUsd: 0.04, recorded: false })
        ),
        "Cost"
      )
    ).toBe("$0.04");
    const ruled = provenanceFacts(
      { ...live, strategy: "procedural" },
      record({ producedBy: "procedural", recorded: false })
    );
    expect(factValue(ruled, "Source")).toBe("Built by rule on this machine");
    expect(factValue(ruled, "Model")).toBe("None");
    expect(factValue(ruled, "Cost")).toBe("None. No model was called");
  });

  it("has nothing to say about a design that was not generated", () => {
    expect(provenanceFacts({ origin: "manual" }, record())).toEqual([]);
  });
});
