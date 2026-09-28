import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import { renderBoundaries, renderReport } from "../../src/lib/report";
import type { BoundaryInteraction, SurfaceReport } from "../../src/lib/types";

const traffic = join(import.meta.dirname, "fixtures", "traffic");
const deps = join(import.meta.dirname, "fixtures", "deps");

function boundaryFrom(
  report: SurfaceReport,
  from: string
): BoundaryInteraction {
  const found = report.boundaryInteractions.incoming.find(
    (boundary) => boundary.from === from
  );
  if (found === undefined) {
    throw new Error(`no incoming boundary from ${from}`);
  }
  return found;
}

function modules(
  contributions: BoundaryInteraction["sourceModules"]
): [string, number, number, number][] {
  return contributions.map((contribution) => [
    contribution.module,
    contribution.importSites,
    contribution.moduleEdges,
    contribution.share,
  ]);
}

describe("incoming boundaries", () => {
  let hub: SurfaceReport;

  beforeAll(async () => {
    hub = await analyzeSurface({ root: traffic, target: "@traffic/hub" });
  });

  it("counts a mixed boundary exactly", () => {
    const mixed = boundaryFrom(hub, "@traffic/mixed");
    expect(mixed.to).toBe("@traffic/hub");
    expect(mixed.moduleEdges).toBe(3);
    expect(mixed.importSites).toBe(5);
    expect(mixed.symbols).toEqual({
      distinct: 4,
      packagePublic: 4,
      references: 7,
      referencesPerSymbol: 1.75,
    });
    expect(mixed.surfaceCoverage).toBe(0.4);
  });

  it("classifies usage per symbol and per boundary", () => {
    expect(boundaryFrom(hub, "@traffic/mixed").usage).toEqual({
      bothSymbols: 1,
      namespace: "both",
      typeOnlySymbols: 1,
      valueOnlySymbols: 2,
    });
    expect(boundaryFrom(hub, "@traffic/typed").usage).toEqual({
      bothSymbols: 0,
      namespace: "type",
      typeOnlySymbols: 2,
      valueOnlySymbols: 0,
    });
    expect(boundaryFrom(hub, "@traffic/runtime").usage).toEqual({
      bothSymbols: 0,
      namespace: "value",
      typeOnlySymbols: 0,
      valueOnlySymbols: 1,
    });
  });

  it("attributes source concentration to consumer modules by import sites", () => {
    const mixed = boundaryFrom(hub, "@traffic/mixed");
    expect(modules(mixed.sourceModules)).toEqual([
      ["packages/mixed/src/a.ts", 2, 1, 0.4],
      ["packages/mixed/src/b.ts", 2, 1, 0.4],
      ["packages/mixed/src/c.ts", 1, 1, 0.2],
    ]);
    expect(mixed.sourceModules[0]?.references).toBe(3);
    expect(mixed.concentration.sourceModuleShare).toBe(0.4);
  });

  it("attributes destination concentration to declaring modules, not the barrel", () => {
    const mixed = boundaryFrom(hub, "@traffic/mixed");
    expect(modules(mixed.destinationModules)).toEqual([
      ["packages/hub/src/core.ts", 4, 0, 0.8],
      ["packages/hub/src/other.ts", 1, 0, 0.2],
      ["packages/hub/src/index.ts", 0, 3, 0],
    ]);
    expect(mixed.destinationModules[0]?.symbols).toBe(3);
    expect(mixed.concentration.destinationModuleShare).toBe(0.8);
    expect(mixed.breadth).toEqual({ destinationModules: 2, sourceModules: 3 });
  });

  it("keeps each consumer's coverage independent", () => {
    expect(boundaryFrom(hub, "@traffic/typed").surfaceCoverage).toBe(0.2);
    expect(boundaryFrom(hub, "@traffic/overlap").surfaceCoverage).toBe(0.2);
    expect(boundaryFrom(hub, "@traffic/runtime").surfaceCoverage).toBe(0.1);
  });

  it("unions symbols in the summary instead of summing consumers", () => {
    const { summary, outgoing } = hub.boundaryInteractions;
    expect(summary.incoming).toEqual({
      importSites: 10,
      moduleEdges: 6,
      packages: 4,
      references: 12,
      symbols: 7,
    });
    expect(summary.outgoing).toEqual({
      importSites: 0,
      moduleEdges: 0,
      packages: 0,
      references: null,
      symbols: 0,
    });
    expect(summary.throughPaths).toBe(0);
    expect(outgoing).toEqual([]);
  });

  it("renders the compact block and the focused view", () => {
    expect(renderReport(hub)).toContain(
      "  incoming  4 packages · 6 module edges · 10 import sites · 7 symbols · 12 references"
    );
    const focused = renderBoundaries(hub);
    expect(focused).toContain("@traffic/mixed → @traffic/hub");
    expect(focused).toContain(
      "surface coverage   40.0% · 4 package-public consumed"
    );
    expect(focused).toContain("HIGHEST REFERENCE VOLUME");
    expect(focused).toContain("MOST CONCENTRATED DESTINATION");
    expect(focused).toContain("packages/hub/src/core.ts");
  });
});

