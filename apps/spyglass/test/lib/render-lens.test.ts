import { describe, expect, it } from "vitest";
import type {
  DomainPlacement,
  Domains,
} from "../../src/lib/lenses/domains-types";
import type { PackageSize } from "../../src/lib/lenses/package-sizes-types";
import { renderLens } from "../../src/lib/render";

const NO_FILES = {
  config: 0,
  other: 0,
  source: 0,
  story: 0,
  test: 0,
  unknown: 0,
};

function sized(id: string, layer: number | null, files: number): PackageSize {
  return {
    analyzed: layer !== null,
    id,
    layer,
    modules: { byKind: { ...NO_FILES, source: files }, total: files },
  };
}

describe("renderLens", () => {
  it("prints the package-sizes lens as text, largest package first", () => {
    const text = renderLens(
      "package-sizes",
      {
        packages: [
          sized("@s/a", 1, 2),
          sized("@s/b", 0, 3),
          sized("@s/c", null, 0),
        ],
      },
      { format: "text" }
    );
    expect(text).toBe(
      [
        "Package sizes",
        "═════════════",
        "Packages  3 (2 analyzed)",
        "Layers    2",
        "Files     5",
        "",
        "Files by package",
        "  @s/b  3",
        "    layer 0",
        "  @s/a  2",
        "    layer 1",
        "  @s/c  0",
        "    no layer",
      ].join("\n")
    );
  });

  it("lists five packages at compact density and counts the rest", () => {
    const packages = ["a", "b", "c", "d", "e", "f", "g"].map((name, index) =>
      sized(`@s/${name}`, 0, 10 - index)
    );
    const text = renderLens(
      "package-sizes",
      { packages },
      { density: "compact", format: "text" }
    );
    expect(text).toContain("@s/e   6");
    expect(text).not.toContain("@s/f");
    expect(text).toContain("2 more");
  });

  it("prints the file-roles lens: files by role, high fan-in by fan-in, and packages saved without internals", () => {
    const text = renderLens(
      "file-roles",
      {
        missing: ["@s/c"],
        packages: [
          {
            highFanInCutoff: 3,
            id: "@s/a",
            modules: [
              {
                fanIn: 4,
                highFanIn: true,
                module: "a/hub.ts",
                role: "junction",
              },
              { fanIn: 9, highFanIn: true, module: "a/types.ts" },
              { fanIn: 1, highFanIn: false, module: "a/x.ts", role: "mixed" },
            ],
          },
        ],
      },
      { format: "text" }
    );
    expect(text).toBe(
      [
        "File roles",
        "══════════",
        "Packages               1",
        "Files                  3",
        "Composition junctions  1",
        "Mixed scope            1",
        "Shared commons         0",
        "Unknown scope          0",
        "",
        "High fan-in",
        "  a/types.ts  9",
        "    @s/a · cutoff 3",
        "  a/hub.ts    4",
        "    @s/a · cutoff 3",
        "",
        "Saved without internals",
        "  @s/c",
      ].join("\n")
    );
  });

  it("leaves out the high fan-in list when no package has a high fan-in file", () => {
    const text = renderLens(
      "file-roles",
      {
        missing: [],
        packages: [
          {
            highFanInCutoff: 0,
            id: "@s/a",
            modules: [{ fanIn: 0, highFanIn: false, module: "a/x.ts" }],
          },
        ],
      },
      { format: "text" }
    );
    expect(text).not.toContain("High fan-in");
    expect(text).not.toContain("Saved without internals");
  });

  it("prints the responsibility-groups lens, the largest group first", () => {
    const group = (
      label: string,
      responsibilities: string[],
      anchorModule?: string
    ) => ({
      anchor: responsibilities[0] ?? "",
      ...(anchorModule !== undefined && { anchorModule }),
      anchorWeight: 1,
      id: `responsibility-group:${label}`,
      label,
      modules: [],
      responsibilities,
    });
    const text = renderLens(
      "responsibility-groups",
      {
        missing: ["@s/c"],
        packages: [
          {
            groups: [
              group("small", ["a", "b"], "a/small.ts"),
              group("large", ["c", "d", "e"]),
            ],
            id: "@s/a",
            independent: ["f"],
          },
        ],
      },
      { format: "text" }
    );
    expect(text).toBe(
      [
        "Responsibility groups",
        "═════════════════════",
        "Packages                      1",
        "Groups                        2",
        "Responsibilities in groups    5",
        "Independent responsibilities  1",
        "",
        "Responsibility groups",
        "  large  3",
        "    @s/a",
        "  small  2",
        "    @s/a · anchored on a/small.ts",
        "",
        "Saved without internals",
        "  @s/c",
      ].join("\n")
    );
  });

  it("prints the frequent-change lens: the gate, then the files with the most commits", () => {
    const text = renderLens(
      "frequent-change",
      {
        gate: { eligibleKinds: ["source"], minCommitPercentile: 0.9 },
        missing: ["@s/c"],
        packages: [
          {
            files: [
              {
                commitPercentile: 0.9,
                commits: 9,
                file: "a/x.ts",
                linesChanged: 90,
              },
              {
                commitPercentile: 0.97,
                commits: 14,
                file: "a/y.ts",
                linesChanged: 140,
              },
            ],
            history: {
              analyzedAt: "2026-10-01T00:00:00.000Z",
              historyComplete: true,
            },
            id: "@s/a",
          },
        ],
      },
      { format: "text" }
    );
    expect(text).toBe(
      [
        "Frequent change",
        "═══════════════",
        "Gate      source files at or above the 90.0% commit percentile",
        "Packages  1",
        "Files     2",
        "",
        "Frequently changed files",
        "  a/y.ts  14",
        "    @s/a · 97.0% commit percentile",
        "  a/x.ts   9",
        "    @s/a · 90.0% commit percentile",
        "",
        "Saved without churn",
        "  @s/c",
      ].join("\n")
    );
  });
  it("prints the placement lens: counts by level, then departures and spread places, the most used away first", () => {
    const none = { departs: 0, fits: 0, spread: 0, unconsumed: 0 };
    const text = renderLens(
      "placement",
      {
        missing: ["@s/d"],
        packages: [
          {
            counts: {
              file: { ...none, spread: 1, unconsumed: 1 },
              folder: none,
              package: { ...none, spread: 1 },
              symbol: { ...none, departs: 2, spread: 1 },
            },
            id: "@s/b",
            path: "packages/b",
            shapeSignals: [],
            unindexed: 0,
          },
        ],
        places: [
          {
            away: [
              { modules: ["apps/a/src/index.ts"], package: "@s/a" },
              { modules: ["tooling/c/src/index.ts"], package: "@s/c" },
            ],
            home: { modules: [] },
            label: "spread",
            level: "package",
            package: "@s/b",
            place: "packages/b",
            unindexed: 0,
          },
          {
            away: [{ modules: ["apps/a/src/index.ts"], package: "@s/a" }],
            home: { modules: [] },
            label: "departs",
            level: "symbol",
            package: "@s/b",
            place: "packages/b/src/shape.ts#area",
            toward: "@s/a",
            unindexed: 0,
          },
          {
            away: [
              {
                modules: ["tooling/c/src/a.ts", "tooling/c/src/b.ts"],
                package: "@s/c",
              },
            ],
            home: { modules: ["packages/b/src/x.ts"] },
            label: "departs",
            level: "file",
            package: "@s/b",
            place: "packages/b/src/shape.ts",
            toward: "@s/c",
            unindexed: 0,
          },
        ],
        policy: { dominantShare: 0.6 },
      },
      { format: "text" }
    );
    expect(text).toBe(
      [
        "Placement",
        "═════════",
        "Dominant share  60.0%",
        "Symbols         2 depart, 1 spread, 0 fit, 0 unconsumed",
        "Files           0 depart, 1 spread, 0 fit, 1 unconsumed",
        "Folders         0 depart, 0 spread, 0 fit, 0 unconsumed",
        "Packages        0 depart, 1 spread, 0 fit, 0 unconsumed",
        "",
        "Departures",
        "  packages/b/src/shape.ts       2",
        "    file · @s/b → @s/c · 1 at home",
        "  packages/b/src/shape.ts#area  1",
        "    symbol · @s/b → @s/a · 0 at home",
        "",
        "Spread",
        "  packages/b  2",
        "    package · @s/b · 2 packages away · 0 at home",
        "",
        "Saved without internals",
        "  @s/d",
      ].join("\n")
    );
  });
  it("prints the import-traffic lens: counts, then package pairs by the files importing", () => {
    const text = renderLens(
      "import-traffic",
      {
        pairs: [
          {
            consumerFiles: ["ui/a.ts"],
            from: "@s/ui",
            supplierFiles: ["core/x.ts", "core/y.ts"],
            to: "@s/core",
          },
          {
            consumerFiles: ["app/m.ts", "app/n.ts"],
            from: "@s/app",
            supplierFiles: ["core/x.ts"],
            to: "@s/core",
          },
        ],
      },
      { format: "text" }
    );
    expect(text).toBe(
      [
        "Import traffic",
        "══════════════",
        "Package pairs                         2",
        "Files importing from another package  3",
        "Files another package imports         2",
        "",
        "Pairs by importing files",
        "  @s/app → @s/core  2",
        "    2 files importing · 1 file imported",
        "  @s/ui → @s/core   1",
        "    1 file importing · 2 files imported",
      ].join("\n")
    );
  });

  it("prints the nesting lens: the tree's size, folders with the most files, then seams", () => {
    const text = renderLens(
      "nesting",
      {
        folders: [
          {
            fileCounts: { descendant: 4, direct: 0 },
            id: "packages",
            packageRoot: false,
          },
          {
            fileCounts: { descendant: 3, direct: 0 },
            id: "packages/a",
            package: "@w/a",
            packageRoot: true,
            parent: "packages",
            pathRegion: ".",
          },
          {
            fileCounts: { descendant: 3, direct: 2 },
            id: "packages/a/src",
            package: "@w/a",
            packageRoot: false,
            parent: "packages/a",
            pathRegion: ".",
          },
          {
            fileCounts: { descendant: 1, direct: 1 },
            id: "packages/a/src/util",
            package: "@w/a",
            packageRoot: false,
            parent: "packages/a/src",
            pathRegion: "util",
          },
          {
            fileCounts: { descendant: 1, direct: 1 },
            id: "packages/b",
            package: "@w/b",
            packageRoot: true,
            parent: "packages",
          },
        ],
        missing: ["@w/b"],
        pathRegions: [
          { files: 2, id: ".", package: "@w/a", primaryFiles: 1 },
          { files: 1, id: "util", package: "@w/a", primaryFiles: 1 },
        ],
        seams: [
          {
            from: "util",
            importSites: 3,
            moduleEdges: 2,
            package: "@w/a",
            symbolFlow: 1,
            to: ".",
          },
        ],
      },
      { format: "text" }
    );
    expect(text).toBe(
      [
        "Nesting",
        "═══════",
        "Folders       5 (2 package roots, 1 above every package)",
        "Deepest       3 below the top",
        "Path regions  2",
        "Seams         1",
        "",
        "Folders by files",
        "  packages/a/src       2",
        "    @w/a · 3 files below",
        "  packages/a/src/util  1",
        "    @w/a · 1 file below",
        "  packages/b           1",
        "    @w/b · 1 file below",
        "",
        "Seams by module edges",
        "  @w/a: util → .  2",
        "    3 import sites · 1 symbol",
        "",
        "Saved without internals",
        "  @w/b",
      ].join("\n")
    );
  });
  it("prints the proximity lens: counts, then folders of unrelated groups, files apart, and co-changes apart", () => {
    const text = renderLens(
      "proximity",
      {
        apart: {
          coChanges: [
            {
              coChangeCommits: 3,
              distance: 5,
              id: "packages/a/src/x/a.ts|packages/b/src/z.ts",
              jaccard: 0.5,
              left: "packages/a/src/x/a.ts",
              right: "packages/b/src/z.ts",
              scope: "cross-package",
              staticPath: "none",
            },
            {
              coChangeCommits: 4,
              distance: 2,
              id: "packages/a/src/x/a.ts|packages/a/src/y/b.ts",
              jaccard: 0.4,
              left: "packages/a/src/x/a.ts",
              right: "packages/a/src/y/b.ts",
              scope: "same-package",
              staticPath: "direct",
            },
          ],
          files: [
            {
              distance: 2,
              file: "packages/a/src/y/e.ts",
              folder: "packages/a/src/y",
              package: "@w/a",
              responsibility: "R1",
              responsibilityFolder: "packages/a/src/x",
            },
          ],
        },
        close: [
          {
            folder: "packages/a/src/x",
            groups: [
              {
                apart: [],
                files: ["packages/a/src/x/a.ts", "packages/a/src/x/c.ts"],
                responsibilities: ["R1", "R3"],
              },
              {
                apart: [],
                files: ["packages/a/src/x/b.ts"],
                responsibilities: ["R2"],
              },
            ],
            package: "@w/a",
            unresolved: 1,
          },
        ],
        missing: ["@w/c"],
        packages: [{ id: "@w/a", unresolved: 1 }],
      },
      { format: "text" }
    );
    expect(text).toBe(
      [
        "Proximity",
        "═════════",
        "Close, unrelated  1 folder of unrelated groups",
        "Files apart       1 away from their responsibility's folder",
        "Co-changes apart  2 across folders, 1 with no import path",
        "Unresolved        1 file in no responsibility",
        "",
        "Folders of unrelated groups",
        "  packages/a/src/x  2",
        "    @w/a · 3 files · 1 unresolved",
        "",
        "Files away from their responsibility, by folder steps",
        "  packages/a/src/y/e.ts  2",
        "    @w/a · its responsibility in packages/a/src/x",
        "",
        "Changing together, apart, by folder steps",
        "  packages/a/src/x/a.ts  5",
        "    with packages/b/src/z.ts",
        "    3 commits together · no import path",
        "  packages/a/src/x/a.ts  2",
        "    with packages/a/src/y/b.ts",
        "    4 commits together · import path direct",
        "",
        "Saved without internals",
        "  @w/c",
      ].join("\n")
    );
  });

  it("prints the domains lens: counts, the declared domains, places by domain label, then unmatched facets", () => {
    const placed: Pick<
      DomainPlacement,
      "domains" | "level" | "package" | "placementLabel"
    > = {
      domains: ["billing", "finances"],
      level: "symbol",
      package: "@s/core",
      placementLabel: "departs",
    };
    const domains: Domains = {
      domains: [
        {
          name: "billing",
          parents: ["finances"],
          places: [{ kind: "package", place: "packages/billing" }],
          unmatched: ["packages/billing/src/legacy"],
          weight: 0.8,
        },
        {
          name: "finances",
          parents: [],
          places: [],
          reason: "Money moves through one model.",
          unmatched: [],
        },
      ],
      placements: [
        {
          ...placed,
          away: { shared: 1, total: 1, unindexed: 0 },
          domainLabel: "shares-domain",
          place: "packages/core/src/ids.ts#Id",
          sharedDomains: ["billing", "finances"],
        },
        {
          ...placed,
          away: { shared: 0, total: 2, unindexed: 0 },
          domainLabel: "departs",
          place: "packages/core/src/ids.ts#Key",
          sharedDomains: [],
        },
        {
          ...placed,
          away: { shared: 1, total: 1, unindexed: 0 },
          domainLabel: "fits",
          level: "package",
          place: "packages/billing",
          placementLabel: "fits",
          sharedDomains: ["finances"],
        },
      ],
    };
    expect(renderLens("domains", domains, { format: "text" })).toBe(
      [
        "Domains",
        "═══════",
        "Domains             2",
        "Facets              1 matched, 1 unmatched",
        "Places in a domain  1 share a domain, 1 depart, 0 spread, 1 fit",
        "",
        "Declared domains",
        "  billing   1",
        "    in finances · weight 0.8 · 1 unmatched",
        "  finances  0",
        "    Money moves through one model.",
        "",
        "Shares a domain",
        "  packages/core/src/ids.ts#Id  1",
        "    symbol · @s/core · placement departs · 1 of 1 away share billing, finances",
        "",
        "Domain departures",
        "  packages/core/src/ids.ts#Key  2",
        "    symbol · @s/core · placement departs · none of 2 away shares its domains",
        "",
        "Unmatched facets",
        "  billing: packages/billing/src/legacy",
      ].join("\n")
    );
  });

  it("says so when no domain is declared", () => {
    expect(
      renderLens("domains", { domains: [], placements: [] }, { format: "text" })
    ).toBe(["Domains", "═══════", "No domains declared."].join("\n"));
  });

  it("prints the rules lens: counts, each broken rule's places, why a plan is blocked, then what was not checked", () => {
    const text = renderLens(
      "rules",
      {
        missing: [{ package: "@s/checkout", rule: 1 }],
        rules: [
          {
            effect: "require",
            operator: "internalize",
            subject: "packages/core",
          },
          { effect: "require", operator: "internalize", subject: "apps" },
          {
            effect: "permit",
            operator: "internalize",
            subject: "packages/next",
          },
        ],
        unmatched: [2],
        violations: [
          {
            opportunity: "internalize-symbol:packages/core/src/ids.ts#UserId",
            package: "@s/core",
            place: "packages/core/src/ids.ts#UserId",
            plan: {
              blockers: ["publishable"],
              id: "plan:internalize-symbol:packages/core/src/ids.ts#UserId",
              status: "blocked",
            },
            rule: 0,
          },
        ],
      },
      { format: "text" }
    );
    expect(text).toBe(
      [
        "Rules",
        "═════",
        "Rules        3 (2 require, 1 permit)",
        "Violations   1",
        "Unmatched    1",
        "Not checked  1",
        "",
        "Breaks rules[0] require internalize packages/core",
        "  packages/core/src/ids.ts#UserId · @s/core · plan blocked: publishable",
        "┌─ Why a plan is blocked ───────────────────────────────────────────┐",
        '│ publishable: the package is marked "private": false, so consumers │',
        "│ outside this repository are invisible.                            │",
        "└───────────────────────────────────────────────────────────────────┘",
        "",
        "Unmatched rules",
        "  rules[2] permit internalize packages/next: names no place in the dataset",
        "",
        "Not checked",
        "  rules[1] require internalize apps: @s/checkout failed analysis, so the rule was not checked there",
      ].join("\n")
    );
    expect(
      renderLens(
        "rules",
        { missing: [], rules: [], unmatched: [], violations: [] },
        { format: "text" }
      )
    ).toBe(
      "Rules\n═════\nNo rules declared. Declare them under rules in .foundry/spyglass/."
    );
  });
});
