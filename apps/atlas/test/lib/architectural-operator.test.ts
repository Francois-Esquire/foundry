import { describe, expect, it } from "vitest";
import {
  createMoveOperator,
  createOperatorContext,
  createOperatorFromScenario,
  createPreserveBoundaryOperator,
  createRedirectDependencyOperator,
  createRehomeBehaviorOperator,
  createRehomeConceptOperator,
  operatorCatalogGaps,
  validateArchitecturalOperator,
} from "../../src/lib/architectural-operator";
import {
  listOperatorDefinitions,
  scenarioOperatorMapping,
} from "../../src/lib/operator-catalog";
import type {
  ArchitecturalOperator,
  OperatorContext,
} from "../../src/lib/operator-types";
import { OPERATOR_SCHEMA_VERSION } from "../../src/lib/operator-types";
import {
  renderOperator,
  renderOperatorDefinitions,
} from "../../src/lib/report-operator";
import { analyzeWorkspace } from "../../src/lib/workspace-intelligence";
import { createWorkspaceProjectionContext } from "../../src/lib/workspace-projection";
import type { Spec } from "./helpers/workspace-builder";
import { workspace } from "./helpers/workspace-builder";

const expectedTextPattern = /should |recommend/;
const forbiddenPattern =
  /^(apply|execute|write|patch|filesToMove|importEdits|score|priority|confidencePercent|rank|evidenceConfidence|mismatch)$/i;
const expectedTextPattern2 = /Unknown concept A/;
const expectedTextPattern3 = /Unknown boundary/;

const A = "packages/core/src/a.ts#A";
const APP_A = "packages/app/src/a.ts#A";
const B = "packages/store/src/b.ts#B";

function spec(overrides: Partial<Spec> = {}): Spec {
  return {
    concepts: [
      {
        behavior: {
          "@c/core": { sourceBehaviors: 2 },
          "@c/store": { sourceBehaviors: 4 },
        },
        center: { behavior: "@c/store", semantic: "@c/core" },
        id: A,
        package: "@c/core",
        participation: {
          "@c/app": { references: 2 },
          "@c/core": { implementations: 1, references: 5 },
          "@c/store": { implementations: 1, references: 3 },
        },
      },
      {
        id: APP_A,
        package: "@c/app",
        participation: { "@c/app": { implementations: 1, references: 2 } },
      },
      {
        id: B,
        package: "@c/store",
        participation: { "@c/store": { references: 2 } },
      },
    ],
    edges: ["@c/app→@c/core:3", "@c/store→@c/core:2", "@c/app→@c/store:1"],
    packages: ["@c/core", "@c/store", "@c/app"],
    reviews: [
      {
        centers: ["@c/store"],
        conceptId: A,
        disposition: "credible-alternative",
        dominatedBy: "rehome-behavior",
      },
    ],
    ...overrides,
  };
}

function context(s: Spec = spec()): OperatorContext {
  return createOperatorContext(
    createWorkspaceProjectionContext(analyzeWorkspace(workspace(s)))
  );
}

const built: ArchitecturalOperator[] = [];
function keep(operator: ArchitecturalOperator): ArchitecturalOperator {
  built.push(operator);
  return operator;
}

