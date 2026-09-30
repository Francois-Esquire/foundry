import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzePackageLocal } from "../../src/lib/package-local";
import { storePackage } from "../../src/lib/semantics-cache";
import { packageLocalFingerprint } from "../../src/lib/semantics-fingerprint";
import type { SemanticsManifestPackage } from "../../src/lib/semantics-types";
import {
  compositionGroups,
  familyScenario,
  scenarioReview,
} from "../../src/web/architecture";
import { districtLayout, planDistricts } from "../../src/web/district-layout";
import { bindInternals, scopeFileIds } from "../../src/web/internals";
import { responsibilityFocus } from "../../src/web/responsibility-focus";
import { scenarioRoutes } from "../../src/web/scenario-routes";
import type { Territory } from "../../src/web/types";
import { UnmappedModuleInspection } from "../../src/web/ui/unmapped-module-inspection";
import { loadInternals } from "../helpers/reference-internals";

let root: string;
const pkg: SemanticsManifestPackage = {
  id: "@test/p",
  modules: { count: 5 },
  name: "@test/p",
  path: "packages/p",
  root: "packages",
  status: "complete",
};
const source = {
  "src/editor/index.ts":
    'import { value } from "../shared/value"; export const editor = value;',
  "src/editor/view/index.ts":
    'import { value } from "../../shared/value"; export const view = value;',
  "src/editor/view/view.test.ts":
    'import { view } from "../../src/web/index"; console.log(view);',
  "src/editorial/index.ts": "export const unrelated = 2;",
  "src/shared/value.ts": "export const value = 1;",
};
const files = Object.keys(source).map((path) => ({
  id: `file:${path}`,
  path: `${pkg.path}/${path}`,
  x: 10,
  y: 20,
}));
const write = (path: string, contents: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), contents);
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "atlas-internals-"));
  write(
    "package.json",
    JSON.stringify({ name: "root", workspaces: ["packages/*"] })
  );
  write(
    `${pkg.path}/package.json`,
    JSON.stringify({ exports: { ".": "./src/editor/index.ts" }, name: pkg.id })
  );
  for (const [path, text] of Object.entries(source)) {
    write(`${pkg.path}/${path}`, text);
  }
});
afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

