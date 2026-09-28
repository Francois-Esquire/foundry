import { describe, expect, it } from "vitest";
import {
  createMoveOperator,
  createOperatorContext,
  createPreserveBoundaryOperator,
  createRedirectDependencyOperator,
  createRehomeBehaviorOperator,
  createRehomeConceptOperator,
} from "../../src/lib/architectural-operator";
import {
  listOperatorDefinitions,
  listStructuralActionDefinitions,
} from "../../src/lib/operator-catalog";
import {
  decomposeArchitecturalOperator,
  validateOperatorDecomposition,
} from "../../src/lib/operator-decomposition";
import type { OperatorDecomposition } from "../../src/lib/operator-decomposition-types";
import { DECOMPOSITION_SCHEMA_VERSION } from "../../src/lib/operator-decomposition-types";
import type {
  ArchitecturalOperator,
  OperatorContext,
} from "../../src/lib/operator-types";
import {
  renderOperatorDecomposition,
  renderStructuralActionDefinitions,
} from "../../src/lib/report-decomposition";
import { analyzeWorkspace } from "../../src/lib/workspace-intelligence";
import { createWorkspaceProjectionContext } from "../../src/lib/workspace-projection";
import type { Spec } from "./helpers/workspace-builder";
import { workspace } from "./helpers/workspace-builder";

const expectedTextPattern = /\.ts:\d+/;
const expectedTextPattern2 = /should |recommend/;
const forbiddenPattern =
  /^(apply|execute|write|patch|filesToMove|importEdits|score|priority|rank|effort|line|column|file|replacement|ast|edit|edits)$/i;
const expectedTextPattern3 =
  /^operator:rehome-behavior:.*\/relocate-behavior-responsibility:.*@governing:@c\/app→@c\/core$/;

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
        participation: { "@c/store": { references: 2 } },
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
    edges: ["@c/app→@c/core:3", "@c/store→@c/core:2", "@c/app→@c/store:1"],
    packages: ["@c/core", "@c/store", "@c/app"],
    ...overrides,
  };
}

function context(s: Spec = spec()): OperatorContext {
  return createOperatorContext(
    createWorkspaceProjectionContext(analyzeWorkspace(workspace(s)))
  );
}

const built: {
  operator: ArchitecturalOperator;
  decomposition: OperatorDecomposition;
}[] = [];
function decompose(
  operator: ArchitecturalOperator,
  ctx: OperatorContext
): OperatorDecomposition {
  const decomposition = decomposeArchitecturalOperator(operator, ctx);
  built.push({ decomposition, operator });
  return decomposition;
}

function kinds(d: OperatorDecomposition): string[] {
  return d.actions.map((a) => a.kind);
}

function mentions(d: OperatorDecomposition, packageId: string): boolean {
  return d.actions.some(
    (a) =>
      JSON.stringify(a.subject).includes(packageId) ||
      a.current?.package === packageId ||
      a.target?.package === packageId
  );
}

