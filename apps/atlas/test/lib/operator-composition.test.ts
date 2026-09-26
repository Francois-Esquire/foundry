import { describe, expect, it } from "vitest";
import {
  createMoveOperator,
  createOperatorContext,
  createPreserveBoundaryOperator,
  createRedirectDependencyOperator,
  createRehomeBehaviorOperator,
  createRehomeConceptOperator,
  operatorFingerprint,
} from "../../src/lib/architectural-operator";
import {
  canonicalActionId,
  canonicalActionKey,
  composeArchitecturalOperators,
  detectActionConflicts,
  validateOperatorComposition,
} from "../../src/lib/operator-composition";
import type { OperatorComposition } from "../../src/lib/operator-composition-types";
import { COMPOSITION_SCHEMA_VERSION } from "../../src/lib/operator-composition-types";
import { decomposeArchitecturalOperator } from "../../src/lib/operator-decomposition";
import type { OperatorDecomposition } from "../../src/lib/operator-decomposition-types";
import type {
  ArchitecturalOperator,
  OperatorContext,
} from "../../src/lib/operator-types";
import { OPERATOR_SCHEMA_VERSION } from "../../src/lib/operator-types";
import { renderOperatorComposition } from "../../src/lib/report-composition";
import { analyzeWorkspace } from "../../src/lib/workspace-intelligence";
import { createWorkspaceProjectionContext } from "../../src/lib/workspace-projection";
import type { Spec } from "./helpers/workspace-builder";
import { workspace } from "./helpers/workspace-builder";

const A = "packages/core/src/a.ts#A";
const B = "packages/store/src/b.ts#B";
const IFACE = "packages/core/src/iface.ts#Iface";

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
        id: B,
        package: "@c/store",
        participation: {
          "@c/app": { references: 1 },
          "@c/store": { references: 2 },
        },
      },
      {
        behavior: { "@c/store": { sourceBehaviors: 1 } },
        id: IFACE,
        kind: "interface",
        package: "@c/core",
        participation: {
          "@c/core": { references: 2 },
          "@c/store": { references: 1 },
        },
      },
    ],
    edges: [
      "@c/app→@c/core:3",
      "@c/store→@c/core:2",
      "@c/app→@c/store:1",
      "@c/ext→@c/core:1",
    ],
    packages: ["@c/core", "@c/store", "@c/app", "@c/ext"],
    ...overrides,
  };
}

function context(s: Spec = spec()): OperatorContext {
  return createOperatorContext(
    createWorkspaceProjectionContext(analyzeWorkspace(workspace(s)))
  );
}

/** A manual internalize operator: the synthetic workspace carries no legacy plans. */
function internalize(
  symbolId: string,
  packageId: string,
  anchored = false
): ArchitecturalOperator {
  return {
    constraints: [],
    evidence: [{ entityIds: [symbolId], source: "surface" }],
    expectedEffects: [
      {
        certainty: "certain",
        change: "surface-internalization",
        dimension: "surface",
        evidenceRefs: [],
        from: "package-public",
        to: "internal",
      },
    ],
    fingerprint: operatorFingerprint([`public-surface-state:${symbolId}=true`]),
    id: `operator:internalize:${symbolId}`,
    intent: { reason: "leaves the public surface", source: "manual" },
    kind: "internalize",
    placement: { current: { package: packageId } },
    preconditions: [],
    preservations: [
      { entityIds: [symbolId], kind: "runtime-behavior" },
      ...(anchored
        ? [{ entityIds: [packageId], kind: "anchor" as const }]
        : []),
    ],
    schemaVersion: OPERATOR_SCHEMA_VERSION,
    status: "valid",
    subject: {
      kind: "symbol",
      name: symbolId.split("#")[1] ?? symbolId,
      package: packageId,
      symbolId,
    },
    verification: [
      { expected: [symbolId, "internal"], kind: "public-surface" },
      { expected: true, kind: "typecheck" },
    ],
  };
}