describe("atlas package internals", () => {
  it("resolves reused scenario IDs within their own review families", () => {
    const result = loadInternals(root, pkg, files, "survey-1", true);
    if (result.status !== "available") {
      throw new Error(result.reason);
    }
    const { architecture } = result.internals;
    const scenario = architecture?.rewiring.scenarios[0];
    if (!(architecture && scenario)) {
      throw new Error("Missing scenario fixture");
    }
    const review = scenarioReview(architecture, scenario);
    if (!review) {
      throw new Error("Missing scenario review fixture");
    }
    const other = {
      ...scenario,
      subject: { ...scenario.subject, key: "other-family" },
    };
    const otherReview = {
      ...review,
      familyId: "other-family",
      status: "uncertain" as const,
    };
    const duplicateIds = {
      ...architecture,
      review: { ...architecture.review, scenarios: [review, otherReview] },
      rewiring: { ...architecture.rewiring, scenarios: [scenario, other] },
    };
    expect(familyScenario(duplicateIds, "other-family", scenario.id)).toBe(
      other
    );
    expect(scenarioReview(duplicateIds, other)).toBe(otherReview);
    expect(
      familyScenario(duplicateIds, "missing-family", scenario.id)
    ).toBeUndefined();
  });
  it("plans districts independently of coasts and membership-hashed region IDs", () => {
    const result = loadInternals(root, pkg, files, "survey-1", true);
    if (result.status !== "available") {
      throw new Error(result.reason);
    }
    const data = result.internals;
    const territory: Territory = {
      analyzed: true,
      coast: [
        [
          [
            [-50, -50],
            [50, -50],
            [50, 50],
            [-50, 50],
            [-50, -50],
          ],
        ],
      ],
      color: "#aaa",
      files: files.map((file) => ({
        ...file,
        directory: "src",
        incoming: 0,
        kind: "source",
        outgoing: 0,
      })),
      hills: [],
      id: pkg.id,
      label: "Test",
      neighborhoods: [],
      radius: 50,
      shallows: [],
      x: 0,
      y: 0,
    };
    const before = structuredClone({ data, territory });
    const plan = planDistricts(data, territory);
    expect(planDistricts(data, { ...territory, coast: [] })).toEqual(plan);
    expect(
      planDistricts(
        {
          ...data,
          responsibilities: {
            ...data.responsibilities,
            regions: data.responsibilities.regions.map((region) => ({
              ...region,
              id: `new:${region.id}`,
              modules: [...region.modules, "not-in-survey.ts"],
            })),
          },
        },
        territory
      )
    ).toEqual(plan);
    const drawing = districtLayout(data, territory);
    expect(drawing.territory.coast).toBe(territory.coast);
    expect(drawing.territory.files).toHaveLength(files.length);
    expect(
      drawing.territory.neighborhoods.flatMap((group) => group.members)
    ).not.toContain("file:src/editor/view/view.test.ts");
    expect({ data, territory }).toEqual(before);
  });
  it("keeps route baselines factual and scope-only targets distinct from files", () => {
    const result = loadInternals(root, pkg, files, "survey-1");
    if (result.status !== "available") {
      throw new Error(result.reason);
    }
    const data = result.internals;
    const [region] = data.responsibilities.regions;
    if (!region) {
      throw new Error("Missing fixture responsibility");
    }
    const before = structuredClone(data);
    const preview = scenarioRoutes(data, {
      proposed: {
        candidateModules: [],
        exactPath: "deferred",
        scope: "responsibility-surface",
        surface: {
          consumerModules: [
            "src/editor/index.ts",
            "src/editor/index.ts",
            "missing.ts",
          ],
          deepModules: ["src/shared/value.ts"],
          responsibility: region.id,
          symbolIds: [],
        },
      },
      subject: { key: "relationship", kind: "responsibility-relationship" },
    });
    expect(preview.proposed).toEqual([
      {
        source: { id: "file:src/editor/index.ts", kind: "file" },
        target: { id: region.id, kind: "responsibility" },
      },
    ]);
    expect(preview.unmapped).toBe(1);
    expect(preview.baseline).toEqual([
      {
        source: { id: "file:src/editor/index.ts", kind: "file" },
        target: { id: "file:src/shared/value.ts", kind: "file" },
      },
    ]);
    expect(data).toEqual(before);
    const redirect = scenarioRoutes(data, {
      proposed: {
        candidateModules: [],
        exactPath: "deferred",
        redirect: [
          {
            source: "src/editor/index.ts",
            symbolIds: [],
            target: "src/shared/value.ts",
          },
        ],
        scope: "direct-dependency",
      },
      subject: { key: "redirect", kind: "internal-dependency" },
    });
    expect(redirect.proposed).toEqual(preview.baseline);
  });
  it("loads complete V13 evidence only on request, preserving symbol identities and geography", () => {
    const before = structuredClone(files);
    const basic = loadInternals(root, pkg, files, "survey-1");
    if (basic.status !== "available") {
      throw new Error(basic.reason);
    }
    expect(basic.internals.architecture).toBeUndefined();
    const full = loadInternals(root, pkg, files, "survey-1", true);
    if (full.status !== "available") {
      throw new Error(full.reason);
    }
    const { architecture } = full.internals;
    if (!architecture) {
      throw new Error("Missing architecture evidence");
    }
    for (const report of [
      architecture.primitives,
      architecture.rewiring,
      architecture.review,
    ]) {
      expect(report.schemaVersion).toBe(1);
      expect(report.package.id).toBe(pkg.id);
    }
    for (const module of architecture.primitives.modules) {
      const groups = compositionGroups(
        architecture.primitives.symbols,
        module.module
      );
      expect(
        groups
          .flatMap((group) => group.symbols.map((symbol) => symbol.symbolId))
          .sort()
      ).toEqual(
        architecture.primitives.symbols
          .filter((symbol) => symbol.declaration.module === module.module)
          .map((symbol) => symbol.symbolId)
          .sort()
      );
      expect(
        compositionGroups(
          [...architecture.primitives.symbols].reverse(),
          module.module
        )
      ).toEqual(groups);
    }
    expect(files).toEqual(before);
    expect(full.internals.fileIds).toEqual(basic.internals.fileIds);
    const scenarioIds = new Set(
      architecture.rewiring.scenarios.map((item) => item.id)
    );
    for (const family of architecture.review.families) {
      for (const id of family.scenarios) {
        expect(scenarioIds.has(id)).toBe(true);
      }
      if (family.baseline) {
        expect(scenarioIds.has(family.baseline)).toBe(true);
      }
    }
  });
  it("keeps declaration and scenario evidence readable without mapped file identities", () => {
    const result = loadInternals(root, pkg, [], "survey-1", true);
    if (result.status !== "available") {
      throw new Error(result.reason);
    }
    const { architecture } = result.internals;
    if (!architecture) {
      throw new Error("Missing architecture");
    }
    expect(result.internals.fileIds).toEqual({});
    const module = architecture.rewiring.scenarios.find(
      (scenario) => scenario.subject.module
    )?.subject.module;
    if (!module) {
      throw new Error("Missing module scenarios");
    }
    const html = renderToStaticMarkup(
      createElement(UnmappedModuleInspection, {
        data: result.internals,
        module,
        onOverlay: () => undefined,
      })
    );
    expect(html).toContain("absent from the map survey");
    const scenarios = architecture.rewiring.scenarios.filter(
      (scenario) => scenario.subject.module === module
    );
    expect(scenarios.length).toBeGreaterThan(0);
    for (const scenario of scenarios) {
      expect(html).toContain(scenario.id);
    }
    for (const symbol of architecture.primitives.symbols.filter(
      (symbolEntry) => symbolEntry.declaration.module === module
    )) {
      expect(html).toContain(symbol.name);
    }
    expect(html).not.toContain('type="range"');
  });
  it("derives topology and locality without moving or rewriting atlas files", () => {
    const before = structuredClone(files);
    const result = loadInternals(root, pkg, files, "survey-1");
    expect(result.status).toBe("available");
    if (result.status !== "available") {
      throw new Error(result.reason);
    }
    expect(result.analysisSource).toBe("fresh");
    expect(result.surveyGeneratedAt).toBe("survey-1");
    expect(files).toEqual(before);
    const data = result.internals;
    expect(data.unmatchedFiles).toEqual([]);
    expect(data.unmatchedModules).toEqual([]);
    expect(
      scopeFileIds(data, {
        id: "directory:src/editor",
        kind: "directory",
        path: "src/editor",
      })
    ).toEqual([
      "file:src/editor/index.ts",
      "file:src/editor/view/index.ts",
      "file:src/editor/view/view.test.ts",
    ]);
    expect(
      scopeFileIds(data, {
        id: "region:shared",
        kind: "region",
        path: "shared",
      })
    ).toEqual(["file:src/shared/value.ts"]);
    expect(
      scopeFileIds(data, {
        id: "module:src/editorial/index.ts",
        kind: "module",
        path: "src/editorial/index.ts",
      })
    ).toEqual(["file:src/editorial/index.ts"]);
    expect(
      scopeFileIds(data, {
        id: "package:@test/p",
        kind: "package",
        path: pkg.id,
      })
    ).toHaveLength(files.length);
    expect(
      data.locality.symbols.find((s) => s.name === "value")?.consumerModules
    ).toEqual(["src/editor/index.ts", "src/editor/view/index.ts"]);
    expect(data.locality.limitations.length).toBeGreaterThan(0);
    expect(
      bindInternals(
        data.topology,
        data.locality,
        [...files].reverse(),
        data.responsibilities
      )
    ).toEqual(data);
  });

  it("retains unmatched survey files and new modules without inventing membership", () => {
    const result = loadInternals(
      root,
      pkg,
      [{ id: "old", path: "packages/p/src/removed.ts" }],
      "survey-1"
    );
    if (result.status !== "available") {
      throw new Error(result.reason);
    }
    expect(result.internals.fileIds).toEqual({});
    expect(result.internals.unmatchedFiles).toEqual(["old"]);
    expect(result.internals.unmatchedModules).toEqual(
      Object.keys(source).sort()
    );
  });

  it("keeps responsibility membership on source modules and maps selected relationships", () => {
    const result = loadInternals(root, pkg, files, "survey-1");
    if (result.status !== "available") {
      throw new Error(result.reason);
    }
    const data = result.internals;
    const report = data.responsibilities;
    const primary = data.topology.modules
      .filter((m) => m.primary)
      .map((m) => m.id)
      .sort();
    expect(
      [
        ...report.regions.flatMap((r) => r.modules),
        ...report.unresolved.map((m) => m.module),
      ].sort()
    ).toEqual(primary);
    expect(report.modules.some((m) => m.module.endsWith("view.test.ts"))).toBe(
      false
    );
    const [region, other] = report.regions;
    const [edge] = data.topology.edges;
    const sourceModule = region?.modules[0],
      targetModule = other?.modules[0];
    if (!(region && other && sourceModule && targetModule && edge)) {
      throw new Error("Missing fixture responsibilities");
    }
    const relationship = {
      concepts: [],
      dominantSymbols: [],
      from: region.id,
      importSites: 1,
      mediatedEdges: 0,
      moduleEdges: 1,
      pathRegions: { across: 1, within: 0 },
      sourceModules: [sourceModule],
      symbolFlow: 1,
      targetModules: [targetModule],
      to: other.id,
    };
    data.topology.edges = [
      { ...edge, primary: true, source: sourceModule, target: targetModule },
    ];
    const before = structuredClone(data);
    const focus = responsibilityFocus(data, {
      id: region.id,
      kind: "region",
      relationship,
    });
    expect(focus.members).toEqual(
      region.modules.map((id) => data.fileIds[id]).sort()
    );
    expect(focus.links.length).toBeGreaterThan(0);
    for (const moduleEdge of focus.links) {
      expect(focus.members).toContain(moduleEdge.source);
      expect(focus.related).toContain(moduleEdge.target);
    }
    expect(data).toEqual(before);
    expect(
      responsibilityFocus(data, { id: "missing", kind: "region" }).members
    ).toEqual([]);
  });

  it("leaves competing ownership unassigned and caps rendered dependency links", () => {
    const result = loadInternals(root, pkg, files, "survey-1");
    if (result.status !== "available") {
      throw new Error(result.reason);
    }
    const data = result.internals;
    const [region] = data.responsibilities.regions;
    if (!region) {
      throw new Error("Missing fixture responsibility");
    }
    const module = "src/shared/contested.ts";
    data.fileIds[module] = "contested";
    data.responsibilities.unresolved = [
      {
        candidates: [{ edges: 30, localizedSymbols: 30, region: region.id }],
        module,
        reason: "bridge",
        roles: ["bridge"],
      },
    ];
    const [edge] = data.topology.edges;
    if (!edge) {
      throw new Error("Missing fixture dependency");
    }
    data.topology.edges = Array.from({ length: 30 }, (_, i) => {
      const target = `src/editor/member-${i}.ts`;
      region.modules.push(target);
      data.fileIds[target] = `member-${i}`;
      return {
        ...edge,
        importSites: i + 1,
        primary: true,
        source: module,
        target,
      };
    });
    const focus = responsibilityFocus(data, { id: module, kind: "unresolved" });
    expect(focus.members).toEqual([]);
    expect(focus.unresolved).toEqual(["contested"]);
    expect(focus.links).toHaveLength(24);
    expect(focus.totalLinks).toBe(30);
    expect(focus.links[0]).toEqual({
      source: "contested",
      target: "member-29",
    });
    expect(focus.related).not.toContain("contested");
  });

  it("reuses only current cache input and recomputes after source changes", () => {
    const unit = {
      ...pkg,
      analyzable: true,
      manifestPath: `${pkg.path}/package.json`,
    };
    const fingerprint = packageLocalFingerprint(root, unit);
    storePackage(join(root, ".foundry/cache/semantics"), {
      analyzedAt: "2026-09-05T00:00:00Z",
      components: fingerprint.components,
      fingerprint: fingerprint.combined,
      id: pkg.id,
      kind: "package-local",
      path: pkg.path,
      value: analyzePackageLocal({ root, target: pkg.path }),
    });
    const cached = loadInternals(root, pkg, files, "survey-1");
    expect(cached.status === "available" && cached.analysisSource).toBe(
      "cache"
    );
    const metaPath =
      ".foundry/cache/semantics/packages/@test__p.local.meta.json";
    const meta = readFileSync(join(root, metaPath), "utf8");
    write(
      metaPath,
      JSON.stringify({
        ...(JSON.parse(meta) as Record<string, unknown>),
        reportSchemaVersion: -1,
      })
    );
    const outdated = loadInternals(root, pkg, files, "survey-1");
    expect(outdated.status === "available" && outdated.analysisSource).toBe(
      "fresh"
    );
    write(metaPath, meta);
    write(`${pkg.path}/src/new.ts`, "export const added = true;");
    const fresh = loadInternals(root, pkg, files, "survey-1");
    expect(fresh.status === "available" && fresh.analysisSource).toBe("fresh");
    if (fresh.status !== "available") {
      throw new Error(fresh.reason);
    }
    expect(fresh.internals.unmatchedModules).toContain("src/new.ts");
  });

  it("reports unavailable packages explicitly", () => {
    expect(
      loadInternals(root, { ...pkg, path: "packages/missing" }, [], "survey-1")
    ).toEqual({
      packageId: pkg.id,
      reason: "missing-package",
      status: "unavailable",
    });
  });

  it("does not attach a renamed package to an old survey identity", () => {
    write(
      `${pkg.path}/package.json`,
      JSON.stringify({ name: "@test/renamed" })
    );
    expect(loadInternals(root, pkg, files, "survey-1")).toEqual({
      packageId: pkg.id,
      reason: "package-changed",
      status: "unavailable",
    });
  });
});
