/**
 * Spec 01 — Step Contract and linear plan. One acceptance row per describe;
 * whole-array `toEqual` where a leaked contract-dependent issue must be caught,
 * exact-string message assertions, and a determinism check.
 */

import { describe, expect, test } from "vitest";

import { LinearPlanSchema, validateLinear } from "../authored";
import {
  articleEntries,
  articlePlan,
  articlePlanWithRenamedInput,
  declaredUnusedPlan,
  duplicatePlacementPlan,
  duplicateRunInputPlan,
  emptyPlan,
  emptyTextSettingPlan,
  forwardPlan,
  IMAGE_UNAVAILABLE_REASON,
  labelPrimacyEntries,
  labelPrimacyPlan,
  notAdmittedPlan,
  nullResultEntries,
  nullResultPlan,
  runMissingRequiredPlan,
  runTypeMismatchPlan,
  selfConnectionPlan,
  threeDefectsPlan,
  unavailableEntries,
  unavailablePlan,
  unknownPlacementPlan,
} from "./fixtures/authored";

// ════════════════════════════════════════════════════════════════════════════
// Executable article plan
// ════════════════════════════════════════════════════════════════════════════

describe("executable article plan", () => {
  test("is executable with no issues despite labels disagreeing with types", () => {
    expect(validateLinear(articlePlan, articleEntries)).toEqual({
      executable: true,
      issues: [],
    });
  });

  test("a declared-but-unused Run-start Input yields no issue", () => {
    expect(validateLinear(declaredUnusedPlan, articleEntries)).toEqual({
      executable: true,
      issues: [],
    });
  });

  test("a required text Input satisfied by an empty setting yields no issue", () => {
    expect(validateLinear(emptyTextSettingPlan, articleEntries)).toEqual({
      executable: true,
      issues: [],
    });
  });

  test("renaming a required Input yields unknown-input and missing-required", () => {
    // Witness from the Step file, asserted by exact string equality.
    expect(validateLinear(articlePlanWithRenamedInput, articleEntries)).toEqual(
      {
        executable: false,
        issues: [
          {
            boundary: "input",
            code: "unknown-input",
            key: "prompt",
            message: "text at write: input prompt is not an input of this Step",
            placement: "write",
            step: "text",
          },
          {
            boundary: "input",
            code: "missing-required",
            key: "instructions",
            message: "text at write: input instructions missing-required",
            placement: "write",
            step: "text",
          },
        ],
      }
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Connection from a result: null Step
// ════════════════════════════════════════════════════════════════════════════

describe("connection from a result: null Step", () => {
  test("no-result addressed to the consuming placement and key", () => {
    expect(validateLinear(nullResultPlan, nullResultEntries)).toEqual({
      executable: false,
      issues: [
        {
          boundary: "connection",
          code: "no-result",
          key: "text",
          message: "text at consume: connection text no-result",
          placement: "consume",
          step: "text",
        },
      ],
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Connection type-mismatch is decided by type, not label
// ════════════════════════════════════════════════════════════════════════════

describe("connection type-mismatch with matching labels", () => {
  test("type-mismatch fires though source Result label equals the Input label", () => {
    const result = validateLinear(labelPrimacyPlan, labelPrimacyEntries);
    expect(result).toEqual({
      executable: false,
      issues: [
        {
          boundary: "connection",
          code: "type-mismatch",
          key: "content",
          message: "document at render: connection content type-mismatch",
          placement: "render",
          step: "document",
        },
      ],
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Forward and self connections
// ════════════════════════════════════════════════════════════════════════════

describe("forward and self connections", () => {
  test("a connection to a later placement is forward-connection only", () => {
    expect(validateLinear(forwardPlan, articleEntries)).toEqual({
      executable: false,
      issues: [
        {
          boundary: "connection",
          code: "forward-connection",
          key: "text",
          message:
            "text at first: connection text must connect to an earlier placement",
          placement: "first",
          step: "text",
        },
      ],
    });
  });

  test("a self-connection is forward-connection", () => {
    expect(validateLinear(selfConnectionPlan, articleEntries)).toEqual({
      executable: false,
      issues: [
        {
          boundary: "connection",
          code: "forward-connection",
          key: "text",
          message:
            "text at loop: connection text must connect to an earlier placement",
          placement: "loop",
          step: "text",
        },
      ],
    });
  });

  test("a connection to a nonexistent placement is unknown-placement", () => {
    expect(validateLinear(unknownPlacementPlan, articleEntries)).toEqual({
      executable: false,
      issues: [
        {
          boundary: "connection",
          code: "unknown-placement",
          key: "text",
          message:
            "text at consume: connection text is not a placement in this plan",
          placement: "consume",
          step: "text",
        },
      ],
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Report all issues, not first-failure
// ════════════════════════════════════════════════════════════════════════════

describe("required unassigned, wrong-type Setting, unknown Input key", () => {
  test("all three issues are reported, each addressed", () => {
    expect(validateLinear(threeDefectsPlan, articleEntries)).toEqual({
      executable: false,
      issues: [
        {
          boundary: "input",
          code: "type-mismatch",
          key: "harness",
          message: "agent at bad: input harness type-mismatch",
          placement: "bad",
          step: "agent",
        },
        {
          boundary: "input",
          code: "unknown-input",
          key: "nonsense",
          message: "agent at bad: input nonsense is not an input of this Step",
          placement: "bad",
          step: "agent",
        },
        {
          boundary: "input",
          code: "missing-required",
          key: "prompt",
          message: "agent at bad: input prompt missing-required",
          placement: "bad",
          step: "agent",
        },
      ],
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Run-start compatibility
// ════════════════════════════════════════════════════════════════════════════

describe("run-start compatibility", () => {
  test("a required Input bound to a wrong-type Run-start Input is type-mismatch", () => {
    expect(validateLinear(runTypeMismatchPlan, articleEntries)).toEqual({
      executable: false,
      issues: [
        {
          boundary: "run-input",
          code: "type-mismatch",
          key: "prompt",
          message: "agent at research: run-input prompt type-mismatch",
          placement: "research",
          step: "agent",
        },
      ],
    });
  });

  test("a required Input bound to an optional Run-start Input names that key", () => {
    expect(validateLinear(runMissingRequiredPlan, articleEntries)).toEqual({
      executable: false,
      issues: [
        {
          boundary: "run-input",
          code: "missing-required",
          key: "prompt",
          message:
            "agent at research: run-input prompt requires an assignment, but Run-start Input topic is optional",
          placement: "research",
          step: "agent",
        },
      ],
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Placement of an unavailable Step
// ════════════════════════════════════════════════════════════════════════════

describe("placement of an unavailable Step", () => {
  test("step-unavailable carries the reason; plan-only issues report; contract issues skip", () => {
    // Whole-array equality: the skipped contract issue (unknown-input for the
    // `bogus` key) must be absent, and the plan-only unknown-run-input present.
    expect(validateLinear(unavailablePlan, unavailableEntries)).toEqual({
      executable: false,
      issues: [
        {
          boundary: "placement",
          code: "step-unavailable",
          message: `image at render: placement ${IMAGE_UNAVAILABLE_REASON}`,
          placement: "render",
          step: "image",
        },
        {
          boundary: "run-input",
          code: "unknown-run-input",
          key: "prompt",
          message:
            "image at render: run-input prompt is not a declared Run-start Input",
          placement: "render",
          step: "image",
        },
      ],
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Placement of an unknown Step key
// ════════════════════════════════════════════════════════════════════════════

describe("placement of an unknown Step key", () => {
  test("step-not-admitted, no throw", () => {
    expect(validateLinear(notAdmittedPlan, articleEntries)).toEqual({
      executable: false,
      issues: [
        {
          boundary: "placement",
          code: "step-not-admitted",
          message: "ghost at solo: placement step-not-admitted",
          placement: "solo",
          step: "ghost",
        },
      ],
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// composition/empty and duplicate-key defense
// ════════════════════════════════════════════════════════════════════════════

describe("composition and duplicate-key rules", () => {
  test("an empty plan is composition/empty", () => {
    expect(validateLinear(emptyPlan, articleEntries)).toEqual({
      executable: false,
      issues: [
        {
          boundary: "composition",
          code: "empty",
          message: "composition a plan must place at least one Step",
        },
      ],
    });
  });

  test("a duplicate placement key is reported and addressed to the key", () => {
    expect(validateLinear(duplicatePlacementPlan, articleEntries)).toEqual({
      executable: false,
      issues: [
        {
          boundary: "placement",
          code: "duplicate-key",
          key: "dup",
          message: "placement dup duplicate-key",
        },
      ],
    });
  });

  test("a duplicate run-input key is reported through validateLinear", () => {
    expect(validateLinear(duplicateRunInputPlan, articleEntries)).toEqual({
      executable: false,
      issues: [
        {
          boundary: "run-input",
          code: "duplicate-key",
          key: "topic",
          message: "run-input topic duplicate-key",
        },
      ],
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Determinism
// ════════════════════════════════════════════════════════════════════════════

describe("determinism", () => {
  test("repeated calls with the same arguments deep-equal", () => {
    expect(validateLinear(articlePlan, articleEntries)).toEqual(
      validateLinear(articlePlan, articleEntries)
    );
    expect(validateLinear(threeDefectsPlan, articleEntries)).toEqual(
      validateLinear(threeDefectsPlan, articleEntries)
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LinearPlanSchema — structural gate
// ════════════════════════════════════════════════════════════════════════════

describe("LinearPlanSchema", () => {
  test("parses a well-formed plan", () => {
    expect(LinearPlanSchema.parse(articlePlan)).toEqual(articlePlan);
  });

  test("accepts an empty plan so composition/empty stays a validateLinear rule", () => {
    const empty = { inputs: [], placements: [], schema: 1 };
    expect(LinearPlanSchema.parse(empty)).toEqual(empty);
  });

  test("accepts an empty setting.value (text)", () => {
    const plan = {
      inputs: [],
      placements: [
        {
          inputs: { instructions: { source: "setting", value: "" } },
          key: "p",
          step: "text",
        },
      ],
      schema: 1,
    };
    expect(LinearPlanSchema.parse(plan)).toEqual(plan);
  });

  test("rejects a duplicate placement key", () => {
    expect(() => LinearPlanSchema.parse(duplicatePlacementPlan)).toThrow();
  });

  test("rejects a duplicate run-input key", () => {
    const plan = {
      inputs: [
        { key: "topic", label: "A", required: true, type: "text" },
        { key: "topic", label: "B", required: false, type: "text" },
      ],
      placements: [{ inputs: {}, key: "p", step: "text" }],
      schema: 1,
    };
    expect(() => LinearPlanSchema.parse(plan)).toThrow();
  });

  test("rejects an empty placement key", () => {
    const plan = {
      inputs: [],
      placements: [{ inputs: {}, key: "", step: "text" }],
      schema: 1,
    };
    expect(() => LinearPlanSchema.parse(plan)).toThrow();
  });

  test("rejects a non-string setting.value", () => {
    const plan = {
      inputs: [],
      placements: [
        {
          inputs: { instructions: { source: "setting", value: 7 } },
          key: "p",
          step: "text",
        },
      ],
      schema: 1,
    };
    expect(() => LinearPlanSchema.parse(plan)).toThrow();
  });

  test("rejects a plan with another schema", () => {
    const plan = { inputs: [], placements: [], schema: 2 };
    expect(() => LinearPlanSchema.parse(plan)).toThrow();
  });
});