function withoutPath(op: ArchitecturalOperator): ArchitecturalOperator {
  return {
    ...op,
    id: `${op.id}:break-path`,
    preservations: op.preservations.filter(
      (p) => p.kind !== "consumer-import-path"
    ),
  };
}

const built: OperatorComposition[] = [];

function compose(
  ctx: OperatorContext,
  operators: ArchitecturalOperator[],
  decompositions = operators.map((o) => decomposeArchitecturalOperator(o, ctx))
): {
  composition: OperatorComposition;
  decompositions: OperatorDecomposition[];
} {
  const composition = composeArchitecturalOperators(
    operators,
    decompositions,
    ctx
  );
  built.push(composition);
  return { composition, decompositions };
}

function kinds(c: OperatorComposition): string[] {
  return c.actions.map((a) => a.kind);
}

function conflictKinds(c: OperatorComposition): string[] {
  return c.conflicts.map((x) => x.kind);
}

describe("shared actions", () => {
  it("merges the same target exposure required by two operators into one action with both sources", () => {
    const ctx = context();
    const one = createRedirectDependencyOperator(ctx, {
      consumer: "@c/app",
      from: "@c/core",
      to: "@c/store",
    });
    const two = createRedirectDependencyOperator(ctx, {
      consumer: "@c/ext",
      from: "@c/core",
      to: "@c/store",
    });
    const { composition: c } = compose(ctx, [one, two]);
    expect(c.schemaVersion).toBe(COMPOSITION_SCHEMA_VERSION);
    expect(c.diagnostics).toMatchObject({
      conflicts: 0,
      explicitDependencies: 2,
      inferredDependencies: 0,
      inputActions: 4,
      inputOperators: 2,
      mergedActions: 3,
      sharedActions: 1,
    });
    const [shared] = c.sharedActions;
    expect(shared).toEqual({
      canonicalActionId: "establish-target-exposure:@c/store#*:?→@c/store",
      mergedActionId:
        "composed/establish-target-exposure:@c/store#*:?→@c/store",
      sourceActions: [
        `${one.id}/establish-target-exposure:@c/store#*:?→@c/store`,
        `${two.id}/establish-target-exposure:@c/store#*:?→@c/store`,
      ],
      sourceOperators: [one.id, two.id],
    });
    const establish = c.actions.find(
      (a) => a.kind === "establish-target-exposure"
    );
    expect(establish?.sourceOperators).toEqual([one.id, two.id]);
    expect(establish?.preconditions).toEqual([
      { entityIds: ["@c/store"], kind: "package-exists" },
    ]);
    expect(establish?.evidence).toHaveLength(4);
    expect(c.actions[0]?.id).toBe(establish?.id);
    expect(
      c.dependencies.map((d) => [d.before === establish?.id, d.origin])
    ).toEqual([
      [true, "explicit"],
      [true, "explicit"],
    ]);
    expect(c.status).toBe("partial");
  });

  it("keeps actions of the same kind for different concepts separate", () => {
    const ctx = context();
    const { composition: c } = compose(ctx, [
      createRehomeConceptOperator(ctx, { conceptId: A, to: "@c/store" }),
      createRehomeConceptOperator(ctx, { conceptId: B, to: "@c/core" }),
    ]);
    expect(
      c.actions
        .filter((a) => a.kind === "establish-target-exposure")
        .map((a) => a.subject)
    ).toEqual([
      { conceptId: B, kind: "exposure", package: "@c/core" },
      { conceptId: A, kind: "exposure", package: "@c/store" },
    ]);
    expect(c.sharedActions).toEqual([]);
    expect(c.conflicts).toEqual([]);
  });

  it("derives canonical keys from kind, subject, and placement only", () => {
    const ctx = context();
    const d = decomposeArchitecturalOperator(
      createRehomeConceptOperator(ctx, { conceptId: A, to: "@c/store" }),
      ctx
    );
    const relocate = d.actions.find(
      (a) => a.kind === "relocate-semantic-declaration"
    );
    if (relocate === undefined) {
      throw new Error("no relocate action");
    }
    expect(canonicalActionKey(relocate)).toEqual({
      current: "@c/core",
      kind: "relocate-semantic-declaration",
      subject: A,
      target: "@c/store",
    });
    expect(canonicalActionId(canonicalActionKey(relocate))).toBe(
      `relocate-semantic-declaration:${A}:@c/core→@c/store`
    );
    expect(
      relocate.id.endsWith(canonicalActionId(canonicalActionKey(relocate)))
    ).toBe(true);
  });
});