describe("rehome-behavior decomposition", () => {
  it("relocates governing behavior, redirects its dependency, and leaves the semantic contract implicit", () => {
    const ctx = context();
    const op = createRehomeBehaviorOperator(ctx, {
      conceptId: A,
      from: ["@c/store"],
      to: "@c/core",
    });
    const d = decompose(op, ctx);
    expect(d.schemaVersion).toBe(DECOMPOSITION_SCHEMA_VERSION);
    expect(kinds(d)).toEqual([
      "relocate-behavior-responsibility",
      "redirect-concept-dependency",
    ]);
    const [relocate, redirect] = d.actions;
    expect(relocate?.subject).toEqual({
      conceptId: A,
      kind: "behavior",
      role: "governing",
    });
    expect(relocate?.current).toEqual({ package: "@c/store" });
    expect(relocate?.target).toEqual({ package: "@c/core" });
    expect(redirect?.subject).toEqual({
      conceptId: A,
      consumer: "@c/store",
      kind: "dependency",
      provider: "@c/core",
    });
    expect(d.dependencies).toEqual([
      {
        after: redirect?.id,
        before: relocate?.id,
        kind: "requires",
        reason: "the dependency follows the behavior",
      },
    ]);
    expect(d.preservationCoverage).toEqual([
      {
        coveredByActions: [],
        preservationId: "consumer-import-path:@c/app,@c/store",
        status: "implicit",
      },
      {
        coveredByActions: [],
        preservationId: "public-contract:@c/core",
        status: "implicit",
      },
      {
        coveredByActions: [],
        preservationId: "semantic-center:@c/core",
        status: "implicit",
      },
    ]);
    expect(d.effectCoverage).toEqual([
      {
        actions: [relocate?.id],
        operatorEffectId:
          'behavior:behavior-consolidation:["@c/store"]→["@c/core"]',
        status: "covered",
      },
    ]);
    expect(d.status).toBe("partial");
    expect(d.unresolved).toEqual([
      {
        blocking: false,
        detail:
          "the operator places into @c/core at package level; no module is selected",
        entities: ["@c/core"],
        kind: "target-module-unresolved",
      },
    ]);
    expect(validateOperatorDecomposition(d, op, ctx)).toMatchObject({
      currentFingerprint: d.fingerprint.hash,
      problems: [],
      status: "valid",
    });
  });

  it("never targets generic consumers", () => {
    const ctx = context();
    const op = createRehomeBehaviorOperator(ctx, {
      conceptId: A,
      from: ["@c/store"],
      to: "@c/core",
    });
    const d = decompose(op, ctx);
    expect(mentions(d, "@c/app")).toBe(false);
    expect(op.preservations.some((p) => p.entityIds.includes("@c/app"))).toBe(
      true
    );
  });

  it("carries the dependency to a target that is not the semantic center", () => {
    const ctx = context();
    const op = createRehomeBehaviorOperator(ctx, {
      conceptId: A,
      from: ["@c/store"],
      to: "@c/app",
    });
    const d = decompose(op, ctx);
    const redirect = d.actions.find(
      (a) => a.kind === "redirect-concept-dependency"
    );
    expect(redirect?.subject).toMatchObject({
      consumer: "@c/store",
      provider: "@c/core",
    });
    expect(redirect?.target).toEqual({ package: "@c/app" });
    expect(redirect?.intent.summary).toContain(
      "carried from @c/store to @c/app"
    );
  });

  it("removes boundary participation only for a certain elimination the operator states", () => {
    const ctx = context();
    const base = createRehomeBehaviorOperator(ctx, {
      conceptId: A,
      from: ["@c/store"],
      to: "@c/core",
    });
    const shared: ArchitecturalOperator = {
      ...base,
      expectedEffects: [
        ...base.expectedEffects,
        {
          certainty: "certain",
          change: "boundary-reduction",
          dimension: "boundary",
          evidenceRefs: [],
          from: "@c/store→@c/core",
        },
      ],
    };
    const dShared = decompose(shared, ctx);
    expect(kinds(dShared)).not.toContain("remove-boundary-participation");
    const redirect = dShared.actions.find(
      (a) => a.kind === "redirect-concept-dependency"
    );
    expect(redirect?.status).toBe("required");
    expect(redirect?.expectedEffects.map((e) => e.change)).toEqual([
      "boundary-reduction",
    ]);

    const exclusive: ArchitecturalOperator = {
      ...base,
      expectedEffects: [
        ...base.expectedEffects,
        {
          certainty: "certain",
          change: "boundary-elimination",
          dimension: "boundary",
          evidenceRefs: [],
          from: "@c/store→@c/core",
        },
      ],
    };
    const dExclusive = decompose(exclusive, ctx);
    const remove = dExclusive.actions.find(
      (a) => a.kind === "remove-boundary-participation"
    );
    expect(remove?.subject).toEqual({
      boundaryId: "@c/store→@c/core",
      conceptId: A,
      kind: "boundary",
    });
    expect(remove?.status).toBe("required");
    expect(dExclusive.dependencies).toContainEqual({
      after: remove?.id,
      before: redirect?.id,
      kind: "requires",
      reason: "participation ends only after the dependency has moved",
    });
    expect(
      dExclusive.effectCoverage.find((c) =>
        c.operatorEffectId.startsWith("boundary:boundary-elimination")
      )?.status
    ).toBe("covered");
    expect(
      validateOperatorDecomposition(dExclusive, exclusive, ctx).status
    ).toBe("valid");
  });

  it("keeps a representation boundary explicit when the operator preserves one", () => {
    const ctx = context();
    const base = createRehomeBehaviorOperator(ctx, {
      conceptId: A,
      from: ["@c/store"],
      to: "@c/core",
    });
    const op: ArchitecturalOperator = {
      ...base,
      preservations: [
        ...base.preservations,
        { entityIds: [B], kind: "representation-boundary" },
      ],
    };
    const d = decompose(op, ctx);
    const preserve = d.actions.find(
      (a) => a.kind === "preserve-representation-boundary"
    );
    expect(preserve?.subject).toEqual({ conceptId: A, kind: "concept" });
    expect(d.preservationCoverage).toContainEqual({
      coveredByActions: [preserve?.id],
      preservationId: `representation-boundary:${B}`,
      status: "covered",
    });
    expect(d.dependencies).toContainEqual(
      expect.objectContaining({
        before: preserve?.id,
        kind: "preserve-before-remove",
      })
    );
  });

  it("gives the same action ids whatever the input order", () => {
    const ctx = context();
    const one = decompose(
      createRehomeBehaviorOperator(ctx, {
        conceptId: A,
        from: ["@c/app", "@c/store"],
        to: "@c/core",
      }),
      ctx
    );
    const two = decompose(
      createRehomeBehaviorOperator(ctx, {
        conceptId: A,
        from: ["@c/store", "@c/app"],
        to: "@c/core",
      }),
      ctx
    );
    expect(two).toEqual(one);
    expect(one.actions.map((a) => a.id)).toHaveLength(4);
    expect(one.actions.map((a) => a.id)[0]).toMatch(expectedTextPattern3);
  });
});