describe("manual operators", () => {
  it("rehome-concept states subject, placement, contract constraint, effect, and verification", () => {
    const ctx = context();
    const op = keep(
      createRehomeConceptOperator(ctx, { conceptId: A, to: "@c/store" })
    );
    expect(op.schemaVersion).toBe(OPERATOR_SCHEMA_VERSION);
    expect(op.id).toBe(`operator:rehome-concept:${A}:@c/core→@c/store`);
    expect(op.subject).toEqual({ conceptId: A, kind: "concept" });
    expect(op.placement).toEqual({
      current: { package: "@c/core" },
      target: { package: "@c/store" },
    });
    expect(op.intent.source).toBe("manual");
    expect(op.constraints).toContainEqual(
      expect.objectContaining({
        effect: "constraining",
        entityIds: ["@c/core"],
        kind: "public-contract",
      })
    );
    expect(op.expectedEffects).toContainEqual(
      expect.objectContaining({
        certainty: "certain",
        dimension: "ownership",
        from: "@c/core",
        to: "@c/store",
      })
    );
    expect(op.preservations.map((p) => p.kind)).toEqual([
      "consumer-import-path",
      "runtime-behavior",
    ]);
    expect(op.verification.map((v) => v.kind)).toEqual([
      "anchor-preserved",
      "concept-center",
      "public-surface",
      "tests",
      "typecheck",
    ]);
    expect(op.verification).toContainEqual({
      expected: [A, "@c/store"],
      kind: "concept-center",
    });
    expect(op.status).toBe("valid");
    expect(validateArchitecturalOperator(op, ctx)).toMatchObject({
      currentFingerprint: op.fingerprint.hash,
      status: "valid",
    });
  });

  it("rehome-behavior preserves the semantic center and reads current behavior packages", () => {
    const ctx = context();
    const op = keep(
      createRehomeBehaviorOperator(ctx, {
        conceptId: A,
        from: ["@c/store"],
        to: "@c/core",
      })
    );
    expect(op.subject).toEqual({
      conceptId: A,
      kind: "behavior",
      packages: ["@c/store"],
    });
    expect(op.preservations).toContainEqual({
      entityIds: ["@c/core"],
      kind: "semantic-center",
    });
    expect(op.preservations).toContainEqual({
      entityIds: ["@c/core"],
      kind: "public-contract",
    });
    expect(op.preconditions).toContainEqual(
      expect.objectContaining({
        entityIds: [A],
        expected: ["@c/core", "@c/store"],
        kind: "behavior-center-state",
      })
    );
    expect(op.expectedEffects).toEqual([
      expect.objectContaining({
        certainty: "conditional",
        dimension: "behavior",
        from: ["@c/store"],
        to: ["@c/core"],
      }),
    ]);
    expect(op.verification).toContainEqual({
      expected: [A, "@c/core"],
      kind: "behavior-location",
    });
    expect(op.verification).toContainEqual({
      expected: [A, "@c/core"],
      kind: "concept-center",
    });
    expect(op.status).toBe("valid");
  });

  it("redirect-dependency needs the boundary and the new target to exist", () => {
    const ctx = context();
    const op = keep(
      createRedirectDependencyOperator(ctx, {
        consumer: "@c/app",
        from: "@c/core",
        to: "@c/store",
      })
    );
    expect(op.subject).toEqual({
      boundaryId: "@c/app→@c/core",
      from: "@c/app",
      kind: "boundary",
      to: "@c/core",
    });
    expect(op.preconditions).toContainEqual(
      expect.objectContaining({
        entityIds: ["@c/app→@c/core"],
        expected: true,
        kind: "boundary-exists",
      })
    );
    expect(op.preconditions).toContainEqual(
      expect.objectContaining({
        entityIds: ["@c/store"],
        expected: true,
        kind: "package-exists",
      })
    );
    expect(op.expectedEffects).toContainEqual(
      expect.objectContaining({
        dimension: "dependency",
        from: "@c/app→@c/core",
        to: "@c/app→@c/store",
      })
    );
    expect(op.status).toBe("valid");
    expect(() =>
      createRedirectDependencyOperator(ctx, {
        consumer: "@c/core",
        from: "@c/app",
        to: "@c/store",
      })
    ).toThrow(expectedTextPattern3);
  });

  it("preserve-boundary records intent and changes nothing", () => {
    const ctx = context(spec({ anchored: ["@c/store"] }));
    const op = keep(
      createPreserveBoundaryOperator(ctx, {
        packageId: "@c/store",
        reason: "intentional subsystem boundary",
      })
    );
    expect(op.placement).toEqual({});
    expect(op.expectedEffects).toEqual([]);
    expect(op.preservations).toContainEqual({
      entityIds: ["@c/store"],
      kind: "anchor",
      reason: "intentional subsystem boundary",
    });
    expect(op.constraints.every((c) => c.effect === "informational")).toBe(
      true
    );
    expect(op.status).toBe("valid");
  });

  it("move takes a concept or a symbol and blocks on unobserved conformance", () => {
    const ctx = context();
    const concept = keep(
      createMoveOperator(ctx, {
        subject: { conceptId: A, kind: "concept" },
        to: "@c/app",
      })
    );
    expect(concept.placement).toEqual({
      current: { package: "@c/core" },
      target: { package: "@c/app" },
    });
    expect(concept.status).toBe("valid");
    const symbol = keep(
      createMoveOperator(ctx, {
        subject: {
          kind: "symbol",
          name: "x",
          package: "@c/core",
          symbolId: "packages/core/src/x.ts#x",
        },
        to: "@c/store",
      })
    );
    expect(symbol.subject.kind).toBe("symbol");
    expect(symbol.status).toBe("valid");
    const unseen = keep(
      createMoveOperator(ctx, {
        subject: { conceptId: B, kind: "concept" },
        to: "@c/app",
      })
    );
    expect(unseen.constraints).toContainEqual(
      expect.objectContaining({
        effect: "blocking",
        kind: "structural-conformance-unknown",
      })
    );
    expect(unseen.status).toBe("blocked");
  });

  it("uses exact canonical ids when display names collide", () => {
    const ctx = context();
    const core = keep(
      createRehomeConceptOperator(ctx, { conceptId: A, to: "@c/store" })
    );
    const app = keep(
      createRehomeConceptOperator(ctx, { conceptId: APP_A, to: "@c/store" })
    );
    expect(core.subject).toEqual({ conceptId: A, kind: "concept" });
    expect(app.subject).toEqual({ conceptId: APP_A, kind: "concept" });
    expect(app.placement.current).toEqual({ package: "@c/app" });
    expect(core.id).not.toBe(app.id);
    expect(() =>
      createRehomeConceptOperator(ctx, { conceptId: "A", to: "@c/store" })
    ).toThrow(expectedTextPattern2);
  });
});