describe("compatible compositions", () => {
  it("composes a semantic rehome with a dependency redirect and infers the cross-operator order", () => {
    const ctx = context();
    const rehome = createRehomeConceptOperator(ctx, {
      conceptId: A,
      to: "@c/store",
    });
    const redirect = createRedirectDependencyOperator(ctx, {
      consumer: "@c/app",
      from: "@c/core",
      to: "@c/store",
    });
    const { composition: c, decompositions } = compose(ctx, [rehome, redirect]);
    expect(c.status).toBe("partial");
    expect(c.conflicts).toEqual([]);
    const inferred = c.dependencies.filter((d) => d.origin === "inferred");
    expect(inferred.map((d) => d.rule)).toEqual([
      "exposure-before-redirect",
      "exposure-before-redirect",
      "exposure-before-redirect",
      "relocate-before-exposure",
    ]);
    expect(inferred).toContainEqual({
      after:
        "composed/redirect-concept-dependency:@c/app⇢@c/core#*:@c/core→@c/store",
      before: `composed/establish-target-exposure:@c/store#${A}:?→@c/store`,
      kind: "requires",
      origin: "inferred",
      reason: "the consumer can only depend on an exposed contract",
      rule: "exposure-before-redirect",
      sourceOperators: [redirect.id, rehome.id],
    });
    expect(c.unresolved.map((g) => g.kind)).toEqual([
      "dependency-target-unresolved",
      "target-module-unresolved",
    ]);
    expect(
      validateOperatorComposition(c, [rehome, redirect], decompositions, ctx)
    ).toMatchObject({ cycles: [], problems: [], status: "valid" });
  });

  it("keeps two redirects of distinct concepts on one boundary as separate concept-scoped actions", () => {
    const ctx = context();
    const { composition: c } = compose(ctx, [
      createRehomeConceptOperator(ctx, { conceptId: A, to: "@c/store" }),
      createRehomeBehaviorOperator(ctx, {
        conceptId: IFACE,
        from: ["@c/store"],
        to: "@c/core",
      }),
    ]);
    expect(c.conflicts).toEqual([]);
    const redirects = c.actions.filter(
      (a) => a.kind === "redirect-concept-dependency"
    );
    expect(redirects.map((a) => a.subject)).toContainEqual({
      conceptId: A,
      consumer: "@c/app",
      kind: "dependency",
      provider: "@c/core",
    });
    expect(redirects.map((a) => a.subject)).toContainEqual({
      conceptId: IFACE,
      consumer: "@c/store",
      kind: "dependency",
      provider: "@c/core",
    });
    expect(
      c.preservations.find(
        (p) => p.preservationId === "public-contract:@c/core"
      )?.status
    ).toBe("implicit");
  });

  it("unions two unrelated internalizations and dedupes a repeated one", () => {
    const ctx = context();
    const { composition: two } = compose(ctx, [
      internalize(A, "@c/core"),
      internalize(B, "@c/store"),
    ]);
    expect(kinds(two)).toEqual([
      "internalize-old-exposure",
      "internalize-old-exposure",
    ]);
    expect(two.dependencies).toEqual([]);
    expect(two.status).toBe("complete");
    const { composition: same } = compose(ctx, [
      internalize(A, "@c/core"),
      internalize(A, "@c/core"),
    ]);
    expect(same.operators).toEqual([`operator:internalize:${A}`]);
    expect(same.diagnostics.mergedActions).toBe(1);
  });

  it("dedupes an anchored boundary preserved by two operators without conflict", () => {
    const ctx = context(spec({ anchored: ["@c/core"] }));
    const { composition: c } = compose(ctx, [
      internalize(A, "@c/core", true),
      internalize(IFACE, "@c/core", true),
    ]);
    expect(c.conflicts).toEqual([]);
    expect(c.sharedActions.map((s) => s.canonicalActionId)).toEqual([
      "preserve-anchor-boundary:@c/core",
    ]);
    expect(
      c.preservations.find((p) => p.preservationId === "anchor:@c/core")
    ).toMatchObject({
      coverageActions: ["composed/preserve-anchor-boundary:@c/core"],
      requiredByOperators: [
        `operator:internalize:${A}`,
        `operator:internalize:${IFACE}`,
      ],
      status: "covered",
    });
    expect(c.status).toBe("complete");
  });

  it("orders a shared action before the actions of both operators that need it", () => {
    const ctx = context();
    const { composition: c } = compose(ctx, [
      createRedirectDependencyOperator(ctx, {
        consumer: "@c/ext",
        from: "@c/core",
        to: "@c/store",
      }),
      createRedirectDependencyOperator(ctx, {
        consumer: "@c/app",
        from: "@c/core",
        to: "@c/store",
      }),
    ]);
    expect(kinds(c)).toEqual([
      "establish-target-exposure",
      "redirect-concept-dependency",
      "redirect-concept-dependency",
    ]);
    expect(c.groups).toEqual([
      { actionIds: [c.actions[0]?.id], kind: "surface" },
      {
        actionIds: [c.actions[1]?.id, c.actions[2]?.id],
        kind: "dependency",
      },
    ]);
  });
});