describe("rehome-concept decomposition", () => {
  it("relocates the declaration, establishes exposure, redirects consumers, and keeps the old path when the operator says so", () => {
    const ctx = context();
    const op = createRehomeConceptOperator(ctx, {
      conceptId: A,
      to: "@c/store",
    });
    const d = decompose(op, ctx);
    expect(kinds(d)).toEqual([
      "preserve-implementation-split",
      "relocate-semantic-declaration",
      "establish-target-exposure",
      "preserve-public-exposure",
      "redirect-concept-dependency",
      "redirect-concept-dependency",
    ]);
    const id = (kind: string) => d.actions.find((a) => a.kind === kind)?.id;
    const inward = d.actions.find(
      (a) => a.subject.kind === "dependency" && a.subject.consumer === "@c/core"
    );
    expect(inward?.subject).toEqual({
      conceptId: A,
      consumer: "@c/core",
      kind: "dependency",
      provider: "@c/store",
    });
    expect(d.dependencies).toEqual([
      {
        after: id("preserve-public-exposure"),
        before: id("establish-target-exposure"),
        kind: "requires",
        reason:
          "the old exposure can only forward to a target that exposes the concept",
      },
      {
        after: id("redirect-concept-dependency"),
        before: id("establish-target-exposure"),
        kind: "requires",
        reason: "consumers can only depend on an exposed contract",
      },
      {
        after: inward?.id,
        before: id("establish-target-exposure"),
        kind: "requires",
        reason: "the old home can only depend on an exposed contract",
      },
      {
        after: id("relocate-semantic-declaration"),
        before: id("preserve-implementation-split"),
        kind: "preserve-before-remove",
        reason: "the invariant is fixed before the placement changes",
      },
      {
        after: id("establish-target-exposure"),
        before: id("relocate-semantic-declaration"),
        kind: "requires",
        reason: "the target exposes what it now declares",
      },
    ]);
    expect(d.preservationCoverage).toContainEqual({
      coveredByActions: [id("preserve-public-exposure")],
      preservationId: "consumer-import-path:@c/app,@c/store",
      status: "covered",
    });
    const redirect = d.actions.find(
      (a) => a.kind === "redirect-concept-dependency"
    );
    expect(redirect?.subject).toMatchObject({ consumer: "@c/app" });
    expect(redirect?.status).toBe("conditional");
    expect(d.unresolved.map((g) => g.kind)).toEqual([
      "target-module-unresolved",
    ]);
    expect(d.groups.map((g) => [g.kind, g.actionIds.length])).toEqual([
      ["preservation", 1],
      ["placement", 1],
      ["surface", 2],
      ["dependency", 2],
    ]);
    expect(validateOperatorDecomposition(d, op, ctx).status).toBe("valid");
  });

  it("leaves the surface transition unresolved when no strategy is stated", () => {
    const ctx = context();
    const base = createRehomeConceptOperator(ctx, {
      conceptId: A,
      to: "@c/store",
    });
    const op: ArchitecturalOperator = {
      ...base,
      preservations: base.preservations.filter(
        (p) => p.kind !== "consumer-import-path"
      ),
    };
    const d = decompose(op, ctx);
    expect(kinds(d)).not.toContain("preserve-public-exposure");
    expect(kinds(d)).not.toContain("internalize-old-exposure");
    expect(d.unresolved).toContainEqual({
      blocking: false,
      detail:
        "@c/app import packages/core/src/a.ts#A from @c/core; the operator does not say whether the old path stays, forwards, or breaks",
      entities: ["@c/core"],
      kind: "surface-transition-unspecified",
    });
    expect(d.status).toBe("partial");
    expect(validateOperatorDecomposition(d, op, ctx).status).toBe("valid");
  });

  it("is blocked, with the anchor preserved explicitly, when the operator is blocked", () => {
    const ctx = context(spec({ anchored: ["@c/core"] }));
    const op = createRehomeConceptOperator(ctx, {
      conceptId: A,
      to: "@c/store",
    });
    expect(op.status).toBe("blocked");
    const d = decompose(op, ctx);
    expect(d.status).toBe("blocked");
    const anchor = d.actions.find((a) => a.kind === "preserve-anchor-boundary");
    expect(anchor?.subject).toEqual({ kind: "package", packageId: "@c/core" });
    expect(anchor?.status).toBe("required");
    for (const action of d.actions) {
      if (action.intent.group !== "preservation") {
        expect(action.status).toBe("blocked");
      }
    }
    expect(d.dependencies).toContainEqual({
      after: d.actions.find((a) => a.kind === "relocate-semantic-declaration")
        ?.id,
      before: anchor?.id,
      kind: "preserve-before-remove",
      reason: "anchor holds",
    });
  });

  it("marks members unresolved when structural conformance is unknown", () => {
    const ctx = context();
    const op = createRehomeBehaviorOperator(ctx, {
      conceptId: IFACE,
      from: ["@c/store"],
      to: "@c/core",
    });
    const d = decompose(op, ctx);
    expect(d.unresolved).toContainEqual(
      expect.objectContaining({
        blocking: false,
        entities: [IFACE],
        kind: "structural-conformance-unknown",
      })
    );
    expect(d.unresolved).toContainEqual(
      expect.objectContaining({
        blocking: true,
        entities: [IFACE],
        kind: "behavior-members-unresolved",
      })
    );
    expect(d.status).toBe("partial");
  });

  it("marks members unresolved under partial workspace coverage", () => {
    const ctx = context(
      spec({
        edges: [
          "@c/app→@c/core:3",
          "@c/store→@c/core:2",
          "@c/app→@c/store:1",
          "@c/ext→@c/core:1",
        ],
        missing: ["@c/ext"],
        packages: ["@c/core", "@c/store", "@c/app", "@c/ext"],
      })
    );
    expect(ctx.projection.workspace.ingestion.coverage.complete).toBe(false);
    const op = createRehomeBehaviorOperator(ctx, {
      conceptId: A,
      from: ["@c/store"],
      to: "@c/core",
    });
    const d = decompose(op, ctx);
    const gap = d.unresolved.find(
      (g) => g.kind === "behavior-members-unresolved"
    );
    expect(gap).toMatchObject({ blocking: false, entities: [A] });
    expect(gap?.detail).toContain("unanalyzed");
    expect(d.status).toBe("partial");
    expect(d.fingerprint.facts).toContain("coverage:complete=false");
  });
});

