import * as path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import { analyzeDependencyGravity } from "../../src/lib/gravity";
import { renderGravity, renderReport } from "../../src/lib/report";
import type { SurfaceReport, WorkspaceModuleGraph } from "../../src/lib/types";

const mod = (pkg: string) => `packages/${pkg}/src/index.ts`;

function makeGraph(
  owners: Record<string, string>,
  edges: [string, string][]
): WorkspaceModuleGraph {
  return {
    edges: edges.map(([fromFile, toFile]) => ({ fromFile, toFile })),
    modules: Object.keys(owners).sort((a, b) => a.localeCompare(b)),
    owners,
  };
}

/** Single-module packages named after their short ids. */
function packageGraph(
  packages: string[],
  edges: [string, string][]
): WorkspaceModuleGraph {
  const owners = Object.fromEntries(
    packages.map((pkg) => [mod(pkg), `@g/${pkg}`])
  );
  return makeGraph(
    owners,
    edges.map(([from, to]): [string, string] => [mod(from), mod(to)])
  );
}

const boundaryOf = (pkg: string) => ({
  packageName: `@g/${pkg}`,
  relPath: `packages/${pkg}`,
});

describe("simple chain", () => {
  const graph = packageGraph(
    ["a", "b", "c"],
    [
      ["a", "b"],
      ["b", "c"],
    ]
  );

  it("measures the middle node in both directions", () => {
    const { target, population } = analyzeDependencyGravity(
      graph,
      boundaryOf("b")
    );
    expect(population.packages).toBe(3);
    expect(target.direct).toEqual({ fanIn: 1, fanOut: 1 });
    expect(target.transitive).toEqual({ dependencies: 1, dependents: 1 });
    expect(target.depth).toEqual({ downstream: 1, upstream: 1 });
    expect(target.reach).toEqual({ dependencies: 0.5, dependents: 0.5 });
    expect(target.cycle).toEqual({ member: false, size: 0 });
  });

  it("measures the chain head", () => {
    const { target } = analyzeDependencyGravity(graph, boundaryOf("a"));
    expect(target.direct).toEqual({ fanIn: 0, fanOut: 1 });
    expect(target.transitive).toEqual({ dependencies: 2, dependents: 0 });
    expect(target.depth).toEqual({ downstream: 0, upstream: 2 });
    expect(target.reach).toEqual({ dependencies: 1, dependents: 0 });
  });

  it("measures the chain tail", () => {
    const { target } = analyzeDependencyGravity(graph, boundaryOf("c"));
    expect(target.direct).toEqual({ fanIn: 1, fanOut: 0 });
    expect(target.transitive).toEqual({ dependencies: 0, dependents: 2 });
    expect(target.depth).toEqual({ downstream: 2, upstream: 0 });
  });
});

describe("fan-in hub", () => {
  it("counts every direct dependent, no dependencies", () => {
    const graph = packageGraph(
      ["a", "b", "c", "core"],
      [
        ["a", "core"],
        ["b", "core"],
        ["c", "core"],
      ]
    );
    const { target } = analyzeDependencyGravity(graph, boundaryOf("core"));
    expect(target.direct).toEqual({ fanIn: 3, fanOut: 0 });
    expect(target.transitive).toEqual({ dependencies: 0, dependents: 3 });
    expect(target.depth).toEqual({ downstream: 1, upstream: 0 });
    expect(target.reach).toEqual({ dependencies: 0, dependents: 1 });
  });
});

describe("integration node", () => {
  it("carries both incoming and outgoing pressure", () => {
    const graph = packageGraph(
      ["a", "b", "hub", "x", "y", "z"],
      [
        ["a", "hub"],
        ["b", "hub"],
        ["hub", "x"],
        ["hub", "y"],
        ["hub", "z"],
      ]
    );
    const { target } = analyzeDependencyGravity(graph, boundaryOf("hub"));
    expect(target.direct).toEqual({ fanIn: 2, fanOut: 3 });
    expect(target.transitive).toEqual({ dependencies: 3, dependents: 2 });
    expect(target.reach).toEqual({ dependencies: 0.6, dependents: 0.4 });
  });
});