describe("conflicts", () => {
  it("reports a target conflict when the same concept is rehomed to two packages", () => {
    const ctx = context();
    const { composition: c } = compose(ctx, [
      createRehomeConceptOperator(ctx, { conceptId: A, to: "@c/store" }),
      createRehomeConceptOperator(ctx, { conceptId: A, to: "@c/app" }),
    ]);
    expect(c.status).toBe("conflicted");
    expect(conflictKinds(c)).toEqual([
      "action-effect-conflict",
      "action-effect-conflict",
      "placement-conflict",
      "target-conflict",
    ]);
    expect(c.conflicts.find((x) => x.kind === "target-conflict")).toMatchObject(
      {
        actions: [],
        entities: ["@c/app", "@c/store", A],
      }
    );
    expect(
      c.effects.find((e) => e.change === "semantic-center-change")?.relation
    ).toBe("conflicting");
    expect(
      c.verification
        .filter((v) => v.kind === "concept-center")
        .map((v) => v.status)
    ).toEqual(["conflicting", "conflicting"]);
    expect(c.sharedActions.map((s) => s.canonicalActionId)).toEqual([
      `preserve-implementation-split:${A}@implementation`,
      `preserve-public-exposure:@c/core#${A}:@c/core→?`,
    ]);
  });

  it("reports an exposure conflict when the old path is both kept and closed", () => {
    const ctx = context();
    const rehome = createRehomeConceptOperator(ctx, {
      conceptId: A,
      to: "@c/store",
    });
    const { composition: c } = compose(ctx, [
      rehome,
      internalize(A, "@c/core"),
    ]);
    expect(c.status).toBe("conflicted");
    expect(conflictKinds(c)).toEqual([
      "exposure-conflict",
      "exposure-conflict",
    ]);
    expect(
      c.preservations.find((p) => p.kind === "consumer-import-path")?.status
    ).toBe("conflicted");
    expect(c.resolutions).toEqual([
      expect.objectContaining({
        gapId: `${rehome.id}/target-module-unresolved:@c/store`,
        status: "unresolved",
      }),
    ]);
  });

  it("reports a dependency conflict when one concept dependency is redirected to two targets", () => {
    const ctx = context();
    const { composition: c } = compose(ctx, [
      createRehomeBehaviorOperator(ctx, {
        conceptId: A,
        from: ["@c/app"],
        to: "@c/core",
      }),
      createRehomeBehaviorOperator(ctx, {
        conceptId: A,
        from: ["@c/app"],
        to: "@c/store",
      }),
    ]);
    expect(conflictKinds(c)).toContain("dependency-conflict");
    expect(
      c.conflicts.find((x) => x.kind === "dependency-conflict")
    ).toMatchObject({
      entities: [`@c/app⇢@c/core#${A}`],
    });
    expect(conflictKinds(c)).toContain("target-conflict");
  });

  it("reports an anchor conflict when responsibility leaves a preserved boundary", () => {
    const ctx = context();
    const keep = createPreserveBoundaryOperator(ctx, {
      packageId: "@c/core",
      reason: "core stays",
    });
    const rehome = createRehomeConceptOperator(ctx, {
      conceptId: A,
      to: "@c/store",
    });
    const { composition: c } = compose(ctx, [keep, rehome]);
    expect(c.status).toBe("conflicted");
    expect(c.conflicts).toEqual([
      {
        actions: [
          `composed/relocate-semantic-declaration:${A}:@c/core→@c/store`,
        ],
        detail:
          "@c/core keeps its anchored boundary while responsibility leaves it",
        entities: ["anchor:@c/core"],
        kind: "anchor-conflict",
        operators: [keep.id, rehome.id],
      },
    ]);
    expect(
      c.preservations.find((p) => p.preservationId === "anchor:@c/core")?.status
    ).toBe("conflicted");
    expect(c.dependencies.filter((d) => d.origin === "inferred")).toEqual([
      expect.objectContaining({ rule: "anchor-before-placement" }),
    ]);
  });

  it("reports a preservation conflict and an intent conflict between a semantic rehome and a behavior rehome across it", () => {
    const ctx = context();
    const { composition: c } = compose(ctx, [
      createRehomeBehaviorOperator(ctx, {
        conceptId: A,
        from: ["@c/store"],
        to: "@c/core",
      }),
      createRehomeConceptOperator(ctx, { conceptId: A, to: "@c/store" }),
    ]);
    expect(conflictKinds(c)).toEqual([
      "operator-intent-conflict",
      "preservation-conflict",
    ]);
    expect(c.conflicts[1]).toMatchObject({
      entities: ["semantic-center:@c/core"],
    });
    expect(
      c.preservations.find(
        (p) => p.preservationId === "semantic-center:@c/core"
      )?.status
    ).toBe("conflicted");
  });

  it("reports an ordering conflict with the exact cycle when merged dependencies loop", () => {
    const ctx = context();
    const one = createRehomeConceptOperator(ctx, {
      conceptId: A,
      to: "@c/store",
    });
    const two = withoutPath(one);
    const dOne = decomposeArchitecturalOperator(one, ctx);
    const dTwo = decomposeArchitecturalOperator(two, ctx);
    const reversed: OperatorDecomposition = {
      ...dTwo,
      dependencies: dTwo.dependencies.map((d) =>
        d.reason === "the target exposes what it now declares"
          ? { ...d, after: d.before, before: d.after }
          : d
      ),
    };
    const { composition: c } = compose(ctx, [one, two], [dOne, reversed]);
    expect(c.status).toBe("conflicted");
    const cycle = c.conflicts.find((x) => x.kind === "action-order-conflict");
    expect(cycle?.actions).toEqual([
      `composed/establish-target-exposure:@c/store#${A}:?→@c/store`,
      `composed/relocate-semantic-declaration:${A}:@c/core→@c/store`,
    ]);
    expect(cycle?.operators).toEqual([one.id, two.id]);
  });

  it("flags divergent effects on one merged action", () => {
    const ctx = context();
    const d = decomposeArchitecturalOperator(
      createRehomeBehaviorOperator(ctx, {
        conceptId: A,
        from: ["@c/store"],
        to: "@c/core",
      }),
      ctx
    );
    const relocate = d.actions.find(
      (a) => a.kind === "relocate-behavior-responsibility"
    );
    if (relocate === undefined) {
      throw new Error("no relocate action");
    }
    const effect = relocate.expectedEffects[0];
    if (effect === undefined) {
      throw new Error("no effect");
    }
    const conflicts = detectActionConflicts([
      {
        ...relocate,
        expectedEffects: [effect, { ...effect, from: ["@c/store", "@c/app"] }],
        sourceActions: ["x/a", "y/a"],
        sourceOperators: ["x", "y"],
      },
    ]);
    expect(conflicts.map((x) => x.kind)).toEqual(["action-effect-conflict"]);
  });
});