describe("anchors", () => {
  it("blocks a semantic center leaving an anchored package and keeps the reason", () => {
    const ctx = context(spec({ anchored: ["@c/core"] }));
    const op = keep(
      createRehomeConceptOperator(ctx, { conceptId: A, to: "@c/store" })
    );
    expect(op.status).toBe("blocked");
    const anchor = op.constraints.find((c) => c.kind === "anchor");
    expect(anchor).toMatchObject({
      effect: "blocking",
      entityIds: ["@c/core"],
    });
    expect(anchor?.detail).toContain("@c/core");
    const validation = validateArchitecturalOperator(op, ctx);
    expect(validation.status).toBe("blocked");
    expect(
      validation.constraints.find((c) => c.kind === "anchor")?.decisive
    ).toBe(true);
  });

  it("constrains, never blocks, movement into or behavior out of an anchored package", () => {
    const ctx = context(spec({ anchored: ["@c/store"] }));
    const inbound = keep(
      createRehomeConceptOperator(ctx, { conceptId: A, to: "@c/store" })
    );
    expect(inbound.status).toBe("valid");
    expect(inbound.constraints).toContainEqual(
      expect.objectContaining({
        effect: "constraining",
        entityIds: ["@c/store"],
        kind: "anchor",
      })
    );
    const outbound = keep(
      createRehomeBehaviorOperator(ctx, {
        conceptId: A,
        from: ["@c/store"],
        to: "@c/core",
      })
    );
    expect(outbound.status).toBe("valid");
    expect(
      validateArchitecturalOperator(outbound, ctx).cautions.some((c) =>
        c.includes("@c/store")
      )
    ).toBe(true);
  });
});

