import { describe, expect, it } from "vitest";
import { resolveCodex } from "../../../src/web/codex/resolve";
import type { CodexSource } from "../../../src/web/codex/source";

const noConcepts = {
  behavior: [],
  conversion: [],
  declared: [],
  implementation: [],
  representation: [],
  usage: [],
};

const source: CodexSource = {
  dependencies: [
    {
      concepts: { total: 2 },
      dependency: { moduleEdges: 1 },
      from: "@foundry/ui",
      to: "@foundry/core",
    },
  ],
  history: {
    packages: [
      { checkpoints: ["old", "new", "failed"], id: "@foundry/former" },
      { checkpoints: ["old"], id: "@foundry/core" },
      { checkpoints: ["failed"], id: "@foundry/unfinished" },
      { checkpoints: ["old"], id: "@foundry/early" },
    ],
    snapshots: [
      { commit: "old", status: "complete", timestamp: "2026-01-01" },
      { commit: "new", status: "complete", timestamp: "2026-03-01" },
      { commit: "failed", status: "failed", timestamp: "2026-04-01" },
    ],
  },
  imports: [
    { source: "packages/core/src/b.test.ts", target: "packages/core/src/a.ts" },
    { source: "packages/ui/index.ts", target: "packages/core/src/a.ts" },
  ],
  manifests: [
    {
      declared: {
        dependencies: { "@foundry/core": "workspace:*", react: "^19" },
        devDependencies: { "@foundry/ui": "workspace:*" },
        peerDependencies: { "@foundry/core": "workspace:*" },
      },
      package: "@foundry/ui",
    },
    { declared: {}, package: "@foundry/core" },
  ],
  modules: [
    {
      fileKind: "source",
      id: "packages/core/src/a.ts",
      package: "@foundry/core",
      path: "packages/core/src/a.ts",
    },
    {
      fileKind: "test",
      id: "packages/core/src/b.test.ts",
      package: "@foundry/core",
      path: "packages/core/src/b.test.ts",
    },
    {
      id: "packages/ui/index.ts",
      package: "@foundry/ui",
      path: "packages/ui/index.ts",
    },
  ],
  packages: [
    { analyzed: true, id: "@foundry/ui", label: "ui", layer: 1 },
    { analyzed: false, id: "@foundry/core", label: "core", layer: null },
  ],
  participation: [
    {
      concepts: {
        ...noConcepts,
        declared: ["a#Thing"],
        usage: ["a#Thing", "c#Other"],
      },
      id: "packages/core/src/a.ts",
    },
  ],
  survey: { coverage: "partial", generatedAt: "2026-09-23T00:00:00.000Z" },
};

describe("resolveCodex", () => {
  const codex = resolveCodex(source);

  it("carries the survey time and coverage", () => {
    expect(codex.workspace).toEqual({
      coverage: "partial",
      surveyedAt: "2026-09-23T00:00:00.000Z",
    });
  });

  it("sizes packages by their modules and seats unknown layers at the foundation", () => {
    expect(codex.packages).toEqual([
      {
        analyzed: false,
        id: "@foundry/core",
        label: "core",
        layer: 0,
        size: 2,
      },
      { analyzed: true, id: "@foundry/ui", label: "ui", layer: 1, size: 1 },
    ]);
  });

  it("counts module dependents and dependencies across package lines", () => {
    const [a, test, index] = codex.modules;
    expect(a).toMatchObject({ dependencies: 0, dependents: 2 });
    expect(test).toMatchObject({ dependencies: 1, dependents: 0 });
    expect(index).toMatchObject({ dependencies: 1, dependents: 0 });
  });

  it("names module directory, kind and the concepts it takes part in", () => {
    expect(codex.modules[0]).toMatchObject({
      concepts: ["a#Thing", "c#Other"],
      directory: "packages/core/src",
      fileKind: "source",
    });
    expect(codex.modules[2]).toMatchObject({
      concepts: [],
      directory: "packages/ui",
      fileKind: "unknown",
    });
  });

  it("keeps imports and measured dependencies", () => {
    expect(codex.imports).toEqual(source.imports);
    expect(codex.dependencies).toEqual([
      {
        from: "@foundry/ui",
        sharedConcepts: 2,
        strength: 1,
        to: "@foundry/core",
      },
    ]);
  });

  it("keeps declared dependencies between current packages only", () => {
    expect(codex.declaredDependencies).toEqual([
      { from: "@foundry/ui", kind: "dependencies", to: "@foundry/core" },
      { from: "@foundry/ui", kind: "peerDependencies", to: "@foundry/core" },
    ]);
  });

  it("retires absent packages at their last complete checkpoint", () => {
    expect(codex.retiredPackages).toEqual([
      { id: "@foundry/early", label: "early", lastSeen: "2026-01-01" },
      { id: "@foundry/former", label: "former", lastSeen: "2026-03-01" },
    ]);
  });

  it("leaves retirement unknown without history", () => {
    expect(
      resolveCodex({ ...source, history: undefined }).retiredPackages
    ).toBeUndefined();
  });
});