describe("preservations, effects, verification", () => {
  it("dedupes identical effects and verification requirements across operators", () => {
    const ctx = context();
    const one = createRehomeConceptOperator(ctx, {
      conceptId: A,
      to: "@c/store",
    });
    const two = withoutPath(one);
    const { composition: c } = compose(ctx, [one, two]);
    expect(c.conflicts).toEqual([]);
    expect(c.effects.map((e) => [e.change, e.relation])).toEqual([
      ["semantic-center-change", "duplicate"],
      ["surface-relocation", "duplicate"],
    ]);
    expect(c.effects[0]?.changes).toHaveLength(1);
    const typecheck = c.verification.find((v) => v.kind === "typecheck");
    expect(typecheck).toMatchObject({
      expected: true,
      requiredByOperators: [one.id, two.id],
      status: "compatible",
    });
    expect(typecheck?.relatedActions).toContain(
      `composed/relocate-semantic-declaration:${A}:@c/core→@c/store`
    );
    expect(c.diagnostics.sharedActions).toBe(5);
  });

  it("resolves a surface gap through a companion operator that keeps the old exposure", () => {
    const ctx = context();
    const keep = createRehomeConceptOperator(ctx, {
      conceptId: A,
      to: "@c/store",
    });
    const open = withoutPath(keep);
    const alone = decomposeArchitecturalOperator(open, ctx);
    expect(alone.unresolved.map((g) => g.kind)).toContain(
      "surface-transition-unspecified"
    );
    const { composition: c } = compose(ctx, [open, keep]);
    expect(c.resolutions).toContainEqual({
      gapId: `${open.id}/surface-transition-unspecified:@c/core`,
      resolvedByActions: [
        `composed/preserve-public-exposure:@c/core#${A}:@c/core→?`,
      ],
      resolvedByOperators: [keep.id],
      sourceOperator: open.id,
      status: "resolved",
    });
    expect(c.unresolved.map((g) => g.kind)).toEqual([
      "target-module-unresolved",
      "target-module-unresolved",
    ]);
    expect(c.diagnostics).toMatchObject({ gapsRemaining: 2, gapsResolved: 1 });
    expect(c.status).toBe("partial");
  });

  it("resolves a surface gap through an internalization when no preservation forbids it", () => {
    const ctx = context();
    const open = withoutPath(
      createRehomeConceptOperator(ctx, { conceptId: A, to: "@c/store" })
    );
    const close = internalize(A, "@c/core");
    const { composition: c, decompositions } = compose(ctx, [open, close]);
    expect(c.conflicts).toEqual([]);
    expect(c.status).toBe("partial");
    expect(
      c.resolutions.find((r) => r.gapId.includes("surface-transition"))
    ).toMatchObject({
      resolvedByActions: [
        `composed/internalize-old-exposure:@c/core#${A}:@c/core→?`,
      ],
      resolvedByOperators: [close.id],
      status: "resolved",
    });
    expect(c.dependencies.filter((d) => d.origin === "inferred")).toEqual([
      expect.objectContaining({
        after: `composed/internalize-old-exposure:@c/core#${A}:@c/core→?`,
        kind: "preserve-before-remove",
        rule: "redirect-before-internalize",
      }),
    ]);
    expect(
      validateOperatorComposition(c, [open, close], decompositions, ctx).status
    ).toBe("valid");
  });

  it("keeps factual gaps unresolved whatever else is composed", () => {
    const ctx = context(spec({ missing: ["@c/ext"] }));
    const { composition: c } = compose(ctx, [
      createRehomeBehaviorOperator(ctx, {
        conceptId: IFACE,
        from: ["@c/store"],
        to: "@c/core",
      }),
      createRehomeBehaviorOperator(ctx, {
        conceptId: A,
        from: ["@c/store"],
        to: "@c/core",
      }),
      createPreserveBoundaryOperator(ctx, {
        packageId: "@c/core",
        reason: "core stays",
      }),
    ]);
    expect(c.diagnostics.gapsResolved).toBe(0);
    expect(c.unresolved.map((g) => g.kind)).toEqual([
      "behavior-members-unresolved",
      "target-module-unresolved",
      "behavior-members-unresolved",
      "structural-conformance-unknown",
      "target-module-unresolved",
    ]);
    expect(
      c.unresolved.find((g) => g.kind === "behavior-members-unresolved")?.detail
    ).toContain("unanalyzed");
  });
});