describe("transitive reach", () => {
  it("counts each reachable node once through a diamond", () => {
    const graph = packageGraph(
      ["a", "b", "c", "d"],
      [
        ["a", "b"],
        ["a", "c"],
        ["b", "d"],
        ["c", "d"],
      ]
    );
    const top = analyzeDependencyGravity(graph, boundaryOf("a")).target;
    expect(top.transitive.dependencies).toBe(3);
    expect(top.depth.upstream).toBe(2);
    const bottom = analyzeDependencyGravity(graph, boundaryOf("d")).target;
    expect(bottom.direct.fanIn).toBe(2);
    expect(bottom.transitive.dependents).toBe(3);
    expect(bottom.depth.downstream).toBe(2);
  });
});

describe("cycles", () => {
  const graph = packageGraph(
    ["a", "b", "c", "d", "e"],
    [
      ["a", "b"],
      ["b", "c"],
      ["c", "a"],
      ["d", "a"],
      ["c", "e"],
    ]
  );

  it("keeps transitive counts finite inside the cycle", () => {
    const { target } = analyzeDependencyGravity(graph, boundaryOf("a"));
    expect(target.cycle).toEqual({ member: true, size: 3 });
    expect(target.direct).toEqual({ fanIn: 2, fanOut: 1 });
    expect(target.transitive).toEqual({ dependencies: 3, dependents: 3 });
    expect(target.reach).toEqual({ dependencies: 0.75, dependents: 0.75 });
  });

  it("collapses the cycle to one step for depth", () => {
    const inCycle = analyzeDependencyGravity(graph, boundaryOf("a")).target;
    expect(inCycle.depth).toEqual({ downstream: 1, upstream: 1 });
    const before = analyzeDependencyGravity(graph, boundaryOf("d")).target;
    expect(before.cycle).toEqual({ member: false, size: 0 });
    expect(before.depth.upstream).toBe(2);
    expect(before.transitive.dependencies).toBe(4);
    const after = analyzeDependencyGravity(graph, boundaryOf("e")).target;
    expect(after.depth.downstream).toBe(2);
    expect(after.transitive.dependents).toBe(4);
  });
});

describe("disconnected packages", () => {
  const graph = packageGraph(["a", "b", "z"], [["a", "b"]]);

  it("keeps disconnected packages in the reach denominator", () => {
    const { target, population } = analyzeDependencyGravity(
      graph,
      boundaryOf("a")
    );
    expect(population.packages).toBe(3);
    expect(target.reach.dependencies).toBe(0.5);
  });

  it("measures an isolated package as all zeros", () => {
    const { target } = analyzeDependencyGravity(graph, boundaryOf("z"));
    expect(target.direct).toEqual({ fanIn: 0, fanOut: 0 });
    expect(target.transitive).toEqual({ dependencies: 0, dependents: 0 });
    expect(target.reach).toEqual({ dependencies: 0, dependents: 0 });
  });

  it("excludes modules owned by no workspace package", () => {
    const withRoot = makeGraph(
      { ...Object.fromEntries([[mod("a"), "@g/a"]]), "scripts/x.ts": "<root>" },
      [["scripts/x.ts", mod("a")]]
    );
    const { target, population } = analyzeDependencyGravity(
      withRoot,
      boundaryOf("a")
    );
    expect(population).toEqual({ modules: 1, packages: 1 });
    expect(target.direct.fanIn).toBe(0);
  });
});

describe("module graph", () => {
  const m1 = "packages/m/src/index.ts";
  const m2 = "packages/m/src/util.ts";
  const graph = makeGraph({ [mod("a")]: "@g/a", [m1]: "@g/m", [m2]: "@g/m" }, [
    [mod("a"), m1],
    [m1, m2],
  ]);
  const report = analyzeDependencyGravity(graph, boundaryOf("m"));

  it("collapses internal edges out of the package level", () => {
    expect(report.target.direct).toEqual({ fanIn: 1, fanOut: 0 });
    expect(report.population).toEqual({ modules: 3, packages: 2 });
  });

  it("measures modules independently of the package collapse", () => {
    expect(report.modules.map((entry) => entry.node.id)).toEqual([m1, m2]);
    const [index, util] = report.modules;
    expect(index?.direct).toEqual({ fanIn: 1, fanOut: 1 });
    expect(util?.direct).toEqual({ fanIn: 1, fanOut: 0 });
    expect(util?.transitive.dependents).toBe(2);
    expect(util?.reach.dependents).toBe(1);
    expect(util?.depth.downstream).toBe(2);
  });
});