describe("redirect-dependency, preserve-boundary, move", () => {
  it("redirects the whole boundary without claiming the old edge disappears", () => {
    const ctx = context();
    const op = createRedirectDependencyOperator(ctx, {
      consumer: "@c/app",
      from: "@c/core",
      to: "@c/store",
    });
    const d = decompose(op, ctx);
    expect(kinds(d)).toEqual([
      "establish-target-exposure",
      "redirect-concept-dependency",
    ]);
    expect(kinds(d)).not.toContain("remove-boundary-participation");
    const [, redirect] = d.actions;
    expect(redirect?.subject).toEqual({
      consumer: "@c/app",
      kind: "dependency",
      provider: "@c/core",
    });
    expect(redirect?.expectedEffects.map((e) => e.change)).toEqual([
      "boundary-redirect",
      "dependency-redirect",
    ]);
    expect(d.unresolved).toEqual([
      expect.objectContaining({
        blocking: false,
        entities: ["@c/app→@c/core"],
        kind: "dependency-target-unresolved",
      }),
    ]);
    expect(
      d.verificationCoverage.find((c) => c.requirementId === "anchor-preserved")
    ).toEqual({
      relatedActions: [redirect?.id],
      requirementId: "anchor-preserved",
      status: "covered",
    });
    expect(validateOperatorDecomposition(d, op, ctx).status).toBe("valid");
  });

  it("decomposes preserve-boundary into one explicit non-change and is complete", () => {
    const ctx = context(spec({ anchored: ["@c/core"] }));
    const op = createPreserveBoundaryOperator(ctx, {
      packageId: "@c/core",
      reason: "core stays",
    });
    const d = decompose(op, ctx);
    expect(kinds(d)).toEqual(["preserve-anchor-boundary"]);
    expect(d.status).toBe("complete");
    expect(d.dependencies).toEqual([]);
    expect(d.preservationCoverage.every((c) => c.status === "covered")).toBe(
      true
    );
    expect(d.verificationCoverage.every((c) => c.status === "covered")).toBe(
      true
    );
    expect(validateOperatorDecomposition(d, op, ctx).status).toBe("valid");
  });

  it("does not decompose move", () => {
    const ctx = context();
    const op = createMoveOperator(ctx, {
      subject: { conceptId: A, kind: "concept" },
      to: "@c/store",
    });
    const d = decompose(op, ctx);
    expect(d.status).toBe("unsupported");
    expect(d.actions).toEqual([]);
    expect(d.unresolved[0]).toMatchObject({
      blocking: true,
      entities: ["move"],
      kind: "unsupported-action-kind",
    });
    expect(validateOperatorDecomposition(d, op, ctx).status).toBe("valid");
  });
});