describe("status, identity, serialization", () => {
  it("is stale when an operator no longer matches the facts and does not rewrite it", () => {
    const ctx = context();
    const op = createRehomeConceptOperator(ctx, {
      conceptId: A,
      to: "@c/store",
    });
    const other = internalize(B, "@c/store");
    const decompositions = [op, other].map((o) =>
      decomposeArchitecturalOperator(o, ctx)
    );
    const later = context(
      spec({
        concepts: spec().concepts.map((c) =>
          c.id === A ? { ...c, package: "@c/store" } : c
        ),
      })
    );
    const c = composeArchitecturalOperators([op, other], decompositions, later);
    expect(c.status).toBe("stale");
    expect(c.inputProblems[0]).toContain(`${op.id}: operator is stale`);
    expect(c.diagnostics.redecomposed).toEqual([]);
    expect(c.actions.map((a) => a.sourceOperators)).toEqual([[other.id]]);
    expect(
      validateOperatorComposition(c, [op, other], decompositions, later).status
    ).toBe("stale");
  });

  it("is unsupported when an operator has no decomposition rules", () => {
    const ctx = context();
    const { composition: c } = compose(ctx, [
      createMoveOperator(ctx, {
        subject: { conceptId: A, kind: "concept" },
        to: "@c/store",
      }),
      internalize(B, "@c/store"),
    ]);
    expect(c.status).toBe("unsupported");
    expect(c.inputProblems[0]).toContain("no decomposition");
  });

  it("is blocked, not conflicted, when compatible operators hit an anchor", () => {
    const ctx = context(spec({ anchored: ["@c/core"] }));
    const rehome = createRehomeConceptOperator(ctx, {
      conceptId: A,
      to: "@c/store",
    });
    expect(rehome.status).toBe("blocked");
    const { composition: c } = compose(ctx, [
      rehome,
      internalize(B, "@c/store"),
    ]);
    expect(c.conflicts).toEqual([]);
    expect(c.status).toBe("blocked");
    expect(c.inputProblems[0]).toContain("blocked");
    expect(
      c.actions.find((a) => a.kind === "relocate-semantic-declaration")?.status
    ).toBe("blocked");
  });

  it("rebuilds a missing or outdated decomposition and says so", () => {
    const ctx = context();
    const op = createRehomeConceptOperator(ctx, {
      conceptId: A,
      to: "@c/store",
    });
    const missing = composeArchitecturalOperators([op], [], ctx);
    expect(missing.diagnostics.redecomposed).toEqual([`${op.id} (missing)`]);
    const behind: OperatorDecomposition = {
      ...decomposeArchitecturalOperator(op, ctx),
      operatorFingerprint: "0000000000000000",
    };
    const rebuilt = composeArchitecturalOperators([op], [behind], ctx);
    expect(rebuilt.diagnostics.redecomposed).toEqual([
      `${op.id} (behind its operator)`,
    ]);
    expect(rebuilt.actions).toEqual(missing.actions);
  });

  it("is byte-equal whatever the input order and keeps one id per operator set", () => {
    const ctx = context();
    const ops = [
      withoutPath(
        createRehomeConceptOperator(ctx, { conceptId: A, to: "@c/store" })
      ),
      internalize(A, "@c/core"),
      createRedirectDependencyOperator(ctx, {
        consumer: "@c/app",
        from: "@c/core",
        to: "@c/store",
      }),
    ];
    const ds = ops.map((o) => decomposeArchitecturalOperator(o, ctx));
    const one = composeArchitecturalOperators(ops, ds, ctx);
    const two = composeArchitecturalOperators(
      [ops[2], ops[0], ops[1]].flatMap((o) => (o === undefined ? [] : [o])),
      [ds[1], ds[2], ds[0]].flatMap((d) => (d === undefined ? [] : [d])),
      ctx
    );
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    expect(one.id).toMatch(/^composition:[0-9a-f]{16}$/);
    const moved = composeArchitecturalOperators(
      ops.map((o, i) =>
        i === 1
          ? { ...o, fingerprint: { facts: [], hash: "1111111111111111" } }
          : o
      ),
      ds,
      ctx
    );
    expect(moved.id).not.toBe(one.id);
    expect(moved.fingerprint.hash).not.toBe(one.fingerprint.hash);
    expect(one.fingerprint.facts).toContain("composition-rules:1");
  });

  it("round-trips through JSON and validates a record against its inputs", () => {
    const ctx = context();
    const ops = [
      createRehomeConceptOperator(ctx, { conceptId: A, to: "@c/store" }),
      createRedirectDependencyOperator(ctx, {
        consumer: "@c/ext",
        from: "@c/core",
        to: "@c/store",
      }),
    ];
    const { composition: c, decompositions } = compose(ctx, ops);
    const parsed = JSON.parse(JSON.stringify(c)) as OperatorComposition;
    expect(parsed).toEqual(c);
    expect(
      validateOperatorComposition(parsed, ops, decompositions, ctx)
    ).toEqual({
      compositionId: c.id,
      currentFingerprint: c.fingerprint.hash,
      cycles: [],
      fingerprint: c.fingerprint.hash,
      problems: [],
      status: "valid",
    });
    const tampered: OperatorComposition = {
      ...c,
      actions: c.actions.slice(1),
      sharedActions: [
        {
          canonicalActionId: "x",
          mergedActionId: "composed/x",
          sourceActions: ["a/x"],
          sourceOperators: ["a"],
        },
      ],
    };
    const v = validateOperatorComposition(tampered, ops, decompositions, ctx);
    expect(v.status).toBe("invalid");
    expect(v.problems).toContain(
      "actions differ from what the inputs compose to"
    );
    expect(v.problems).toContain("composed/x: shared action has one source");
    expect(v.problems.some((p) => p.includes("names an unknown action"))).toBe(
      true
    );
  });

  it("contains no scoring, selection, or source-edit vocabulary", () => {
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value !== null && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          keys.add(k);
          walk(v);
        }
      }
    };
    for (const composition of built) {
      walk(composition);
    }
    const forbidden =
      /^(apply|execute|write|patch|filesToMove|importEdits|score|priority|rank|effort|optimal|line|column|file|replacement|ast|edit|edits|selected|selection)$/i;
    expect([...keys].filter((key) => forbidden.test(key))).toEqual([]);
    for (const composition of built) {
      const text = renderOperatorComposition(composition);
      expect(text).toContain("OPERATOR COMPOSITION");
      expect(text).not.toMatch(/should |recommend|optimi[sz]/);
      expect(text).not.toMatch(/\.ts:\d+/);
    }
  });
});