describe("boundary concentration", () => {
  it("reports exact counts and shares in both directions", () => {
    const t1 = "packages/t/src/index.ts";
    const t2 = "packages/t/src/extra.ts";
    const graph = makeGraph(
      {
        [mod("a")]: "@g/a",
        [mod("b")]: "@g/b",
        [mod("x")]: "@g/x",
        [t1]: "@g/t",
        [t2]: "@g/t",
      },
      [
        [mod("a"), t1],
        [mod("b"), t1],
        [mod("b"), t2],
        [t1, mod("x")],
      ]
    );
    const report = analyzeDependencyGravity(graph, boundaryOf("t"));
    expect(report.incomingConcentration).toEqual([
      { edges: 2, module: t1, share: 2 / 3 },
      { edges: 1, module: t2, share: 1 / 3 },
    ]);
    expect(report.outgoingConcentration).toEqual([
      { edges: 1, module: t1, share: 1 },
    ]);
  });
});

describe("fixture integration", () => {
  const root = path.join(import.meta.dirname, "fixtures", "deps");
  let shared: SurfaceReport;
  let ping: SurfaceReport;

  beforeAll(async () => {
    shared = await analyzeSurface({ root, target: "@deps/shared" });
    ping = await analyzeSurface({ root, target: "@deps/ping" });
  });

  it("measures a real fan-in hub package", () => {
    const { population, target } = shared.dependencyGravity;
    expect(population.packages).toBe(21);
    expect(target.direct).toEqual({ fanIn: 4, fanOut: 0 });
    expect(target.transitive).toEqual({ dependencies: 0, dependents: 4 });
    expect(target.depth).toEqual({ downstream: 2, upstream: 0 });
    expect(target.reach.dependents).toBe(4 / 20);
    expect(target.cycle).toEqual({ member: false, size: 0 });
  });

  it("concentrates all incoming edges on the single entry module", () => {
    expect(shared.dependencyGravity.incomingConcentration).toEqual([
      { edges: 4, module: "packages/shared/src/index.ts", share: 1 },
    ]);
    expect(shared.dependencyGravity.outgoingConcentration).toEqual([]);
  });

  it("detects a real package cycle without exploding counts", () => {
    const { target } = ping.dependencyGravity;
    expect(target.cycle).toEqual({ member: true, size: 2 });
    expect(target.direct).toEqual({ fanIn: 1, fanOut: 1 });
    expect(target.transitive).toEqual({ dependencies: 1, dependents: 1 });
    expect(target.depth).toEqual({ downstream: 0, upstream: 0 });
  });

  it("adds a compact section to the default report", () => {
    const rendered = renderReport(shared);
    expect(rendered).toContain("DEPENDENCY GRAVITY");
    expect(rendered).toContain("  fan-in 4 · fan-out 0 packages");
    expect(rendered).toContain("  transitive 4 dependents · 0 dependencies");
  });

  it("renders the focused gravity view", () => {
    const rendered = renderGravity(shared);
    expect(rendered).toContain("PACKAGE");
    expect(rendered).toContain("fan-in                   4 packages");
    expect(rendered).toContain("downstream depth         2");
    expect(rendered).toContain("dependent reach          20.0%");
    expect(rendered).toContain("cycle                    no");
    expect(rendered).toContain("21 internal packages");
    expect(rendered).toContain("MOST DEPENDED-ON MODULES");
    expect(rendered).toContain("INCOMING EDGE CONCENTRATION");
    expect(rendered).toContain("packages/shared/src/index.ts");
  });
});