describe("validation", () => {
  it("reports stale when the behavior facts moved since the fingerprint", () => {
    const op = keep(
      createRehomeBehaviorOperator(context(), {
        conceptId: A,
        from: ["@c/store"],
        to: "@c/core",
      })
    );
    const moved = spec();
    const concept = moved.concepts.find((c) => c.id === A);
    if (concept === undefined) {
      throw new Error("fixture");
    }
    concept.behavior = { "@c/core": { sourceBehaviors: 6 } };
    const validation = validateArchitecturalOperator(op, context(moved));
    expect(validation.status).toBe("stale");
    expect(validation.currentFingerprint).not.toBe(op.fingerprint.hash);
    expect(
      validation.preconditions.find((p) => p.kind === "behavior-center-state")
    ).toMatchObject({ actual: ["@c/core"], expected: ["@c/core", "@c/store"] });
    expect(validation.cautions.join("\n")).toContain("behavior-center-state");
  });

  it("rejects a no-op placement as unsupported", () => {
    const ctx = context();
    const op = keep(
      createRehomeConceptOperator(ctx, { conceptId: A, to: "@c/core" })
    );
    expect(op.status).toBe("unsupported");
    expect(validateArchitecturalOperator(op, ctx).cautions).toEqual([
      "current and target placement are identical (no-op)",
    ]);
  });

  it("is deterministic regardless of input order", () => {
    const ctx = context();
    const a = createRehomeBehaviorOperator(ctx, {
      conceptId: A,
      from: ["@c/store", "@c/core"],
      to: "@c/app",
    });
    const b = createRehomeBehaviorOperator(ctx, {
      conceptId: A,
      from: ["@c/core", "@c/store"],
      to: "@c/app",
    });
    expect(a).toEqual(b);
    expect(a.id).toBe(`operator:rehome-behavior:${A}:@c/core,@c/store→@c/app`);
  });

  it("round-trips through JSON", () => {
    const op = createRehomeConceptOperator(context(), {
      conceptId: A,
      to: "@c/store",
    });
    const parsed: unknown = JSON.parse(JSON.stringify(op));
    expect(parsed).toEqual(op);
  });
});

describe("catalog and scenarios", () => {
  it("lists six definitions, none with mutation behavior, internalize executable through the legacy path", () => {
    const definitions = listOperatorDefinitions();
    expect(definitions.map((d) => d.kind)).toEqual([
      "internalize",
      "move",
      "rehome-concept",
      "rehome-behavior",
      "redirect-dependency",
      "preserve-boundary",
    ]);
    expect(definitions.filter((d) => d.executable).map((d) => d.kind)).toEqual([
      "internalize",
    ]);
    expect(definitions[0]?.legacyOperatorId).toBe("internalize-export");
    for (const definition of definitions) {
      for (const value of Object.values(definition)) {
        expect(typeof value).not.toBe("function");
      }
      if (definition.kind !== "preserve-boundary") {
        expect(definition.verificationKinds).toContain("typecheck");
      }
    }
    expect(renderOperatorDefinitions(definitions)).toContain("rehome-behavior");
  });

  it("maps scenario kinds and names the gaps", () => {
    expect(scenarioOperatorMapping("rehome-semantic-center").operatorKind).toBe(
      "rehome-concept"
    );
    expect(scenarioOperatorMapping("consolidate-behavior").operatorKind).toBe(
      "rehome-behavior"
    );
    const formalize = scenarioOperatorMapping(
      "formalize-representation-boundary"
    );
    expect(formalize.operatorKind).toBeNull();
    expect(formalize.gap).toContain("not yet");
    expect(scenarioOperatorMapping("preserve-current").operatorKind).toBeNull();
    expect(
      operatorCatalogGaps(context()).map((g) => [g.scenarioKind, g.scenarios])
    ).toEqual([["preserve-current", 1]]);
  });

  it("needs the package-level scenario record before deriving an operator", () => {
    const ctx = context();
    const result = createOperatorFromScenario(ctx, `${A}::rehome-behavior`);
    if (result.status !== "unsupported") {
      throw new Error("expected unsupported");
    }
    expect(result.scenarioKind).toBe("rehome-behavior");
    expect(result.reason).toContain("package-level record");
    const unknown = createOperatorFromScenario(ctx, "nope");
    if (unknown.status !== "unsupported") {
      throw new Error("expected unsupported");
    }
    expect(unknown.reason).toContain("not in the workspace");
  });
});

describe("operator model boundaries", () => {
  it("carries no execution, edit, score, or priority fields", () => {
    expect(built.length).toBeGreaterThan(8);
    const keys = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (typeof value === "object" && value !== null) {
        for (const [key, inner] of Object.entries(value)) {
          keys.add(key);
          walk(inner);
        }
      }
    };
    built.forEach(walk);
    const forbidden = forbiddenPattern;
    expect([...keys].filter((key) => forbidden.test(key))).toEqual([]);
    for (const op of built) {
      for (const value of Object.values(op)) {
        expect(typeof value).not.toBe("function");
      }
      const text = renderOperator(
        op,
        validateArchitecturalOperator(op, context())
      );
      expect(text).not.toMatch(expectedTextPattern);
    }
  });
});