describe("decomposition validation", () => {
  function rehome(): {
    op: ArchitecturalOperator;
    d: OperatorDecomposition;
    ctx: OperatorContext;
  } {
    const ctx = context();
    const op = createRehomeConceptOperator(ctx, {
      conceptId: A,
      to: "@c/store",
    });
    return { ctx, d: decompose(op, ctx), op };
  }

  it("rejects cycles", () => {
    const { op, d, ctx } = rehome();
    const [a, b] = d.actions;
    const cyclic: OperatorDecomposition = {
      ...d,
      dependencies: [
        ...d.dependencies,
        {
          after: a?.id ?? "",
          before: b?.id ?? "",
          kind: "requires",
          reason: "x",
        },
      ],
    };
    const v = validateOperatorDecomposition(cyclic, op, ctx);
    expect(v.status).toBe("invalid");
    expect(v.cycles).toHaveLength(1);
    expect(v.cycles[0]).toContain(a?.id);
    expect(v.cycles[0]).toContain(b?.id);
  });

  it("reports an uncovered preservation when the surface action is missing", () => {
    const { op, d, ctx } = rehome();
    const stripped: OperatorDecomposition = {
      ...d,
      actions: d.actions.filter((a) => a.kind !== "preserve-public-exposure"),
    };
    const v = validateOperatorDecomposition(stripped, op, ctx);
    expect(v.status).toBe("invalid");
    expect(v.problems).toContain(
      "preservation consumer-import-path:@c/app,@c/store is not covered"
    );
    expect(
      v.preservationCoverage.find(
        (c) => c.preservationId === "consumer-import-path:@c/app,@c/store"
      )?.status
    ).toBe("uncovered");
  });

  it("reports an expected effect no action carries", () => {
    const { op, d, ctx } = rehome();
    const stripped: OperatorDecomposition = {
      ...d,
      actions: d.actions.map((a) => ({ ...a, expectedEffects: [] })),
    };
    const v = validateOperatorDecomposition(stripped, op, ctx);
    expect(v.status).toBe("invalid");
    expect(v.problems).toContain(
      'expected effect ownership:semantic-center-change:"@c/core"→"@c/store" has no action'
    );
  });

  it("keeps every verification requirement associated", () => {
    const ctx = context();
    for (const op of [
      createRehomeConceptOperator(ctx, { conceptId: A, to: "@c/store" }),
      createRehomeBehaviorOperator(ctx, {
        conceptId: A,
        from: ["@c/store"],
        to: "@c/core",
      }),
      createRedirectDependencyOperator(ctx, {
        consumer: "@c/app",
        from: "@c/core",
        to: "@c/store",
      }),
      createPreserveBoundaryOperator(ctx, {
        packageId: "@c/core",
        reason: "r",
      }),
    ]) {
      const d = decompose(op, ctx);
      expect(d.verificationCoverage.map((c) => c.requirementId)).toEqual(
        op.verification.map((v) => v.kind)
      );
      expect(d.verificationCoverage.every((c) => c.status === "covered")).toBe(
        true
      );
    }
  });

  it("rejects a required action missing and an illegal action kind", () => {
    const { op, d, ctx } = rehome();
    const broken: OperatorDecomposition = {
      ...d,
      actions: d.actions
        .filter((a) => a.kind !== "relocate-semantic-declaration")
        .map((a) =>
          a.kind === "establish-target-exposure"
            ? { ...a, kind: "rename-file" as never }
            : a
        ),
    };
    const v = validateOperatorDecomposition(broken, op, ctx);
    expect(v.status).toBe("invalid");
    expect(v.problems).toContain(
      "rehome-concept requires a relocate-semantic-declaration action"
    );
    expect(
      v.problems.some((p) => p.includes("unknown action kind rename-file"))
    ).toBe(true);
  });

  it("is stale when the operator fingerprint moved and refuses to decompose a stale operator", () => {
    const { op, d, ctx } = rehome();
    const moved: ArchitecturalOperator = {
      ...op,
      fingerprint: { facts: op.fingerprint.facts, hash: "0000000000000000" },
    };
    const v = validateOperatorDecomposition(d, moved, ctx);
    expect(v.status).toBe("stale");
    expect(v.problems[0]).toContain("operator fingerprint moved");

    const later = context(
      spec({
        concepts: spec().concepts.map((c) =>
          c.id === A ? { ...c, package: "@c/store" } : c
        ),
      })
    );
    const fresh = decomposeArchitecturalOperator(op, later);
    expect(fresh.status).toBe("stale");
    expect(fresh.actions).toEqual([]);
  });

  it("round-trips through JSON", () => {
    const { d } = rehome();
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });
});

describe("catalog and vocabulary", () => {
  it("declares decomposition support per operator kind and keeps actions non-executable", () => {
    expect(
      listOperatorDefinitions().map((d) => [d.kind, d.decomposition])
    ).toEqual([
      ["internalize", "supported"],
      ["move", "unsupported"],
      ["rehome-concept", "partial"],
      ["rehome-behavior", "partial"],
      ["redirect-dependency", "partial"],
      ["preserve-boundary", "supported"],
    ]);
    const actions = listStructuralActionDefinitions();
    expect(actions).toHaveLength(10);
    expect(JSON.stringify(actions)).not.toContain('"executable":true');
    expect(renderStructuralActionDefinitions(actions)).toContain(
      "relocate-behavior-responsibility"
    );
  });

  it("contains no execution, source-location, or scoring fields", () => {
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
    for (const { decomposition } of built) {
      walk(decomposition);
    }
    const forbidden = forbiddenPattern;
    expect([...keys].filter((key) => forbidden.test(key))).toEqual([]);
    for (const { operator, decomposition } of built) {
      const text = renderOperatorDecomposition(operator, decomposition);
      expect(text).not.toMatch(expectedTextPattern2);
      expect(text).not.toMatch(expectedTextPattern);
    }
  });
});