describe("edge-only and empty boundaries", () => {
  it("returns null coverage on a package with no public surface", async () => {
    const empty = await analyzeSurface({
      root: traffic,
      target: "@traffic/empty",
    });
    const runtime = boundaryFrom(empty, "@traffic/runtime");
    expect(runtime.moduleEdges).toBe(1);
    expect(runtime.importSites).toBe(0);
    expect(runtime.symbols).toEqual({
      distinct: 0,
      packagePublic: 0,
      references: 0,
      referencesPerSymbol: null,
    });
    expect(runtime.surfaceCoverage).toBeNull();
    expect(runtime.concentration).toEqual({
      destinationModuleShare: 0,
      sourceModuleShare: 0,
    });
    expect(runtime.breadth).toEqual({
      destinationModules: 0,
      sourceModules: 0,
    });
  });
});

describe("outgoing boundaries", () => {
  it("agrees with the destination's incoming measurement", async () => {
    const mixed = await analyzeSurface({
      root: traffic,
      target: "@traffic/mixed",
    });
    const [toHub] = mixed.boundaryInteractions.outgoing;
    expect(toHub?.from).toBe("@traffic/mixed");
    expect(toHub?.to).toBe("@traffic/hub");
    expect(toHub?.moduleEdges).toBe(3);
    expect(toHub?.importSites).toBe(5);
    expect(toHub?.symbols).toEqual({
      distinct: 4,
      packagePublic: null,
      references: null,
      referencesPerSymbol: null,
    });
    expect(toHub?.surfaceCoverage).toBeNull();
    expect(toHub?.usage).toEqual({
      bothSymbols: 0,
      namespace: "both",
      typeOnlySymbols: 1,
      valueOnlySymbols: 3,
    });
    expect(modules(toHub?.destinationModules ?? [])).toEqual([
      ["packages/hub/src/core.ts", 4, 0, 0.8],
      ["packages/hub/src/other.ts", 1, 0, 0.2],
      ["packages/hub/src/index.ts", 0, 3, 0],
    ]);
    expect(mixed.boundaryInteractions.summary.outgoing).toEqual({
      importSites: 5,
      moduleEdges: 3,
      packages: 1,
      references: null,
      symbols: 4,
    });
    expect(renderBoundaries(mixed)).toContain(
      "references         not measured"
    );
  });
});

describe("cycles", () => {
  it("stays finite when the target is in a package cycle", async () => {
    const ping = await analyzeSurface({ root: deps, target: "@deps/ping" });
    const { incoming, outgoing, summary } = ping.boundaryInteractions;
    expect(incoming.map((boundary) => boundary.from)).toEqual(["@deps/pong"]);
    expect(outgoing.map((boundary) => boundary.to)).toEqual(["@deps/pong"]);
    expect(summary.throughPaths).toBe(0);
    expect(summary.incoming.importSites).toBe(1);
    expect(summary.outgoing.importSites).toBe(1);
  });
});
